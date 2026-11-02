const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Tiny JSON cache so re-running the same list doesn't pay for Gemini twice.
 * Keyed by a hash of everything that changes the answer (model, prospect fields, word limit).
 */
function createCache(file, { enabled = true } = {}) {
  let entries = {};
  if (enabled && file && fs.existsSync(file)) {
    try {
      entries = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      entries = {}; // corrupt cache: start fresh
    }
  }

  const save = () => {
    if (!enabled || !file) return;
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 1));
    fs.renameSync(tmp, file);
  };

  return {
    key: (parts) => crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex'),
    get: (key) => (enabled ? entries[key] : undefined),
    set(key, value) {
      if (!enabled) return;
      entries[key] = { ...value, cachedAt: new Date().toISOString() };
      save();
    },
    get size() {
      return Object.keys(entries).length;
    },
  };
}

module.exports = { createCache };
