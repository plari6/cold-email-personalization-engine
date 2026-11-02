const path = require('path');
const ExcelJS = require('exceljs');
const { config } = require('./config');
const { canonicalRow, countRows, createCsvWriter, createRowStream, isBlank, OUTPUT_COLUMNS } = require('./csv');
const { fetchWebsiteContext, normalizeUrl } = require('./website');
const { generateIcebreaker, templateIcebreaker } = require('./icebreaker');
const { createCache } = require('./cache');
const { createRateLimiter } = require('./ratelimit');

/** Logs rate-limit waits at most once per 20s so parallel rows don't spam the console. */
function throttledNotice(onNotice, rpm) {
  let last = 0;
  return (ms) => {
    if (ms < 2000 || Date.now() - last < 20000) return;
    last = Date.now();
    onNotice(`Pausing ${Math.ceil(ms / 1000)}s for the Gemini rate limit (${rpm} requests/min, set GEMINI_RPM or --rpm to change)`);
  };
}

/** Errors that will fail on every row (bad key, unknown model): stop the run instead of writing 500 fallbacks. */
const FATAL = /daily quota|api key|api_key|permission_denied|unauthenticated|\b(400|401|403|404)\b|not found|not supported/i;

/**
 * Personalizes one prospect.
 * @returns the original row plus the icebreaker columns, and a `meta` object for logging.
 */
async function processRow(raw, ctx) {
  const prospect = canonicalRow(raw);
  const started = Date.now();
  const result = (fields, meta = {}) => ({
    row: { ...raw, ...Object.fromEntries(OUTPUT_COLUMNS.map((c) => [c, ''])), ...fields },
    meta: { company: prospect.company_name || prospect.website_url || '(no name)', ms: Date.now() - started, ...meta },
  });

  if (!prospect.company_name && !prospect.website_url && !prospect.company_description) {
    return result({ icebreaker_status: 'skipped' }, { note: 'no company, website or description' });
  }

  const cacheKey = ctx.cache.key([ctx.useAi ? ctx.model : 'template', ctx.maxWords, prospect]);
  const cached = ctx.cache.get(cacheKey);
  if (cached) {
    return result(
      {
        personalized_icebreaker: cached.icebreaker,
        personalization_hook: cached.hook,
        icebreaker_source: cached.source,
        icebreaker_status: cached.status,
      },
      { cached: true, icebreaker: cached.icebreaker },
    );
  }

  const web = ctx.readWebsite && prospect.website_url
    ? await fetchWebsiteContext(prospect.website_url, { timeoutMs: ctx.fetchTimeoutMs, fetchImpl: ctx.fetchImpl })
    : { ok: false, error: ctx.readWebsite ? 'no website_url' : 'website reading off' };
  const website = web.ok ? web.context : null;
  const source = website ? 'website' : 'description';
  const notes = web.ok ? [] : [`site not read: ${web.error}`];

  // Nothing specific to work with: a model would only produce empty flattery.
  if (!website && !prospect.company_description) {
    const icebreaker = templateIcebreaker(prospect, null);
    notes.push('no website text or description to personalize from, write this one by hand');
    return result(
      { personalized_icebreaker: icebreaker, icebreaker_source: 'template', icebreaker_status: 'needs_review' },
      { icebreaker, note: notes.join('; ') },
    );
  }

  if (!ctx.useAi) {
    const icebreaker = templateIcebreaker(prospect, website);
    return result(
      { personalized_icebreaker: icebreaker, icebreaker_source: 'template', icebreaker_status: 'template' },
      { icebreaker, note: notes.join('; ') },
    );
  }

  try {
    const ai = await generateIcebreaker(prospect, website, {
      client: ctx.client,
      model: ctx.model,
      maxWords: ctx.maxWords,
      backoffMs: ctx.backoffMs,
      limiter: ctx.limiter,
      timeoutMs: ctx.geminiTimeoutMs,
    });
    ctx.cache.set(cacheKey, { icebreaker: ai.icebreaker, hook: ai.hook, source, status: ai.status });
    if (ai.problems.length) notes.push(`review: ${ai.problems.join(', ')}`);
    return result(
      {
        personalized_icebreaker: ai.icebreaker,
        personalization_hook: ai.hook,
        icebreaker_source: source,
        icebreaker_status: ai.status,
      },
      { icebreaker: ai.icebreaker, note: notes.join('; ') },
    );
  } catch (err) {
    if (FATAL.test(err.message)) throw err;
    const icebreaker = templateIcebreaker(prospect, website);
    notes.push(err.message);
    return result(
      { personalized_icebreaker: icebreaker, icebreaker_source: 'template', icebreaker_status: 'fallback' },
      { icebreaker, note: notes.join('; '), failed: true },
    );
  }
}

