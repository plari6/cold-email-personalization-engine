const { GoogleGenAI, Type } = require('@google/genai');
const { config } = require('./config');

// Gemini must answer with exactly this JSON shape.
const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    icebreaker: { type: Type.STRING, description: 'The personalized opening line, 1 or 2 sentences' },
    hook: { type: Type.STRING, description: 'The specific fact from the input that the icebreaker references, max 12 words' },
  },
  required: ['icebreaker', 'hook'],
  propertyOrdering: ['icebreaker', 'hook'],
};

const systemInstruction = (maxWords) => `You write cold email icebreakers following Alex Berman's cold email guidelines.
An icebreaker is the first line of a cold email. It must prove a human looked at the prospect's company.

Rules:
- Compliment the company on something SPECIFIC and TRUE from the input: their product, value proposition, a customer
  result, a niche they serve, a mission statement or a recent milestone. Then say briefly why it stands out.
- Reference their actual value proposition or description, in your own words. Do not copy marketing copy word for word.
- Strictly 1 or 2 sentences, under ${maxWords} words in total.
- Sound like a real person writing to a peer: casual, plain words, no buzzwords, no hype, no emojis, at most one exclamation mark.
- Do NOT start with "I". Do NOT include a greeting ("Hi Sarah,"), a sign-off, a pitch for any product or service,
  or a request for a call. The rest of the email handles that.
- No generic flattery ("great company", "impressive website", "I love what you do"). It must not fit any other company.
- Avoid stock phrases that make every email sound the same: "really stands out", "is a huge/massive win",
  "super impressive", "makes total sense", "such a smart approach", "is refreshing to see". Vary how you open the line.
- Never invent facts, numbers, awards or customers that are not in the input.
- No placeholders, brackets or template variables.
- "hook" names the specific fact you referenced (max 12 words).`;

/** Builds the per-prospect prompt from the CSV row and (optional) website copy. */
function buildPrompt(prospect, website, { senderOffer = '' } = {}) {
  const lines = [
    'PROSPECT:',
    `First name: ${prospect.first_name || '(unknown)'}`,
    `Company: ${prospect.company_name || '(unknown)'}`,
    `Website: ${prospect.website_url || '(none)'}`,
    `Description from our list: ${prospect.company_description || '(none)'}`,
  ];
  if (website) {
    lines.push(
      '',
      'FROM THEIR HOMEPAGE (most reliable source, prefer it):',
      website.title && `Page title: ${website.title}`,
      website.ogTitle && website.ogTitle !== website.title && `Share title: ${website.ogTitle}`,
      website.metaDescription && `Meta description: ${website.metaDescription}`,
      website.headings.length && `Headings: ${website.headings.join(' | ')}`,
      website.paragraphs.length && `Copy: ${website.paragraphs.join(' / ')}`,
    );
  } else {
    lines.push('', 'Their website could not be read. Use the description only.');
  }
  if (senderOffer) {
    lines.push('', `CONTEXT (do NOT pitch it, only use it to choose a relevant angle): the sender offers ${senderOffer}`);
  }
  return lines.filter(Boolean).join('\n');
}

const ABBREVIATIONS = /\b(e\.g|i\.e|etc|vs|Mr|Ms|Mrs|Dr|St|Inc|Ltd|Co|Corp|U\.S)\./gi;
const DOT = '․'; // stand-in for dots that don't end a sentence

/** Hides dots that don't end a sentence: domains (Monday.com), numbers (2.5) and abbreviations. */
const protectDots = (text) =>
  String(text || '')
    .replace(ABBREVIATIONS, (m) => m.replace(/\./g, DOT))
    .replace(/(\w)\.(?=\w)/g, `$1${DOT}`);

/** Splits text into sentences. */
function splitSentences(text) {
  const parts = protectDots(text).match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g) || [];
  return parts.map((p) => p.split(DOT).join('.').trim()).filter(Boolean);
}

