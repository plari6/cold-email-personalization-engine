const cheerio = require('cheerio');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_BYTES = 2_000_000;

/** Adds https:// when missing and rejects anything that is not http(s). */
function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`;
  try {
    const url = new URL(withScheme);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

const clean = (text) => String(text || '').replace(/\s+/g, ' ').trim();

function uniqueTexts(list, max, minLength = 3) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const t = clean(item);
    const key = t.toLowerCase();
    if (t.length < minLength || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** Pulls the parts of a homepage that say what the company does. */
function extractWebsiteContext(html, url = '') {
  const $ = cheerio.load(html);
  const meta = (sel) => clean($(sel).attr('content'));

  const context = {
    url,
    title: clean($('title').first().text()).slice(0, 200),
    metaDescription: (meta('meta[name="description"]') || meta('meta[property="og:description"]')).slice(0, 400),
    ogTitle: meta('meta[property="og:title"]').slice(0, 200),
    headings: [],
    paragraphs: [],
  };

  $('script, style, noscript, svg, iframe, nav, footer, form, [aria-hidden="true"]').remove();
  context.headings = uniqueTexts(
    $('h1, h2').map((_, el) => $(el).text()).get(),
    8,
  ).map((t) => t.slice(0, 160));
  context.paragraphs = uniqueTexts(
    $('main p, section p, p').map((_, el) => $(el).text()).get(),
    6,
    40,
  ).map((t) => t.slice(0, 300));

  return context;
}

const hasContent = (ctx) => Boolean(ctx && (ctx.metaDescription || ctx.headings.length || ctx.paragraphs.length));

/**
 * Downloads a homepage and returns its key copy.
 * Never throws: returns { ok: false, error } when the site can't be read.
 */
async function fetchWebsiteContext(inputUrl, { timeoutMs = 12000, fetchImpl = fetch } = {}) {
  const url = normalizeUrl(inputUrl);
  if (!url) return { ok: false, error: 'missing or invalid website_url' };
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const type = res.headers.get('content-type') || '';
    if (type && !/html|xml/i.test(type)) return { ok: false, error: `not an HTML page (${type})` };
    const html = (await res.text()).slice(0, MAX_BYTES);
    const context = extractWebsiteContext(html, res.url || url);
    if (!hasContent(context)) return { ok: false, error: 'page has no readable text (JS-only site or bot wall)', context };
    return { ok: true, context };
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : err.cause?.code || err.message;
    return { ok: false, error: reason };
  }
}

module.exports = { extractWebsiteContext, fetchWebsiteContext, hasContent, normalizeUrl };
