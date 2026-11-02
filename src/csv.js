const fs = require('fs');
const csvParser = require('csv-parser');

/** Column aliases, so "First Name", "Company", "Website" etc. all work. */
const ALIASES = {
  first_name: ['first_name', 'firstname', 'first', 'name', 'contact_first_name'],
  company_name: ['company_name', 'company', 'companyname', 'organization', 'account_name'],
  website_url: ['website_url', 'website', 'url', 'domain', 'company_website', 'site'],
  company_description: ['company_description', 'description', 'about', 'company_about', 'summary'],
};

const OUTPUT_COLUMNS = ['personalized_icebreaker', 'personalization_hook', 'icebreaker_source', 'icebreaker_status'];

const normalizeKey = (key) =>
  String(key || '')
    .replace(/^﻿/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

/** Returns the canonical fields of a raw CSV row, whatever its header spelling. */
function canonicalRow(raw) {
  const byKey = {};
  for (const [key, value] of Object.entries(raw)) byKey[normalizeKey(key)] = String(value ?? '').trim();
  const out = {};
  for (const [field, aliases] of Object.entries(ALIASES)) {
    const hit = aliases.find((a) => byKey[a]);
    out[field] = hit ? byKey[hit] : '';
  }
  return out;
}

/** Detects ";" CSVs (Excel on comma-decimal locales) from the header line. */
function detectSeparator(headerLine) {
  const commas = (headerLine.match(/,/g) || []).length;
  const semis = (headerLine.match(/;/g) || []).length;
  return semis > commas ? ';' : ',';
}

function readHeaderLine(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8', 0, n).split(/\r?\n/)[0].replace(/^﻿/, '');
  } finally {
    fs.closeSync(fd);
  }
}

/** Streams rows from a CSV file. Keeps original headers (BOM stripped). */
function createRowStream(file) {
  if (!fs.existsSync(file)) throw new Error(`Input file not found: ${file}`);
  const separator = detectSeparator(readHeaderLine(file));
  return fs
    .createReadStream(file)
    .pipe(csvParser({ separator, mapHeaders: ({ header }) => header.replace(/^﻿/, '').trim() }));
}

/** Counts data rows (cheap streaming pass, used for "row 3 of 50" progress). */
async function countRows(file) {
  let n = 0;
  for await (const row of createRowStream(file)) if (!isBlank(row)) n++;
  return n;
}

const isBlank = (row) => Object.values(row).every((v) => !String(v ?? '').trim());

function escapeCell(value, separator = ',') {
  const s = value == null ? '' : String(value);
  return /["\r\n]/.test(s) || s.includes(separator) ? `"${s.replace(/"/g, '""')}"` : s;
}

const toCsvLine = (values, separator = ',') => values.map((v) => escapeCell(v, separator)).join(separator) + '\r\n';

/**
 * Opens an output CSV stream. The header is written on the first row so it can
 * include the original input columns plus the new icebreaker columns.
 */
function createCsvWriter(file, { separator = ',', bom = true } = {}) {
  const stream = fs.createWriteStream(file, { encoding: 'utf8' });
  if (bom) stream.write('﻿');
  let headers = null;
  return {
    write(row) {
      if (!headers) {
        headers = [...Object.keys(row).filter((k) => !OUTPUT_COLUMNS.includes(k)), ...OUTPUT_COLUMNS];
        stream.write(toCsvLine(headers, separator));
      }
      const ok = stream.write(toCsvLine(headers.map((h) => row[h]), separator));
      return ok ? Promise.resolve() : new Promise((resolve) => stream.once('drain', resolve));
    },
    close: () => new Promise((resolve, reject) => stream.end((err) => (err ? reject(err) : resolve()))),
    get headers() {
      return headers;
    },
  };
}

module.exports = {
  ALIASES,
  OUTPUT_COLUMNS,
  canonicalRow,
  countRows,
  createCsvWriter,
  createRowStream,
  detectSeparator,
  escapeCell,
  isBlank,
  normalizeKey,
  toCsvLine,
};