const countSentences = (text) => splitSentences(text).length;

const countWords = (text) => String(text || '').trim().split(/\s+/).filter(Boolean).length;

const BANNED = [
  [/\bhope (this|you|all)\b/i, 'uses a "hope this finds you well" style opener'],
  [/\b(we|our team) (help|helps|can help)\b|\bour (product|service|platform|agency)\b/i, 'pitches a product'],
  [/\b(quick|short|15[- ]minute) (call|chat)\b|\bbook a (call|meeting|demo)\b/i, 'asks for a call'],
  [/\b(synerg\w*|game[- ]chang\w*|revolutionar\w*|cutting[- ]edge)\b/i, 'uses buzzwords'],
  [/\b(really stands out|(huge|massive) win|super impressive|makes total sense|is refreshing to see)\b/i, 'uses a stock phrase'],
  [/\[[^\]]*\]|\{\{?[^}]*\}\}?|<[^>]+>/, 'contains a placeholder'],
];

/** Tidies a model answer: trims quotes, whitespace and a leading greeting. */
function tidy(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/^(hi|hey|hello|dear)\s+[^,.!]{1,40}[,!]\s*/i, '')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

/** Checks an icebreaker against the rules. Returns a list of problems (empty = valid). */
function validateIcebreaker(text, { maxWords = config.maxWords } = {}) {
  const problems = [];
  if (!text) return ['is empty'];
  const sentences = countSentences(text);
  if (sentences > 2) problems.push(`has ${sentences} sentences (max 2)`);
  const words = countWords(text);
  if (words > maxWords) problems.push(`has ${words} words (max ${maxWords})`);
  if (/^I\b/.test(text)) problems.push('starts with "I"');
  if ((text.match(/!/g) || []).length > 1) problems.push('has more than one exclamation mark');
  for (const [re, why] of BANNED) if (re.test(text)) problems.push(why);
  return problems;
}

/** Keeps only the first two sentences. */
const firstTwoSentences = (text) => splitSentences(text).slice(0, 2).join(' ');

/** First sentence of a description, max 20 words (cut at a comma), or '' when it can't be shortened cleanly. */
function oneLiner(source) {
  let s = clean(clean(source).split(/[.!?](?:\s|$)|[;\n]|\s[—–-]\s/)[0]);
  const words = s.split(' ');
  if (words.length > 20) {
    const cut = words.slice(0, 20).join(' ');
    const comma = cut.lastIndexOf(',');
    if (comma < 20) return '';
    s = cut.slice(0, comma);
  }
  return s.replace(/[,:]$/, '').trim();
}

/** Rule-based icebreaker used with --no-ai or when Gemini fails. Quotes their own one-liner, so casing stays right. */
function templateIcebreaker(prospect, website) {
  const company = prospect.company_name || 'your company';
  const sources = [prospect.company_description, website?.metaDescription, website?.headings?.[0]];
  const line = sources.map(oneLiner).find((s) => s.split(' ').length >= 3);
  if (!line) return `Came across ${company} and wanted to reach out to you directly.`;
  return `Had a look at ${company}, and your one-liner says it well: "${line}."`;
}

/** Reads the SDK's JSON error: { code, status, message, retryDelayMs, daily }. */
function errorInfo(err) {
  try {
    const { error } = JSON.parse(err.message);
    const details = error.details || [];
    const delay = details.find((d) => d.retryDelay)?.retryDelay;
    const quotaIds = details.flatMap((d) => d.violations || []).map((v) => v.quotaId || '');
    return {
      code: error.code,
      status: error.status,
      message: error.message,
      retryDelayMs: delay ? Math.ceil(parseFloat(delay) * 1000) : 0,
      daily: quotaIds.some((id) => /PerDay/i.test(id)),
    };
  } catch {
    return { message: err.message, retryDelayMs: 0, daily: false };
  }
}

