const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Shared requests-per-minute limiter (sliding 60s window) for all parallel rows.
 * `pauseFor(ms)` makes every caller wait, e.g. after Gemini returns a 429 with a retry delay.
 * Returns null when rpm is 0 (no limit).
 */
function createRateLimiter(rpm, { now = Date.now, sleep = defaultSleep, onWait = () => {} } = {}) {
  if (!rpm) return null;
  const stamps = [];
  let pausedUntil = 0;
  let queue = Promise.resolve();

  const nextSlot = async () => {
    for (;;) {
      const t = now();
      while (stamps.length && t - stamps[0] >= 60000) stamps.shift();
      const wait = Math.max(pausedUntil - t, stamps.length >= rpm ? stamps[0] + 60000 - t : 0);
      if (wait <= 0) {
        stamps.push(t);
        return;
      }
      onWait(wait);
      await sleep(wait);
    }
  };

  return {
    rpm,
    /** Resolves when the caller may send one request. Calls are served in order. */
    acquire() {
      queue = queue.then(nextSlot);
      return queue;
    },
    pauseFor(ms) {
      pausedUntil = Math.max(pausedUntil, now() + ms);
    },
  };
}

module.exports = { createRateLimiter };
