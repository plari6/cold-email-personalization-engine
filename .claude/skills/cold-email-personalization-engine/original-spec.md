# Original build spec

The prompt the project was started from (written with Gemini). Notes on where the build differs are at the bottom.

---

Build a complete Node.js command-line utility called "cold-email-personalization-engine".

Key Requirements & Architecture:
1. Tech Stack: Node.js, @google/generative-ai (Gemini 1.5 Flash API), csv-parser (or fs stream parsers), and dotenv.
2. Input Handling:
   - Read an input CSV file named `prospects.csv` containing columns: `first_name`, `company_name`, `website_url`, and `company_description`.
3. AI Personalization Agent:
   - For each row, send a structured prompt to the Gemini API following Alex Berman's cold email guidelines (compliment the company, reference their specific value proposition or description, and keep the icebreaker strictly under 2 sentences).
4. Output Generation:
   - Stream the processed rows into a new output CSV file named `enriched_prospects.csv` that appends a `personalized_icebreaker` column alongside the original data.
5. Developer Experience:
   - Include clear console logs showing real-time progress (e.g., "Processing row 3 of 50: [Company Name]... Done!").
   - Provide a clean README.md with setup instructions, sample `.env` file for GEMINI_API_KEY, and a mock `prospects.csv` template.

---

## Where the build differs, and why
- **SDK and model**: `@google/generative-ai` is deprecated and Gemini 1.5 Flash is retired. The build uses `@google/genai` with
  `gemini-flash-lite-latest` (configurable through `GEMINI_MODEL`).
- **Reads the website**: the spec only used `company_description`. The tool also fetches each homepage, so icebreakers
  reference real, current copy. The description is the fallback.
- **Added**: rule checks with one rewrite, a requests-per-minute limiter for the free tier, a cache for free re-runs, an `.xlsx` copy,
  parallel rows with ordered output, `--limit`, `--no-ai`, header aliases, `;` CSV support, and extra
  `personalization_hook` / `icebreaker_source` / `icebreaker_status` columns.
