#!/usr/bin/env node
const { config } = require('./config');
const { runPipeline } = require('./engine');
const { createClient } = require('./icebreaker');

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { green: paint(32), yellow: paint(33), red: paint(31), dim: paint(2), bold: paint(1), cyan: paint(36) };

const HELP = `
Cold Email Personalization Engine
Reads prospect websites and writes a 2-sentence personalized icebreaker for each row.

Usage: npm start -- [options]

Options:
  -i, --input <file>        Input CSV (default: ${config.inputFile})
  -o, --output <file>       Output CSV (default: ${config.outputFile})
  -n, --limit <n>           Only process the first n rows
  -c, --concurrency <n>     Rows processed in parallel (default: ${config.concurrency})
      --model <name>        Gemini model (default: ${config.geminiModel})
      --rpm <n>             Max Gemini requests per minute, 0 = no limit (default: ${config.geminiRpm})
      --max-words <n>       Word limit per icebreaker (default: ${config.maxWords})
      --separator <char>    Output CSV separator, e.g. ";" for Excel on comma-decimal locales (default: ",")
      --no-ai               Template icebreakers only, no API key needed
      --no-website          Don't fetch websites, use company_description only
      --no-cache            Ignore and don't update data/cache.json
      --no-xlsx             Don't write the Excel copy
  -h, --help                Show this help
`;

function parseArgs(argv) {
  const opts = {};
  const need = (i, flag) => {
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  const positiveInt = (value, flag) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive whole number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h': case '--help': opts.help = true; break;
      case '-i': case '--input': opts.input = need(i++, arg); break;
      case '-o': case '--output': opts.output = need(i++, arg); break;
      case '-n': case '--limit': opts.limit = positiveInt(need(i++, arg), arg); break;
      case '-c': case '--concurrency': opts.concurrency = Math.min(positiveInt(need(i++, arg), arg), 20); break;
      case '--model': opts.model = need(i++, arg); break;
      case '--rpm': {
        const n = Number(need(i++, arg));
        if (!Number.isInteger(n) || n < 0) throw new Error('--rpm must be 0 or a positive whole number');
        opts.rpm = n;
        break;
      }
      case '--max-words': opts.maxWords = positiveInt(need(i++, arg), arg); break;
      case '--separator': {
        const sep = need(i++, arg);
        if (sep.length !== 1) throw new Error('--separator must be a single character');
        opts.separator = sep;
        break;
      }
      case '--no-ai': opts.useAi = false; break;
      case '--no-website': opts.readWebsite = false; break;
      case '--no-cache': opts.useCache = false; break;
      case '--no-xlsx': opts.xlsx = false; break;
      default:
        throw new Error(`Unknown option: ${arg} (see --help)`);
    }
  }
  return opts;
}

const STATUS_LABEL = {
  ok: () => c.green('Done!'),
  needs_review: () => c.yellow('Done (needs review)'),
  template: () => c.green('Done!'),
  fallback: () => c.yellow('Gemini failed, used template'),
  skipped: () => c.dim('Skipped'),
};

function logRow({ index, total, row, meta }) {
  const status = row.icebreaker_status;
  const extra = [meta.cached ? 'cached' : row.icebreaker_source, `${(meta.ms / 1000).toFixed(1)}s`].filter(Boolean);
  console.log(`Processing row ${index} of ${total}: ${c.bold(meta.company)}... ${STATUS_LABEL[status]()} ${c.dim(`(${extra.join(', ')})`)}`);
  if (meta.icebreaker) console.log(`   ${c.cyan('→')} ${meta.icebreaker}`);
  if (meta.note) console.log(`   ${c.dim(meta.note)}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return console.log(HELP);

  const useAi = opts.useAi !== false;
  if (useAi) opts.client = createClient(); // fails fast when GEMINI_API_KEY is missing

  console.log(c.bold('\nCold Email Personalization Engine'));
  const rpm = opts.rpm ?? config.geminiRpm;
  const settings = [
    `Input: ${opts.input || config.inputFile} → ${opts.output || config.outputFile}`,
    useAi ? `model: ${opts.model || config.geminiModel}` : 'template mode (no AI)',
    `websites: ${opts.readWebsite === false ? 'off' : 'on'}`,
    useAi && `rate limit: ${rpm ? `${rpm}/min` : 'off'}`,
  ].filter(Boolean);
  console.log(c.dim(`${settings.join(' | ')}\n`));

  const started = Date.now();
  const result = await runPipeline({ ...opts, onRow: logRow, onNotice: (msg) => console.log(c.yellow(`   ${msg}`)) });

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const parts = [
    c.green(`${result.ok + result.template} ready`),
    result.needs_review && c.yellow(`${result.needs_review} need review`),
    result.fallback && c.yellow(`${result.fallback} fell back to template`),
    result.skipped && c.dim(`${result.skipped} skipped`),
    result.cached && c.dim(`${result.cached} from cache`),
  ].filter(Boolean);
  console.log(`\n${c.bold(`Finished ${result.total} rows in ${secs}s:`)} ${parts.join(', ')}`);
  console.log(`CSV:   ${result.outputFile}`);
  if (result.xlsxFile) console.log(`Excel: ${result.xlsxFile}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(c.red(`\nError: ${err.message}`));
    process.exitCode = 1;
  });
}

module.exports = { parseArgs };
