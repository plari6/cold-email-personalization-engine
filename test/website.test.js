const test = require('node:test');
const assert = require('node:assert');
const { extractWebsiteContext, fetchWebsiteContext, normalizeUrl } = require('../src/website');
const { startSite } = require('./helpers');

test('normalizeUrl adds https and rejects junk', () => {
  assert.strictEqual(normalizeUrl('acme.com'), 'https://acme.com/');
  assert.strictEqual(normalizeUrl(' http://acme.com/about '), 'http://acme.com/about');
  assert.strictEqual(normalizeUrl('ftp://acme.com'), null);
  assert.strictEqual(normalizeUrl('not a url'), null);
  assert.strictEqual(normalizeUrl(''), null);
});

test('extractWebsiteContext keeps title, meta, headings and copy, drops scripts and nav', () => {
  const ctx = extractWebsiteContext(`<title> Hi </title><meta property="og:description" content="OG desc">
    <nav><h2>Menu</h2></nav><h1>Big   idea</h1><h1>Big idea</h1><script>evil()</script>
    <p>short</p><p>This paragraph is long enough to be kept as real copy from the page.</p>`);
  assert.strictEqual(ctx.title, 'Hi');
  assert.strictEqual(ctx.metaDescription, 'OG desc');
  assert.deepStrictEqual(ctx.headings, ['Big idea']);
  assert.deepStrictEqual(ctx.paragraphs, ['This paragraph is long enough to be kept as real copy from the page.']);
});

test('fetchWebsiteContext reads a real page and reports failures without throwing', async (t) => {
  const { server, base } = await startSite();
  t.after(() => server.close());

  const ok = await fetchWebsiteContext(`${base}/`);
  assert.strictEqual(ok.ok, true);
  assert.match(ok.context.metaDescription, /40% less/);
  assert.ok(ok.context.headings.includes('Launch smarter'));

  assert.deepStrictEqual(await fetchWebsiteContext(`${base}/missing`), { ok: false, error: 'HTTP 404' });
  assert.match((await fetchWebsiteContext(`${base}/empty`)).error, /no readable text/);
  assert.match((await fetchWebsiteContext(`${base}/json`)).error, /not an HTML page/);
  assert.match((await fetchWebsiteContext(`${base}/slow`, { timeoutMs: 200 })).error, /timed out/);
  assert.match((await fetchWebsiteContext('')).error, /invalid/);
  assert.strictEqual((await fetchWebsiteContext('http://127.0.0.1:1/')).ok, false);
});