/** Turns the SDK's raw JSON error into "400 INVALID_ARGUMENT: API key not valid...". */
function describeError(err) {
  const info = errorInfo(err);
  return info.code ? `${[info.code, info.status].filter(Boolean).join(' ')}: ${info.message}` : info.message;
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function createClient(apiKey = config.geminiApiKey) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set. Add it to .env or run with --no-ai.');
  return new GoogleGenAI({ apiKey });
}

const RETRYABLE = /\b(429|500|502|503|504)\b|overloaded|unavailable|rate.?limit|resource_exhausted|fetch failed|timed? ?out|abort/i;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseJson(text) {
  const trimmed = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error('Gemini returned invalid JSON');
  }
}

async function callGemini(client, request, { retries, backoffMs, limiter }) {
  for (let attempt = 0; ; attempt++) {
    if (limiter) await limiter.acquire();
    try {
      const response = await client.models.generateContent(request);
      return parseJson(response.text);
    } catch (err) {
      const info = errorInfo(err);
      if (info.daily) {
        throw new Error('Gemini daily quota used up. Finished rows are cached, so run again tomorrow (or use a paid key) to continue.');
      }
      if (attempt >= retries || !RETRYABLE.test(err.message)) throw new Error(`Gemini request failed: ${describeError(err)}`);
      // Use the delay Gemini asks for (per-minute quota), else exponential backoff. Pause all rows, not just this one.
      const wait = info.retryDelayMs ? Math.min(info.retryDelayMs + 500, 65000) : backoffMs * 2 ** attempt;
      if (limiter) limiter.pauseFor(wait);
      await sleep(wait);
    }
  }
}

/**
 * Generates one icebreaker.
 * @returns {{ icebreaker: string, hook: string, status: 'ok'|'needs_review', problems: string[] }}
 */
async function generateIcebreaker(prospect, website, opts = {}) {
  const client = opts.client || createClient();
  const model = opts.model || config.geminiModel;
  const maxWords = opts.maxWords || config.maxWords;
  const retry = { retries: opts.retries ?? 3, backoffMs: opts.backoffMs ?? 1500, limiter: opts.limiter };
  const prompt = buildPrompt(prospect, website, { senderOffer: opts.senderOffer ?? config.senderOffer });
  const request = (contents) => ({
    model,
    contents,
    config: {
      systemInstruction: systemInstruction(maxWords),
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.7,
      httpOptions: { timeout: opts.timeoutMs || config.geminiTimeoutMs },
    },
  });

  let ai = await callGemini(client, request(prompt), retry);
  let text = tidy(ai.icebreaker);
  let problems = validateIcebreaker(text, { maxWords });

  // One rewrite with feedback when the first draft breaks a rule.
  if (problems.length) {
    const feedback = `${prompt}\n\nYOUR PREVIOUS DRAFT:\n${text}\n\nIt ${problems.join(', ')}. Rewrite it so it follows every rule.`;
    const second = await callGemini(client, request(feedback), retry);
    const secondText = tidy(second.icebreaker);
    const secondProblems = validateIcebreaker(secondText, { maxWords });
    if (secondProblems.length <= problems.length) [ai, text, problems] = [second, secondText, secondProblems];
  }

  // Last resort for length problems: cut to two sentences.
  if (problems.some((p) => p.includes('sentences'))) {
    text = firstTwoSentences(text);
    problems = validateIcebreaker(text, { maxWords });
  }

  return { icebreaker: text, hook: clean(ai.hook), status: problems.length ? 'needs_review' : 'ok', problems };
}

module.exports = {
  RESPONSE_SCHEMA,
  buildPrompt,
  countSentences,
  countWords,
  createClient,
  describeError,
  errorInfo,
  firstTwoSentences,
  generateIcebreaker,
  parseJson,
  systemInstruction,
  templateIcebreaker,
  tidy,
  validateIcebreaker,
  splitSentences,
};
