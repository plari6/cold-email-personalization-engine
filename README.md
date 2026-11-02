# Cold Email Personalization Engine

A Node.js command-line tool that reads a CSV of prospects, visits each prospect's website and writes a custom icebreaker of at most 2 sentences for every row with Google Gemini. The result is a new CSV (and an Excel copy) with a `personalized_icebreaker` column next to your original data, ready to merge into any cold email tool.

## Why

**Personalization at list scale.** A specific first line is what gets a cold email read, and writing one by hand takes 3 to 5 minutes per prospect. This tool does it in about 1 to 2 seconds per row.

**Based on their actual homepage, not a guess.** Each icebreaker comes from the prospect's live website copy (title, meta description, headings, main text), so it references something true and current. If the site can't be read, it uses your `company_description` column instead.

**Alex Berman's cold email rules, enforced in code.** The prompt asks for a specific compliment tied to the company's value proposition, in at most 2 sentences. The tool then checks every result: sentence count, word limit, no "I" opener, no greeting, no pitch, no "hope this finds you well", no placeholders and no stock phrases. A line that breaks a rule is rewritten once. If it still fails, it's flagged for review.

## Example

`prospects.csv`

```csv
first_name,company_name,website_url,company_description
Marco,Plausible Analytics,plausible.io,Lightweight and privacy-friendly Google Analytics alternative.
```

`enriched_prospects.csv` (new columns appended)

| personalized_icebreaker | personalization_hook | icebreaker_source | icebreaker_status |
|---|---|---|---|
| Removing cookies and heavy scripts to give site owners a clean, privacy-first dashboard is a smart way to fix what is broken with traditional web tracking. | Cookie-free, privacy-first analytics dashboard | website | ok |

Console output:

```
Processing row 1 of 5: Basecamp... Done! (website, 1.9s)
   → Keeping project management straightforward rather than bloated is rare after twenty years in software. ...
Processing row 2 of 5: Gumroad... Done! (website, 1.1s)
...
Finished 5 rows in 2.8s: 5 ready
CSV:   enriched_prospects.csv
Excel: enriched_prospects.xlsx
```

## Setup

Requires Node.js 18 or newer.

```bash
npm install
cp .env.example .env    # then set GEMINI_API_KEY
```

