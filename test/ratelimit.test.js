const test = require('node:test');
const assert = require('node:assert');
const { createRateLimiter } = require('../src/ratelimit');
const { generateIcebreaker, errorInfo, templateIcebreaker } = require('../src/icebreaker');
const { fakeClient } = require('./helpers');

/** Fake clock: sleep() advances time instantly. */
function fakeClock() {
  let t = 0;
  const waits = [];
  return { now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; }, waits };
}

test('createRateLimiter returns null for 0 and spaces requests in a 60s window', async () => {
  assert.strictEqual(createRateLimiter(0), null);
  const clock = fakeClock();
  const limiter = createRateLimiter(2, clock);
  await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
  assert.deepStrictEqual(clock.waits, [60000]); // third request waits for the window
  limiter.pauseFor(5000);
  await limiter.acquire();
  assert.strictEqual(clock.waits.at(-1), 5000);
});

const quotaError = (quotaId, delay) =>
  new Error(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota', details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay },
  ] } }));

test('errorInfo reads retry delay and daily quota', () => {
  assert.deepStrictEqual(errorInfo(quotaError('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '56s')), {
    code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota', retryDelayMs: 56000, daily: false,
  });
  assert.strictEqual(errorInfo(quotaError('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '1s')).daily, true);
  assert.strictEqual(errorInfo(new Error('plain')).message, 'plain');
});

test('per-minute 429 waits the requested delay through the limiter, daily 429 stops', async () => {
  const clock = fakeClock();
  const limiter = createRateLimiter(100, clock);
  const client = fakeClient([quotaError('PerMinute', '0.01s'), { icebreaker: 'Weekly launches stand out.', hook: 'h' }]);
  const out = await generateIcebreaker({ company_name: 'A' }, null, { client, limiter });
  assert.strictEqual(out.status, 'ok');
  assert.strictEqual(client.calls.length, 2);

  const daily = fakeClient([quotaError('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '1s')]);
  await assert.rejects(generateIcebreaker({ company_name: 'A' }, null, { client: daily }), /daily quota/);
  assert.strictEqual(daily.calls.length, 1);
});

test('templateIcebreaker quotes a clean one-liner and keeps brand casing', () => {
  assert.strictEqual(
    templateIcebreaker({ company_name: 'Pipedrive', company_description: 'Pipedrive is the easy-to-use, #1 user-rated CRM tool. Get more done.' }),
    'Had a look at Pipedrive, and your one-liner says it well: "Pipedrive is the easy-to-use, #1 user-rated CRM tool."',
  );
  const long = 'Contentsquare, the global leader in digital experience analytics, has joined forces with Hotjar, the tool for teams who want to understand users';
  assert.match(templateIcebreaker({ company_name: 'Hotjar' }, { metaDescription: long, headings: [] }), /"Contentsquare, the global leader in digital experience analytics, has joined forces with Hotjar\."/);
  assert.match(templateIcebreaker({ company_name: 'Copy.ai', company_description: 'Copy.ai builds GTM AI tools' }), /"Copy\.ai builds GTM AI tools\."/);
});
