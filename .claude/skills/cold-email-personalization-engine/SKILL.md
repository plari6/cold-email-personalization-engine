---
name: cold-email-personalization-engine
description: Generate personalized cold email icebreakers (max 2 sentences, Alex Berman style) for a CSV of prospects by reading each prospect's website with this project's Node.js + Gemini CLI. Use when the user wants to personalize a lead list, write first lines or icebreakers for cold emails, enrich prospects.csv, or extend/fix this engine.
---

# Cold Email Personalization Engine

## What it does
Streams a prospects CSV (`first_name`, `company_name`, `website_url`, `company_description`, plus any extra columns),
fetches each homepage (title, meta description, headings, main copy), and asks Gemini (structured JSON output) for an
icebreaker and the fact it references. Each line is checked against Alex Berman's rules and rewritten once if it breaks one.
Output is `enriched_prospects.csv` with `personalized_icebreaker`, `personalization_hook`, `icebreaker_source` and
`icebreaker_status` appended, plus an `.xlsx` copy (the user's Windows uses comma decimals, so Excel opens comma CSVs as one column).

## How to run it
From the project root (needs `GEMINI_API_KEY` in `.env`):

```bash
npm start                                   # prospects.csv → enriched_prospects.csv + .xlsx
npm start -- -i <in.csv> -o <out.csv>
npm start -- --limit 5                      # trial run
npm start -- --no-ai                        # template only, no key
```

Other flags: `-c/--concurrency`, `--model`, `--rpm`, `--max-words`, `--separator ";"`, `--no-website`, `--no-cache`, `--no-xlsx`.

## Picking options for the user's goal
- **New list, unsure about quality**: `--limit 5` first, show the lines, then run the full file.
- **Big list on the free tier**: keep `GEMINI_RPM=14`. The run pauses itself. If the daily quota runs out, re-run the next day: the cache skips finished rows.
- **Sites that block bots (HTTP 403)**: ask the user to fill `company_description` for those rows.
- **Excel user**: point them to the `.xlsx`, or use `--separator ";"`.

## Icebreaker rules (Alex Berman) — enforced in `src/icebreaker.js`
- Compliment something specific and true (product, value proposition, customer result, niche, milestone) and say why it stands out.
- 1 or 2 sentences, under `MAX_WORDS` (45) words. No "I" opener, greeting, sign-off, pitch, call request, placeholders,
  "hope this finds you well", buzzwords or stock phrases ("really stands out", "makes total sense"...).
- Never invent facts. The greeting (`Hi {{first_name}},`) belongs in the email template, not the icebreaker.
- Change rules in `systemInstruction()` (prompt) and `BANNED` / `validateIcebreaker()` (checks), then run `npm test`.

## Code entry points
- `src/engine.js` → `runPipeline(opts)`, `processRow(raw, ctx)`, `writeXlsx()`
- `src/icebreaker.js` → `generateIcebreaker(prospect, website, { client, model, limiter })`, `validateIcebreaker()`, `templateIcebreaker()`
- `src/website.js` → `fetchWebsiteContext(url)` (never throws, returns `{ ok, context | error }`)
- `src/ratelimit.js` → `createRateLimiter(rpm)`, shared by all parallel rows
- `src/csv.js` → `ALIASES` (accepted header names), streaming writer
- Tests: `npm test` (offline: fake Gemini client + local HTTP server in `test/helpers.js`)

## Lessons from live testing (Nov 2026)
- `gemini-1.5-flash` and `gemini-2.5-flash` are retired (404). `gemini-flash-latest` was overloaded (503, 80 to 270s per call).
  `gemini-flash-lite-latest` answers in about 1s with good quality, so it is the default.
- The free tier allows 15 requests per minute per model. A 429 includes `RetryInfo.retryDelay`. The limiter honors it and pauses all rows.
- API errors whose quota id contains `PerDay`, or which report a bad key, 400 or 404, stop the run instead of writing hundreds of fallbacks.
- `httpOptions.timeout` below 10s is rejected by the API.

## Original build spec
The prompt this project was built from is in [original-spec.md](original-spec.md).