Get a free Gemini API key at [Google AI Studio](https://aistudio.google.com/app/apikey).

### Sample `.env`

```env
GEMINI_API_KEY=your_gemini_api_key_here

# Optional: what you sell. Only used to pick a relevant angle, never pitched in the icebreaker.
SENDER_OFFER=

# Optional tuning
GEMINI_MODEL=gemini-flash-lite-latest
GEMINI_TIMEOUT_MS=60000
GEMINI_RPM=14
INPUT_FILE=prospects.csv
OUTPUT_FILE=enriched_prospects.csv
CONCURRENCY=3
MAX_WORDS=45
FETCH_TIMEOUT_MS=12000
CACHE_FILE=data/cache.json
```

| Variable | Default | Description |
|---|---|---|
| `GEMINI_API_KEY` | | Required, unless you run with `--no-ai` |
| `GEMINI_MODEL` | `gemini-flash-lite-latest` | Fast and accurate enough for one-liners. `gemini-flash-latest` is the bigger model, but it was often overloaded during testing (2+ minutes per call) |
| `GEMINI_RPM` | `14` | Requests per minute across all rows. The free tier allows 15 per minute per model. Raise it on a paid key, or set `0` for no limit |
| `GEMINI_TIMEOUT_MS` | `60000` | Per-request timeout (the API minimum is 10000) |
| `SENDER_OFFER` | | One line on what you sell, so Gemini picks a relevant angle |
| `INPUT_FILE` / `OUTPUT_FILE` | `prospects.csv` / `enriched_prospects.csv` | Default paths |
| `CONCURRENCY` | `3` | Rows processed in parallel |
| `MAX_WORDS` | `45` | Word limit per icebreaker |
| `FETCH_TIMEOUT_MS` | `12000` | Website download timeout |
| `CACHE_FILE` | `data/cache.json` | Where finished icebreakers are cached |

### `prospects.csv` template

```csv
first_name,company_name,website_url,company_description
Sarah,Basecamp,basecamp.com,"Project management and team communication software for small businesses, built by 37signals."
James,Gumroad,https://gumroad.com,Platform that lets creators sell digital products directly to their audience.
```

- Columns: `first_name`, `company_name`, `website_url`, `company_description`. Common spellings also work: `First Name`, `Company`, `Website`, `URL`, `Domain`, `Description`, `About`.
- Extra columns (owner, email, LinkedIn URL, ...) are kept in the output untouched.
- `website_url` can be a bare domain (`acme.com`) or a full URL.
- Both `,` and `;` separated files are detected automatically (Excel exports `;` on many European locales).

## Usage

```bash
npm start                                         # prospects.csv → enriched_prospects.csv + .xlsx
npm start -- -i leads/october.csv -o leads/october_enriched.csv
npm start -- --limit 5                            # try the first 5 rows before a big run
npm start -- --no-ai                              # template icebreakers, no API key needed
npm start -- --separator ";"                      # CSV for Excel on comma-decimal locales
```

| Option | Effect |
|---|---|
| `-i, --input <file>` | Input CSV |
| `-o, --output <file>` | Output CSV. An `.xlsx` copy with the same name is written next to it |
| `-n, --limit <n>` | Only process the first n rows |
| `-c, --concurrency <n>` | Rows processed in parallel (max 20) |
| `--model <name>` | Gemini model for this run |
| `--rpm <n>` | Max Gemini requests per minute, `0` = no limit |
| `--max-words <n>` | Word limit per icebreaker |
| `--separator <char>` | Output CSV separator |
| `--no-ai` | Rule-based template that quotes the company's own one-liner. No API calls |
| `--no-website` | Skip website reading and use `company_description` only (faster) |
| `--no-cache` | Don't read or write the cache |
| `--no-xlsx` | Don't write the Excel copy |

### Output columns

| Column | Meaning |
|---|---|
| `personalized_icebreaker` | The opening line. Put it after your greeting: `Hi {{first_name}}, {{personalized_icebreaker}}` |
| `personalization_hook` | The specific fact the line refers to, for a quick sanity check |
| `icebreaker_source` | `website`, `description` (site couldn't be read) or `template` |
| `icebreaker_status` | `ok`, `needs_review` (broke a rule after the rewrite, or there was nothing to personalize from), `template` (`--no-ai`), `fallback` (Gemini failed, template used) or `skipped` (empty row) |

In the Excel copy, websites are clickable, the header is frozen and filterable, and `needs_review` and `fallback` rows are highlighted.

### Re-runs are free

Every finished icebreaker is cached in `data/cache.json`. Run the same file again, for example after adding rows or after hitting the daily quota, and only new or changed rows call Gemini. Use `--no-cache` to regenerate everything.

## How it works

```
prospects.csv ──stream──▶ for each row (3 in parallel, output kept in order)
                            1. fetch homepage → title, meta description, headings, main copy
                            2. Gemini (JSON schema) → { icebreaker, hook }
                            3. check rules → rewrite once if broken → trim to 2 sentences
                         ──stream──▶ enriched_prospects.csv  (+ .xlsx at the end)
```

| File | Role |
|---|---|
| `src/index.js` | CLI flags and console progress |
| `src/engine.js` | `runPipeline()`: streaming, concurrency, ordering, cache, fallbacks, Excel export |
| `src/website.js` | `fetchWebsiteContext()`: downloads and extracts homepage copy |
| `src/icebreaker.js` | Prompt, Gemini call with retries, `validateIcebreaker()`, template fallback |
| `src/ratelimit.js` | Shared requests-per-minute limiter |
| `src/csv.js` | Header aliases, separator detection, streaming CSV writer |
| `src/cache.js` | JSON cache of finished rows |

## Troubleshooting

| Problem | Fix |
|---|---|
| `site not read: HTTP 403` | The site blocks bots (Cloudflare and similar). Fill in `company_description` for that row and it will be used instead |
| `Pausing 50s for the Gemini rate limit` | Normal on the free tier (15 requests per minute). Raise `GEMINI_RPM` on a paid key |
| `Gemini daily quota used up` | The free daily quota is spent. Run the same command tomorrow: finished rows come from the cache |
| `404 ... no longer available` | The model was retired. Set `GEMINI_MODEL` to a current one, such as `gemini-flash-lite-latest` |
| Very slow rows (minutes each) | The selected model is overloaded. Switch back to `gemini-flash-lite-latest` |
| Excel shows everything in one column | Open the `.xlsx` copy, or run with `--separator ";"` |

## Tests

```bash
npm test
```

25 tests run offline, using a fake Gemini client and a local test web server.

## License

MIT
