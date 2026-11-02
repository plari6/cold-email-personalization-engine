const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const toInt = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const toNonNegInt = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const config = {
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-flash-lite-latest',
  inputFile: process.env.INPUT_FILE || 'prospects.csv',
  outputFile: process.env.OUTPUT_FILE || 'enriched_prospects.csv',
  concurrency: toInt(process.env.CONCURRENCY, 3),
  geminiRpm: toNonNegInt(process.env.GEMINI_RPM, 14), // free tier allows 15/min per model; 0 = no limit
  geminiTimeoutMs: Math.max(10000, toInt(process.env.GEMINI_TIMEOUT_MS, 60000)), // API minimum is 10s
  fetchTimeoutMs: toInt(process.env.FETCH_TIMEOUT_MS, 12000),
  maxWords: toInt(process.env.MAX_WORDS, 45),
  cacheFile: process.env.CACHE_FILE || 'data/cache.json',
  senderOffer: process.env.SENDER_OFFER || '',
};

module.exports = { config, toInt };
