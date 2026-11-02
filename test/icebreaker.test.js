const test = require('node:test');
const assert = require('node:assert');
const {
  buildPrompt,
  countSentences,
  firstTwoSentences,
  generateIcebreaker,
  parseJson,
  templateIcebreaker,
  tidy,
  validateIcebreaker,
} = require('../src/icebreaker');
const { fakeClient } = require('./helpers');

const prospect = {
  first_name: 'Sarah',
  company_name: 'Acme Rockets',
  website_url: 'acme.test',
  company_description: 'Reusable rockets for small satellites.',
};

test('countSentences ignores dots in domains, numbers and abbreviations', () => {
  assert.strictEqual(countSentences('Love how Monday.com ships 2.5x faster, e.g. for ops teams.'), 1);
  assert.strictEqual(countSentences('One. Two! Three?'), 3);
  assert.strictEqual(countSentences('No final punctuation'), 1);
  assert.strictEqual(countSentences(''), 0);
});

test('firstTwoSentences keeps two sentences and domain dots', () => {
  assert.strictEqual(firstTwoSentences('Saw Acme.io today. Great docs. Third one.'), 'Saw Acme.io today. Great docs.');
});

test('validateIcebreaker flags rule breaks', () => {
  assert.deepStrictEqual(validateIcebreaker('Your reusable boosters cut launch costs, which is rare for small sats.'), []);
  assert.match(validateIcebreaker('One. Two. Three.').join(), /3 sentences/);
  assert.match(validateIcebreaker('I love your site.').join(), /starts with "I"/);
  assert.match(validateIcebreaker('Hope this finds you well.').join(), /hope/);
  assert.match(validateIcebreaker('Saw [Company] grew.').join(), /placeholder/);
  assert.match(validateIcebreaker('Nice site, we help teams like yours.').join(), /pitches/);
  assert.match(validateIcebreaker('Wow! Amazing!').join(), /exclamation/);
  assert.match(validateIcebreaker('Your focus on privacy makes total sense.').join(), /stock phrase/);
  assert.match(validateIcebreaker(Array(60).fill('word').join(' ')).join(), /60 words/);
  assert.deepStrictEqual(validateIcebreaker(''), ['is empty']);
});

test('tidy strips quotes, whitespace and greetings', () => {
  assert.strictEqual(tidy('  "Hi Sarah, love   the launch cadence."  '), 'Love the launch cadence.');
  assert.strictEqual(tidy('Hey there! your docs are great.'), 'Your docs are great.');
});

test('parseJson handles fenced JSON and rejects garbage', () => {
  assert.deepStrictEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => parseJson('not json'), /invalid JSON/);
});

test('buildPrompt includes website copy when available, description otherwise', () => {
  const site = { title: 'Acme', ogTitle: '', metaDescription: 'Cheap launches', headings: ['Launch smarter'], paragraphs: ['120 missions'] };
  const withSite = buildPrompt(prospect, site);
  assert.match(withSite, /Meta description: Cheap launches/);
  assert.match(withSite, /Headings: Launch smarter/);
  const noSite = buildPrompt(prospect, null, { senderOffer: 'CRM setup' });
  assert.match(noSite, /could not be read/);
  assert.match(noSite, /do NOT pitch it/);
});

test('templateIcebreaker uses the description and handles empty input', () => {
  assert.strictEqual(
    templateIcebreaker(prospect),
    'Had a look at Acme Rockets, and your one-liner says it well: "Reusable rockets for small satellites."',
  );
  assert.match(templateIcebreaker({ company_name: 'X' }), /Came across X/);
});

test('generateIcebreaker returns a valid answer in one call', async () => {
  const client = fakeClient([{ icebreaker: 'Flying 120 missions for student teams is a great track record.', hook: '120 missions' }]);
  const out = await generateIcebreaker(prospect, null, { client, model: 'm' });
  assert.strictEqual(out.status, 'ok');
  assert.strictEqual(out.hook, '120 missions');
  assert.strictEqual(client.calls.length, 1);
  assert.strictEqual(client.calls[0].config.responseMimeType, 'application/json');
});

test('generateIcebreaker rewrites once when the first draft breaks rules', async () => {
  const client = fakeClient([
    { icebreaker: 'I love it. Really. A lot. Truly.', hook: 'x' },
    { icebreaker: 'Weekly launches for small satellites is a bold promise.', hook: 'weekly launches' },
  ]);
  const out = await generateIcebreaker(prospect, null, { client });
  assert.strictEqual(out.status, 'ok');
  assert.strictEqual(client.calls.length, 2);
  assert.match(client.calls[1].contents, /YOUR PREVIOUS DRAFT/);
});

test('generateIcebreaker trims to two sentences and marks review when still invalid', async () => {
  const client = fakeClient([{ icebreaker: 'Great boosters. Weekly launches. Students love it.', hook: 'x' }]);
  const out = await generateIcebreaker(prospect, null, { client });
  assert.strictEqual(out.icebreaker, 'Great boosters. Weekly launches.');
  assert.strictEqual(out.status, 'ok');

  const bad = fakeClient([{ icebreaker: 'I think we help teams like yours.', hook: 'x' }]);
  const out2 = await generateIcebreaker(prospect, null, { client: bad });
  assert.strictEqual(out2.status, 'needs_review');
  assert.ok(out2.problems.length > 0);
});

test('generateIcebreaker retries rate limits, not other errors', async () => {
  const flaky = fakeClient([new Error('429 RESOURCE_EXHAUSTED'), { icebreaker: 'Weekly launches stand out.', hook: 'h' }]);
  const out = await generateIcebreaker(prospect, null, { client: flaky, backoffMs: 1 });
  assert.strictEqual(out.status, 'ok');
  assert.strictEqual(flaky.calls.length, 2);

  const broken = fakeClient([new Error('API key not valid')]);
  await assert.rejects(generateIcebreaker(prospect, null, { client: broken, backoffMs: 1 }), /API key not valid/);
  assert.strictEqual(broken.calls.length, 1);
});
