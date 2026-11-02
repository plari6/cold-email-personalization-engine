const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { runPipeline } = require('../src/engine');
const { canonicalRow, detectSeparator, escapeCell, createRowStream } = require('../src/csv');
const { parseArgs } = require('../src/index');
const { fakeClient, tmpDir, startSite } = require('./helpers');

async function readCsv(file) {
  const rows = [];
  for await (const row of createRowStream(file)) rows.push(row);
  return rows;
}

const answer = (req) => {
  const company = /Company: (.*)/.exec(req.contents)[1];
  return { icebreaker: `Really like how ${company} keeps things simple.`, hook: company };
};

test('csv helpers: aliases, separators, escaping', () => {
  assert.deepStrictEqual(
    canonicalRow({ '﻿First Name': ' Ann ', Company: 'Acme', Website: 'acme.com', About: 'Rockets' }),
    { first_name: 'Ann', company_name: 'Acme', website_url: 'acme.com', company_description: 'Rockets' },
  );
  assert.strictEqual(detectSeparator('a;b;c'), ';');
  assert.strictEqual(detectSeparator('a,b,c'), ',');
  assert.strictEqual(escapeCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.strictEqual(escapeCell('a;b', ';'), '"a;b"');
  assert.strictEqual(escapeCell(null), '');
});

test('parseArgs reads flags and rejects bad values', () => {
  assert.deepStrictEqual(parseArgs(['-i', 'a.csv', '-n', '5', '--no-ai', '--separator', ';']), {
    input: 'a.csv',
    limit: 5,
    useAi: false,
    separator: ';',
  });
  assert.throws(() => parseArgs(['--limit', '0']), /positive/);
  assert.throws(() => parseArgs(['--limit']), /needs a value/);
  assert.throws(() => parseArgs(['--wat']), /Unknown option/);
  assert.strictEqual(parseArgs(['-c', '99']).concurrency, 20);
});

test('pipeline: reads sites, keeps order and original columns, writes CSV + XLSX', async (t) => {
  const { server, base } = await startSite();
  t.after(() => server.close());
  const dir = tmpDir();
  const input = path.join(dir, 'in.csv');
  const output = path.join(dir, 'out.csv');
  fs.writeFileSync(
    input,
    [
      'first_name,company_name,website_url,company_description,owner',
      `Sarah,Acme Rockets,${base}/,"Rockets, reusable",me`,
      `Tom,Broken Co,${base}/missing,"Makes ""quoted"" widgets",me`,
      ',,,,',
      'Lee,No Site Inc,,Line one text,you',
      ',,,,orphan',
    ].join('\n'),
  );

  const client = fakeClient([(req) => answer(req)]);
  const seen = [];
  const res = await runPipeline({
    input, output, client, model: 'test', concurrency: 3, useCache: false,
    onRow: ({ index, total, meta }) => seen.push(`${index}/${total} ${meta.company}`),
  });

  assert.deepStrictEqual(seen, ['1/4 Acme Rockets', '2/4 Broken Co', '3/4 No Site Inc', '4/4 (no name)']);
  assert.strictEqual(res.ok, 3);
  assert.strictEqual(res.skipped, 1);

  const rows = await readCsv(output);
  assert.strictEqual(rows.length, 4);
  assert.strictEqual(rows[0].owner, 'me');
  assert.strictEqual(rows[0].company_description, 'Rockets, reusable');
  assert.strictEqual(rows[1].company_description, 'Makes "quoted" widgets');
  assert.strictEqual(rows[0].personalized_icebreaker, 'Really like how Acme Rockets keeps things simple.');
  assert.deepStrictEqual(rows.map((r) => r.icebreaker_source), ['website', 'description', 'description', '']);
  assert.strictEqual(rows[3].icebreaker_status, 'skipped');
  const acmeCall = client.calls.find((call) => call.contents.includes('Company: Acme Rockets'));
  assert.match(acmeCall.contents, /40% less/); // website copy reached Gemini
  assert.ok(fs.readFileSync(output, 'utf8').startsWith('﻿'));

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(res.xlsxFile);
  const ws = wb.getWorksheet('Prospects');
  assert.strictEqual(ws.rowCount, 5);
  assert.strictEqual(ws.getRow(2).getCell(3).value.hyperlink, `${base}/`);
});

test('pipeline: --limit, template mode and semicolon output', async () => {
  const dir = tmpDir();
  const input = path.join(dir, 'in.csv');
  fs.writeFileSync(input, 'First Name;Company;Description\nA;Alpha;Fast payroll for shops\nB;Beta;Other\n');
  const output = path.join(dir, 'out.csv');
  const res = await runPipeline({ input, output, useAi: false, readWebsite: false, limit: 1, separator: ';', useCache: false, xlsx: false });
  assert.strictEqual(res.total, 1);
  assert.strictEqual(res.template, 1);
  const text = fs.readFileSync(output, 'utf8');
  assert.match(text, /First Name;Company;Description;personalized_icebreaker/);
  assert.match(text, /one-liner says it well: ""Fast payroll for shops.""/);
  assert.strictEqual(res.xlsxFile, null);
});

test('pipeline: cache makes the second run free', async () => {
  const dir = tmpDir();
  const input = path.join(dir, 'in.csv');
  fs.writeFileSync(input, 'company_name,company_description\nAlpha,Payroll\nBeta,Billing\n');
  const opts = { input, output: path.join(dir, 'out.csv'), readWebsite: false, cacheFile: path.join(dir, 'cache.json'), xlsx: false };

  const first = fakeClient([(req) => answer(req)]);
  await runPipeline({ ...opts, client: first });
  assert.strictEqual(first.calls.length, 2);

  const second = fakeClient([new Error('should not be called')]);
  const res = await runPipeline({ ...opts, client: second });
  assert.strictEqual(second.calls.length, 0);
  assert.strictEqual(res.cached, 2);
  assert.strictEqual((await readCsv(opts.output))[1].personalized_icebreaker, 'Really like how Beta keeps things simple.');
});

test('pipeline: transient Gemini errors fall back to template, fatal ones stop the run', async () => {
  const dir = tmpDir();
  const input = path.join(dir, 'in.csv');
  fs.writeFileSync(input, 'company_name,company_description\nAlpha,Payroll for shops\nBeta,Billing\n');
  const base = { input, output: path.join(dir, 'out.csv'), readWebsite: false, useCache: false, xlsx: false, backoffMs: 1 };

  const res = await runPipeline({ ...base, client: fakeClient([new Error('503 overloaded')]) });
  assert.strictEqual(res.fallback, 2);
  assert.match((await readCsv(base.output))[0].personalized_icebreaker, /Payroll for shops/);

  await assert.rejects(runPipeline({ ...base, client: fakeClient([new Error('API key not valid')]) }), /API key/);
  await assert.rejects(runPipeline({ ...base, output: input }), /must differ/);
  await assert.rejects(runPipeline({ ...base, input: path.join(dir, 'nope.csv') }), /not found/);
});

test('pipeline: rows with no website text and no description skip Gemini and need review', async () => {
  const dir = tmpDir();
  const input = path.join(dir, 'in.csv');
  fs.writeFileSync(input, 'company_name,website_url\nGhost,ftp://nope\n');
  const client = fakeClient([new Error('should not be called')]);
  const res = await runPipeline({ input, output: path.join(dir, 'out.csv'), client, useCache: false, xlsx: false });
  assert.strictEqual(client.calls.length, 0);
  assert.strictEqual(res.needs_review, 1);
  assert.match(res.rows[0].personalized_icebreaker, /Came across Ghost/);
});