/** Writes an Excel copy: opens correctly on any locale, with clickable websites. */
async function writeXlsx(file, headers, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Prospects', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = headers.map((h) => ({
    header: h,
    key: h,
    width: h === 'personalized_icebreaker' ? 70 : /description|hook/.test(h) ? 40 : 20,
  }));
  for (const row of rows) {
    const added = ws.addRow(row);
    for (const h of headers) {
      if (/website|url|domain/i.test(h) && row[h]) {
        const url = normalizeUrl(row[h]);
        if (url) {
          added.getCell(h).value = { text: row[h], hyperlink: url };
          added.getCell(h).font = { color: { argb: 'FF0563C1' }, underline: true };
        }
      }
    }
    if (['needs_review', 'fallback'].includes(row.icebreaker_status)) {
      added.getCell('icebreaker_status').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
    }
  }
  ws.getRow(1).font = { bold: true };
  ws.getColumn('personalized_icebreaker').alignment = { wrapText: true, vertical: 'top' };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  await wb.xlsx.writeFile(file);
}

/**
 * Streams input CSV → icebreakers → output CSV, keeping row order while
 * processing `concurrency` rows at a time.
 */
async function runPipeline(options = {}) {
  const opts = {
    input: config.inputFile,
    output: config.outputFile,
    useAi: true,
    readWebsite: true,
    concurrency: config.concurrency,
    model: config.geminiModel,
    maxWords: config.maxWords,
    fetchTimeoutMs: config.fetchTimeoutMs,
    cacheFile: config.cacheFile,
    useCache: true,
    xlsx: true,
    separator: ',',
    limit: 0,
    rpm: config.geminiRpm,
    onRow: () => {},
    onNotice: () => {},
    ...options,
  };
  if (path.resolve(opts.input) === path.resolve(opts.output)) throw new Error('Output file must differ from the input file.');

  const ctx = {
    ...opts,
    cache: opts.cache || createCache(opts.cacheFile, { enabled: opts.useCache }),
    limiter:
      opts.limiter !== undefined
        ? opts.limiter
        : opts.useAi && createRateLimiter(opts.rpm, { onWait: throttledNotice(opts.onNotice, opts.rpm) }),
  };

  const counted = await countRows(opts.input);
  const total = opts.limit > 0 ? Math.min(opts.limit, counted) : counted;
  if (total === 0) throw new Error(`No data rows found in ${opts.input}`);

  const writer = createCsvWriter(opts.output, { separator: opts.separator });
  const written = [];
  const stats = { total, ok: 0, needs_review: 0, template: 0, fallback: 0, skipped: 0, cached: 0 };
  const done = new Map();
  let nextToWrite = 0;
  let index = 0;
  const inFlight = new Set();
  let fatal = null;

  const flush = async () => {
    while (done.has(nextToWrite)) {
      const { row, meta } = done.get(nextToWrite);
      done.delete(nextToWrite);
      await writer.write(row);
      written.push(row);
      stats[row.icebreaker_status] = (stats[row.icebreaker_status] || 0) + 1;
      if (meta.cached) stats.cached++;
      opts.onRow({ index: nextToWrite + 1, total, row, meta });
      nextToWrite++;
    }
  };

  try {
    for await (const raw of createRowStream(opts.input)) {
      if (isBlank(raw)) continue;
      if (index >= total || fatal) break;
      const i = index++;
      const task = processRow(raw, ctx)
        .then((res) => done.set(i, res))
        .catch((err) => {
          fatal = fatal || err;
        })
        .finally(() => inFlight.delete(task));
      inFlight.add(task);
      if (inFlight.size >= opts.concurrency) await Promise.race(inFlight);
      await flush();
    }
    await Promise.all(inFlight);
    await flush();
  } finally {
    await writer.close();
  }
  if (fatal) throw fatal;

  let xlsxFile = null;
  if (opts.xlsx && writer.headers) {
    xlsxFile = opts.output.replace(/\.csv$/i, '') + '.xlsx';
    await writeXlsx(xlsxFile, writer.headers, written);
  }
  return { ...stats, outputFile: opts.output, xlsxFile, rows: written };
}

module.exports = { runPipeline, processRow, writeXlsx, FATAL };
