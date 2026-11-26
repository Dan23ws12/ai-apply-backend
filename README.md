# AI Job Apply

AI Job Apply finds jobs that match your search criteria and filters, rates each one for fraud risk and then for fit (two independent ratings), and writes a tailored resume and cover letter for the good matches. It then opens the application form in a visible browser and fills it in for you.

**The app never submits an application.** It fills in the form, and you check the answers and click **Submit** yourself. This keeps automated actions off your LinkedIn and Glassdoor accounts, which is what gets accounts restricted or banned, and it stops wrong answers from being sent without anyone seeing them.

```
Search criteria ──► JSearch (SerpApi Google Jobs if JSearch fails)
                     │
                     ▼
            Filter: LinkedIn/Glassdoor only, location type, job type,
                    keywords, salary, blacklisted companies, duplicates
                     │
                     ▼
            1. Fraud likelihood rating (1-100) ──► 80 or more → SKIPPED, no match rating
                     │
                     ▼
            2. Job match rating (1-100), worked out separately ──► outside your limits → SKIPPED
                     │
                     ▼
            Claude: tailored resume (.docx) + cover letter (.docx)
                     │
                     ▼
            Playwright opens the apply page and fills it in
                     │
                     ▼
            YOU review and click Submit ──► job marked APPLIED
                     │                      └─► row written to the SQLite ledger straight away
                     ▼
            POST /api/application-logs (end of day) ──► ledger exported to docs/AI Job Application Logs.xlsx
```

---

## Tech stack

| Layer | Tools |
|---|---|
| API server | Node.js 20+, **Express 5**, TypeScript (run with `tsx`) |
| Input validation | **Zod 4** for every request body, query and URL parameter, the login token payload, environment variables and replies from the Python service |
| Authentication | **bcrypt** password hashes + **JWT** bearer tokens. Zod checks the input and the token's contents, but it validates data and doesn't authenticate on its own, so bcrypt and JWT handle the actual login. |
| Database | **PostgreSQL 17** through **Prisma 7** (with the `@prisma/adapter-pg` driver) |
| Job search | **JSearch** on RapidAPI (primary) and **SerpApi Google Jobs** (backup) |
| Form filling | **Playwright** (Chromium, visible window, saved browser profile) |
| AI and documents | **Python 3.11+**, **FastAPI**, the **Anthropic Python SDK** (Claude, structured outputs), and **python-docx** for editing resumes |
| Security | AES-256-GCM encryption for saved job-site logins, `helmet`, CORS, secrets removed from audit logs |
| Logging | `pino` (console) plus the `audit_logs` table |

---

## Project structure

Everything sits in the repository root, next to the existing skills, references and resumes.

```
AI Job Apply Project/
├── README.md
├── .agents/skills/           # Resume skills and the job-post-evaluation skill (fraud + match rules)
├── shared-references/        # Existing format rules and extended skills lists (read by the AI)
├── application-docs/         # ★ One folder per day, then one folder per application
│   └── 2026-11-24/
│       └── Software Engineer - Acme - indeed-abc123/
│           ├── Resume.docx
│           ├── Cover Letter.docx
│           └── job.txt
├── resumes/
│   └── base resumes/         # Your base resumes (copied, never changed)
├── Job_APIs_and_Scrapers_Comparison.md
├── package.json              # Node scripts and dependencies
├── tsconfig.json
├── prisma.config.ts          # Prisma 7 config (reads DATABASE_URL)
├── docker-compose.yml        # Local PostgreSQL
├── .env.example              # Copy to .env
├── prisma/
│   ├── schema.prisma         # Database tables
│   └── migrations/           # SQL migrations
├── src/
│   ├── server.ts             # Starts the HTTP server
│   ├── app.ts                # Express app, middleware, routes
│   ├── config/env.ts         # Zod-validated environment variables
│   ├── lib/                  # prisma client, encryption, secret redaction, errors, logger
│   ├── middleware/           # auth (JWT), validate (Zod), request audit log, error handler
│   ├── schemas/index.ts      # All Zod request schemas
│   ├── routes/               # auth, users, search-criteria, companies, jobs, answers, audit-logs
│   ├── services/
│   │   ├── search/           # JSearch + SerpApi providers, result normalising, filters
│   │   ├── pipeline.service.ts   # search → save → score → generate documents
│   │   ├── ai.client.ts      # Calls the Python service (replies checked with Zod)
│   │   ├── audit.service.ts  # Writes audit_logs rows
│   │   ├── spending.service.ts   # Records AI token usage and search credits; spending summary
│   │   └── credentials.service.ts
│   ├── autofill/
│   │   ├── autofill.service.ts   # Opens the browser and fills the form; never clicks Submit
│   │   ├── fieldDetector.ts      # Finds fields and their labels (works inside iframes too)
│   │   └── profileMapper.ts      # Fills name/email/phone/etc. from your profile
│   └── generated/prisma/     # Prisma client (generated, git-ignored)
├── python-service/
│   ├── requirements.txt
│   ├── .env.example
│   └── app/
│       ├── main.py           # FastAPI endpoints: /evaluate/fraud /evaluate/match /documents /answers /health
│       ├── fraud.py          # Fraud likelihood rating: script checks + AI (with LinkedIn web search) + score
│       ├── match.py          # Job match rating: AI judgments + scoring script (no fraud input)
│       ├── usage.py          # Collects the token usage of every Claude call for the Node API to save
│       ├── ai.py             # All Claude calls (structured JSON outputs)
│       ├── documents.py      # Edits a copy of the base resume and writes the cover letter
│       ├── references.py     # Loads the repo's resume skills, reference files and base resumes
│       ├── schemas.py        # Pydantic models
│       └── config.py
└── storage/                  # Created at runtime (git-ignored)
    ├── browser-profiles/     # Saved browser profile, so you stay logged in
    └── application-ledger.sqlite  # Every applied job, recorded the moment it is marked APPLIED
```

Each application gets a folder under `application-docs/{YYYY-MM-DD}/`, named `{position} - {company} - {ids}`. The date is the day the resume and cover letter were created, so every application from that day sits in the same folder. The ids are the job-board keys parsed from the apply links (Indeed `jk`, LinkedIn job id, Glassdoor `jobListingId`), up to three, with the board you found the job on listed first. If none of those are in the links, the folder uses a shortened provider job id (`job-…`) so two postings with the same title and company stay apart. Inside the folder: `Resume.docx`, `Cover Letter.docx`, and `job.txt` (created date, position, company, ids, and the full apply links). Generating documents again on the same day replaces those three files. Generating them on a later day writes a new date folder and removes the previous one. Characters Windows doesn't allow in file names (such as `/` or `:`) are replaced with spaces, and the folder name stays within about 160 characters by shortening the position and company before the ids. To save the documents somewhere else, change `APPLICATION_DOCS_DIR` in `python-service/.env`.

The Python service reuses files that already exist in this repository:

| Repo file | Used for |
|---|---|
| `.agents/skills/*-resume-guidance/SKILL.md` | Rules for tailoring each type of resume |
| `.agents/skills/job-post-evaluation/SKILL.md` | Fraud likelihood and job match rating rules (mirrored in `fraud.py` and `match.py`) |
| `shared-references/format.md`, `skill-positional-guidance.md` | Resume format and where each skill goes |
| `shared-references/*-skills-and-tools.md` | Extended skills lists, used for match ratings and keywords |
| `resumes/base resumes/*.docx` | Base resumes. They're only ever copied, never changed. |

---

## Credentials and API keys you need

| Key | Where to get it | Goes in | Required? |
|---|---|---|---|
| `JSEARCH_API_KEY` | [RapidAPI → JSearch](https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch). Subscribe to a plan (there's a free tier) and copy `X-RapidAPI-Key`. | `.env` | Yes, unless you only use SerpApi |
| `SERPAPI_API_KEY` | [serpapi.com/manage-api-key](https://serpapi.com/manage-api-key) (free tier: 100 searches a month) | `.env` | Recommended as the backup |
| `ANTHROPIC_API_KEY` | [platform.claude.com → API keys](https://platform.claude.com/settings/keys) | `.env` or `python-service/.env` (the Python service reads both; a value in `python-service/.env` wins) | Yes |
| `JWT_SECRET` | Generate it yourself (command below) | `.env` | Yes |
| `CREDENTIALS_ENCRYPTION_KEY` | Generate it yourself (command below). **If you lose it, your saved job-site logins can't be read.** | `.env` | Yes |
| `PYTHON_SERVICE_TOKEN` | Any long random string. It must be **the same** in both `.env` files. | both | Yes |
| `DATABASE_URL` | Already set to match `docker-compose.yml` | `.env` | Yes |
| LinkedIn / Glassdoor login | Your own account | Sent to the API (see below), saved encrypted | Optional |

Generate the secrets:

```bash
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))"
```
```bash
node -e "console.log('CREDENTIALS_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
```
```bash
node -e "console.log('PYTHON_SERVICE_TOKEN=' + require('crypto').randomBytes(24).toString('hex'))"
```

`.env` files are git-ignored. Never commit them.

### Adding your job-site logins

You have two options:

1. **Log in by hand (recommended).** The first time a LinkedIn, Glassdoor or Indeed page opens in the auto-fill browser, log in yourself. The browser profile is saved in `storage/browser-profiles/<your user id>`, so you stay logged in on later runs.
2. **Save the logins in the app.** They're encrypted with `CREDENTIALS_ENCRYPTION_KEY` before they're stored in `users.credentials`. The API only ever returns *which* sites have a saved login, never the password. When a sign-in page appears, the app fills in the email and password boxes, and **you click Sign in yourself** and complete any 2-step verification.

Add, change or remove one site at a time (`linkedin`, `glassdoor` or `indeed`):

```http
PUT /api/users/me/credentials/linkedin
Authorization: Bearer <token>
Content-Type: application/json

{ "email": "you@example.com", "password": "..." }
```

- `PATCH /api/users/me/credentials/linkedin {"password":"..."}` changes only what you send.
- `DELETE /api/users/me/credentials/linkedin` removes that site's login; the others are kept.
- `GET /api/users/me/credentials` lists the connected sites, e.g. `{"linkedin":{"email":"you@example.com","hasPassword":true}}`.
- `PUT /api/users/me/credentials` (several sites in one body) and `DELETE /api/users/me/credentials` (all sites) still work.

---

## How to run it

### 1. Install the prerequisites

- Node.js 20.19 or newer
- Python 3.11 or newer
- Docker Desktop (for PostgreSQL). You can use any other PostgreSQL 14+ server instead and change `DATABASE_URL`.

### 2. Set up the Node API

Run these from the repository root (the folder that contains `package.json`):

```bash
npm install
```
```bash
cp .env.example .env
```
Fill in the keys in `.env`, then start the database, create the tables and download the browser:
```bash
docker compose up -d
```
```bash
npx prisma migrate deploy
```
```bash
npx prisma generate
```
```bash
npx playwright install chromium
```

### 3. Set up the Python AI service

```bash
cd python-service
```
```bash
python -m venv .venv
```
Activate the virtual environment. On Windows (PowerShell): `.venv\Scripts\Activate.ps1`. On macOS/Linux: `source .venv/bin/activate`. Then:
```bash
pip install -r requirements.txt
```
```bash
cp .env.example .env
```
Fill in `PYTHON_SERVICE_TOKEN` (the same token as in `../.env`). Put `ANTHROPIC_API_KEY` in either `../.env` or this file: the service also reads `../.env` and ignores empty values.

### 4. Start both services (two terminals)

```bash
cd python-service && uvicorn app.main:app --port 8000
```
```bash
npm run dev
```

Check that everything is up: `GET http://localhost:4000/health` should return `{"api":"ok","db":"ok","ai":"ok"}`.

### 5. Use it

All `/api/*` routes except register and login need `Authorization: Bearer <token>`.

```bash
# 1. Create an account (the reply includes a token)
curl -X POST localhost:4000/api/auth/register -H "content-type: application/json" \
  -d '{"firstName":"Jane","lastName":"Doe","email":"jane@example.com","password":"Str0ngPassword"}'

# 2. Fill in the profile used for application forms
curl -X PUT localhost:4000/api/users/me/profile -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"phone":"555-0100","city":"Toronto","region":"ON","country":"Canada","linkedinUrl":"https://linkedin.com/in/jane",
       "workAuthorization":"Canadian citizen","requiresSponsorship":false,"yearsOfExperience":2,
       "extraAnswers":{"willing to relocate":"No"}}'

# 3. Save a search
curl -X POST localhost:4000/api/search-criteria -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"name":"Remote data roles","query":"data analyst","location":"Toronto, ON","country":"ca",
       "datePosted":"PAST_WEEK","locationTypes":["REMOTE","HYBRID"],"jobTypes":["FULL_TIME"],
       "websites":["LINKEDIN","GLASSDOOR"],"excludeKeywords":["senior","10+ years"],
       "minMatchRating":65,"maxFraudRating":35,"maxResults":20}'

# 4. Run it. Jobs are saved right away; scoring and documents carry on in the background.
curl -X POST localhost:4000/api/search-criteria/$CRITERIA_ID/run -H "authorization: Bearer $TOKEN"

# 5. List jobs with their documents ready, best match first
curl "localhost:4000/api/jobs?status=DOCUMENTS_READY" -H "authorization: Bearer $TOKEN"

# 6. Open the browser and fill the form. Then check every answer and click Submit yourself.
curl -X POST localhost:4000/api/jobs/$JOB_ID/autofill -H "authorization: Bearer $TOKEN"
```

### API reference

| Method and path | What it does |
|---|---|
| `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me` | Account and login. Each login is its own session (one per browser or device). |
| `POST /api/auth/logout` | Sign out this session only. Your other devices, and other users, stay signed in. |
| `POST /api/auth/logout-all`, `GET /api/auth/sessions` | Sign out all your devices; list your active sessions (`current` marks this one) |
| `POST /api/auth/password-reset/request` with `{"email"}` | Ask for a reset link. Always answers `202`, whether or not the email has an account. |
| `POST /api/auth/password-reset/confirm` with `{"token","newPassword"}` | Set a new password from the link. Signs the account out everywhere. |
| `POST /api/auth/change-password` with `{"currentPassword","newPassword"}` | Change your password. Your other sessions are signed out; this one stays. |
| `PATCH /api/users/me` | Change your first or last name |
| `DELETE /api/users/me` | Delete your account. Your blacklist, profile, saved searches and saved answers are deleted; your jobs are kept. |
| `GET/PUT /api/users/me/profile` | Details used to fill application forms |
| `GET /api/users/me/settings`, `PATCH /api/users/me/settings` | Your job search settings: `jobsPerSearch` (most new jobs one run saves, 1–50, default 10) and `pagesPerSearch` (result pages per API call, about 10 jobs each, 1–5, default 1). Send only the fields you want to change. |
| `GET/PUT/DELETE /api/users/me/credentials` | Saved job-site logins for every site (encrypted, never returned) |
| `PUT/PATCH/DELETE /api/users/me/credentials/:site` | Add, change or remove one site's login (`linkedin`, `glassdoor`, `indeed`) |
| `GET/POST /api/search-criteria`, `GET/PATCH/DELETE /api/search-criteria/:id` | Saved searches |
| `POST /api/search-criteria/:id/run` | Run a search now. The reply says where jobs came from (`source`: `api`, `cache` or `cache+api`), whether the search API was called (`apiCalled`) and how many open jobs there were before the run (`openJobsBefore`). A search's `maxResults` (optional) overrides your `jobsPerSearch`. Jobs you already applied to (same application key) are saved as `SKIPPED` and counted in `skippedAlreadyApplied`. |
| `GET /api/companies?blacklisted=true&search=`, `POST /api/companies`, `PATCH /api/companies/:id` | Companies. Each one shows `blacklisted` for **your** blacklist; `{"blacklisted":true}` adds it, `false` removes it. |
| `GET /api/companies/blacklisted` | Your blacklist |
| `PUT /api/companies/:id/blacklist`, `DELETE /api/companies/:id/blacklist` | Add a company to, or remove it from, your blacklist. Adding it marks your open jobs there as `SKIPPED`. |
| `DELETE /api/companies/:id` | Delete a company for everyone. Its blacklist rows go with it; its jobs are kept. |
| `GET /api/jobs?status=&website=&locationType=&minMatch=&maxFraud=&page=` | Your jobs |
| `POST /api/jobs/search` | Search now and get the jobs back (array, in the frontend's `Job` shape). Body: `query`, `location`, `datePosted` (`PAST_WEEK`, `PAST_2_WEEKS`, `PAST_MONTH` or `ALL_TIME`), `websites`, `workModels`, `employmentTypes` (incl. `PERMANENT`), optional `postedAfter`, `limit`, `evaluate`. Details in `X-Search-*` headers. |
| `GET /api/jobs/saved`, `PUT/DELETE /api/jobs/:id/saved` | Your saved jobs; save or un-save one |
| `GET /api/jobs/applied`, `POST/DELETE /api/jobs/:id/applied` | Jobs you applied to (with the resume and cover letter used); mark one applied (optional `appliedAt`) or undo it |
| `GET /api/jobs/:id/documents` | Resume and cover letter previews: file name, preview text, signed link, source (`AI` or `UPLOADED`), MIME type |
| `POST /api/jobs/:id/documents/resume` or `.../cover-letter` | Upload your own file (multipart field `file`: `.pdf`, `.docx` or `.txt`, up to `UPLOAD_MAX_MB`) |
| `DELETE /api/jobs/:id/documents/resume` or `.../cover-letter` | Remove your upload and go back to the AI document |
| `GET /api/files/:token` | A document through a signed link (no login header needed; expires after `FILE_LINK_TTL_MINUTES`). Add `?download=1` to save it. |
| `GET/PATCH /api/jobs/:id` | Job details. Set the status by hand, e.g. `SAVED`, or `APPLIED` if submission wasn't detected. A "job" here is your application, returned together with its posting's details. |
| `GET /api/jobs/:id/history` | The job's status history, oldest first (e.g. `FOUND` → `SAVED` → `APPLIED`) |
| `POST /api/jobs/:id/evaluate?refresh=true` | Re-run the evaluation: fraud likelihood rating first, then the match rating unless fraud is 80 or more. Cached ratings are reused (`cached` in the reply); `refresh=true` asks the AI again. |
| `GET /api/application-logs?date=YYYY-MM-DD` | Preview what the next export would write: with no date, every ledger row not yet in Excel; with a date, that day's rows. Nothing is written to Excel. |
| `POST /api/application-logs` with `{}` or `{"date":"YYYY-MM-DD"}` | Export the ledger to the Excel log. With no date (the usual end-of-day call), every row added or changed since the last export; with a date, that day's rows. Running it again updates rows instead of duplicating them. |
| `POST /api/jobs/:id/documents` | Generate or regenerate the resume and cover letter |
| `GET/PATCH /api/jobs/:id/files` | See or change which resume/cover letter the job uses. `null` switches back to the AI version. |
| `GET /api/jobs/:id/files/resume`, `.../files/cover-letter` | Download a document |
| `POST /api/jobs/:id/autofill`, `GET /api/jobs/:id/autofill` | Start auto-fill, or check its status |
| `GET /api/answers`, `PUT /api/answers/:id`, `DELETE /api/answers/:id` | Saved answers to application questions. Correct one once and it's reused every time. |
| `GET /api/audit-logs?type=&requestId=&limit=` | Developer log of your requests and API calls |
| `GET /api/spending/summary?month=YYYY-MM` | One month at a glance: AI tokens and estimated cost by action and by model, search credits against your plan's quota, payments, budget status |
| `GET /api/spending/token-usage?from=&to=&action=&model=` | Every AI call: model, tokens, when, what for, estimated cost (newest first) |
| `GET /api/spending/token-usage/totals?by=action\|model\|day\|month&from=&to=` | Token and cost totals grouped by action, model, day or month (local time) |
| `GET /api/spending/search-usage?from=&to=&provider=` | Every JSearch / SerpApi request and the credits it used |
| `GET/POST /api/spending/services`, `PATCH/DELETE /api/spending/services/:id` | The paid APIs you use and their plan (cost, billing period, included units) |
| `GET /api/spending/payments?serviceId=&unpaid=true`, `POST`, `PATCH/DELETE /api/spending/payments/:id` | Payments you enter yourself. Fill in `datePaid` once paid: `PATCH {"datePaid":"YYYY-MM-DD"}` |
| `GET/POST /api/spending/prices`, `PATCH/DELETE /api/spending/prices/:id` | Claude prices used to estimate token costs |
| `GET/POST /api/spending/budgets`, `PATCH/DELETE /api/spending/budgets/:id` | Monthly spending limits with a warning threshold |

---

## Important information

- **You submit, not the app.** The filler only types into fields, picks options and uploads files. It never clicks Next, Submit, Easy Apply or any other button. On multi-step forms, click **Next** yourself and the filler fills each new step within a few seconds.
- **Lower ban risk.** With `PREFER_DIRECT_APPLY=true` (the default), the app opens the company's own careers page when JSearch provides one. That keeps automation off LinkedIn and Glassdoor completely. Easy Apply forms are still filled in your logged-in session, which LinkedIn's terms don't allow, so the risk is lower but not zero.
- **When an application counts as applied.** When a "thank you for applying" or "application submitted" page appears after you submit, the job is marked `APPLIED` with today's date. If that isn't detected, use `PATCH /api/jobs/:id` with `{"applicationStatus":"APPLIED"}`.
- **Check the AI's answers.** Answers the AI wasn't sure about are filled in but not saved for reuse, so look closely at free-text questions. Voluntary demographic questions get the "decline to answer" option when the form has one.
- **Two independent ratings, fraud first.**
  - **Fraud likelihood rating** (1–100, higher = more likely a scam). Python checks the posting site (HTTPS, whether it loads, company domain or known job board), whether the company name matches its website, and red-flag wording. One Claude call then searches for the company on LinkedIn with web search, confirms or rejects those findings, and explains them. Python turns the confirmed red flags into the rating (critical 45, high 25, medium 10, low 4 points; any critical flag means at least 80).
  - **At 80 or more**, the match rating is skipped, the job is marked `SKIPPED`, and documents and auto-fill are blocked.
  - **Job match rating** (1–100, higher = better fit): a separate Claude call that never sees the fraud result, scored by Python with the skill's 40/30/10/10/10 rules.
  - **Your search limits** (`minMatchRating`, `maxFraudRating`) then decide which jobs get documents. The ratings themselves never affect each other.
  - **The fraud rating is still a guide.** Check a company yourself before you send personal details.
- **The application log works in two layers.**
  - **Ledger (written straight away).** The moment a job is marked `APPLIED` (detected on submit, or set by hand), it is recorded in a SQLite file (`APPLICATION_LEDGER_PATH`, default `storage/application-ledger.sqlite`). Each write is one small atomic transaction, so a crash loses at most the application in progress, and Excel being open never blocks it. If a job's status is changed back from `APPLIED`, its ledger row is flagged as withdrawn and the next export removes it from the sheet.
  - **Excel (exported on demand).** `POST /api/application-logs` rebuilds the workbook (`APPLICATION_LOG_PATH`, default `../docs/AI Job Application Logs.xlsx`) from the ledger, usually once at the end of the day. It first copies any of today's (or that date's) `APPLIED` jobs that are missing from the ledger, as a safety net. It saves to a temporary file and renames it over the workbook, so a crash mid-write can't corrupt it.
  - **Application key.** Every ledger row has a key such as `JA-3F9A1C07B2D4`, made from your user, the company, the position and the location. Letter case, punctuation, accents, company suffixes (Inc, Ltd) and notes such as "(Remote)" or "- Contract" don't change it. The same job found twice (a re-post, or from the other search API) gets the same key: the log keeps one row (the ledger counts it in `times_applied`), and searches skip it.
  - **The sheet keeps your layout.** The export writes into the sheet whose header row has "Serial Number" (`Sheet1`) and grows the Excel table on it (`app_logs`) to fit. Columns are found by their header text, so you can reorder them; case and punctuation don't matter. It fills Serial Number (renumbered on every export), Date Applied, Employer, Job Title, Company Website Link, Resume Used (a clickable link to the file), Job Search Platform, Application Status, Work Model / Job Location Type, Job Location and Employment Type. **Cover Letter Used** (a clickable link to the file) and **Application Key** columns are added at the end if your sheet doesn't have them; you can move them anywhere afterwards. Re-exports match rows on Application Key. Rows you type in by hand (no key) are kept. Fields that have no column in your sheet, such as the match rating, apply link and times applied, stay in the ledger.
  - **Application Status** is set to `Applied` when a row is added and is never overwritten after that, so you can change it yourself as things progress (for example `Interview`, `Offer`, `Rejected`).
  - **Which jobs appear:** only jobs marked `APPLIED` that had a resume made. Saved, skipped, failed and unfinished applications are left out.
  - **Close the file in Excel** before exporting, or it returns `423`. Nothing is lost: the rows stay pending in the ledger until the next export.
- **Caching (to keep API and AI costs down).**
  - **Search results** are cached in `search_cache` for `SEARCH_CACHE_TTL_HOURS` (default 24) and shared by all users, since postings are public. The search API is only called again for a cached search when fewer than `SEARCH_REFRESH_THRESHOLD` (default 20) jobs matching the search are still open: cached jobs you don't have yet, plus your saved jobs from that search with status `FOUND`, `DOCUMENTS_READY`, `FORM_FILLED`, `SAVED` or `INCOMPLETE` (not `APPLIED`, `SKIPPED` or `ERROR`, and not older than the search's date range). That call fetches the **next** page rather than page 1 again, and stops once the provider runs out of pages or `SEARCH_CACHE_MAX_PAGES` is reached. When the entry expires, the next run starts again from page 1 to pick up new postings.
  - **Fraud and match ratings** are cached in `evaluation_cache` and shared across users and re-runs, so a posting is only rated once. Fraud results last `FRAUD_CACHE_TTL_DAYS` (default 14), match results `MATCH_CACHE_TTL_DAYS` (default 30). Editing a base resume, a `SKILL.md`, a `shared-references` file, `fraud.py` or `match.py` invalidates the affected ratings straight away. Change `EVALUATION_CACHE_VERSION` to discard all of them (for example after switching AI models).
  - **Clean-up:** `purgeExpiredCaches()` in `src/services/evaluationCache.service.ts` deletes expired rows. Expired rows are ignored either way.
- **Costs.** Each new job uses a share of one JSearch request, one Claude fraud call (with up to `FRAUD_MAX_SEARCHES` web searches at about $0.01 each), one Claude match call unless the fraud rating is 80 or more, and two Claude calls for the resume and cover letter if it passes your limits. Cached searches and ratings cost nothing. Use `jobsPerSearch` / `pagesPerSearch`, `minMatchRating` and the `AI_EFFORT_*` settings to control spending.
- **Audit logs** record requests, responses, API calls, AI calls, auto-fill events and errors. Passwords, tokens, API keys and cookies are replaced with `[REDACTED]` before they're saved.

---

## Accounts, documents and saved jobs

- **Sessions.** Every login creates a row in `sessions`, and the login token carries its id. Each request checks the session is still active.
  - **Sign-out is per session:** `POST /api/auth/logout` ends only that session, so your other devices and other users stay signed in.
  - **Password changes:** changing your password signs out your other devices. A reset signs out all of them.
  - **After upgrading,** tokens issued before sessions existed stop working, so everyone signs in once more.
- **Password reset.** `POST /api/auth/password-reset/request` creates a one-time link that expires after `PASSWORD_RESET_TTL_MINUTES`. Only a hash of it is stored.
  - **There's no email sender yet.** Outside production, the link (`PASSWORD_RESET_URL`) is written to the API log. Connect your email provider in `deliverResetLink()` in `src/services/password.service.ts` before relying on it in production.
  - **Requests are limited** to 3 per email address and 10 per IP address every 15 minutes.
- **On-demand search** (`POST /api/jobs/search`) uses the same search cache and API fallback as saved searches.
  - **Every returned job is saved as your job** (status `FOUND`), so it has an id you can save, apply to and make documents for.
  - **New jobs are rated in the background** (fraud first, then match). Their ratings are `null` in the reply and show up in `GET /api/jobs/:id` once ready. Send `"evaluate": false` to skip rating.
  - **Blacklisted companies** are left out.
- **"All time" and "Permanent".**
  - **`datePosted: "ALL_TIME"`** asks JSearch for jobs of any age (`date_posted=all`) and skips the age filter.
  - **`PERMANENT`** asks JSearch for full-time and part-time jobs, then keeps the ones whose posting says "permanent" (not "temp-to-perm" or "non-permanent"). A job whose type isn't stated but whose text says "permanent" is stored as `PERMANENT`.
  - **Jobs that don't state their type** still pass every employment-type filter, as before.
- **Saved and applied lists** live on the server, per user.
  - **Saving is separate from the status:** saving a job sets `applications.savedAt`, so a saved job stays saved when its documents are made.
  - **Applied jobs** leave the saved list.
- **Documents.**
  - **Uploads** go to `UPLOAD_DIR/<userId>/<jobId>/` (git-ignored) and replace the job's resume or cover letter link, so auto-fill uses your file. The file's content is checked against its extension.
  - **Previews:** `.docx` and `.txt` files get text previews. PDFs come with `mimeType` and a link for the frontend to show.
  - **Links** are signed and short-lived, so they work in `<a>` and `<iframe>` tags without the login header.

## Tracking spending

- **AI tokens are recorded automatically.** Every Claude call (fraud rating, match rating, resume, cover letter, form answers) adds a row to `ai_token_usage`.
  - **The Python service reports the usage** of each call to the Node API, including calls made before an error, so failed attempts are counted too.
  - **Ratings reused from the evaluation cache** make no AI call, so they add no row.
- **Costs are estimates** from `ai_model_prices`. The migration starts it with list prices for Opus 5.5, Sonnet 5.5 and Haiku 5.5. Haiku's cache-read price is an assumption, so check it on the pricing page.
  - **When prices change,** add a row with a later `effectiveFrom`. Older usage keeps the price it was recorded with.
  - **Your Anthropic invoice is the final amount.**
- **Search credits are recorded automatically** in `search_api_usage`: JSearch bills one request per page, SerpApi one search per page. Failed requests are logged with 0 credits.
- **Payments are entered by you.**
  1. The migration adds the three APIs the app uses (Claude, JSearch, SerpApi) to `api_services`. Fill in your plan, cost and included units, e.g. `PATCH /api/spending/services/:id {"planName":"Pro","cost":25,"includedUnits":10000}`.
  2. Add a payment: `POST /api/spending/payments {"serviceId":"…","amount":25,"billingPeriod":"MONTHLY","periodStart":"2026-11-01","periodEnd":"2026-11-30"}`.
  3. Fill in the date when you pay: `PATCH /api/spending/payments/:id {"datePaid":"2026-11-14"}`. `GET /api/spending/payments?unpaid=true` lists the ones still to pay.
- **Budgets** (`POST /api/spending/budgets {"name":"Claude","serviceId":"…","monthlyLimitUsd":20}`) only warn: `/api/spending/summary` shows the percentage used, `warning` and `overLimit`. Nothing is blocked.
  - **What counts against a budget:** payments covering the month, plus, for the Claude service, the month's estimated token cost when no payment is entered yet.

## Customising the app

| What to change | Where |
|---|---|
| How resumes are tailored (tone, keyword placement, which sections change) | Edit the repo's `.agents/skills/*-resume-guidance/SKILL.md` and `shared-references/*.md`. No code changes needed. |
| Base resume used for each track | Update the `resumes/base resumes/...docx` path in that track's `SKILL.md`. The app reads the path from there and otherwise falls back to the highest version number. |
| Extended skills lists | `shared-references/*-skills-and-tools.md` |
| Fraud check rules | `.agents/skills/job-post-evaluation/SKILL.md` (for you and agents) and `python-service/app/fraud.py` (`RULES`, `TEXT_PATTERNS`, `POINTS`, `KNOWN_SITES`) for the app |
| Match rating rules | The same skill and `python-service/app/match.py` (`RULES`, `score()`) |
| Turn the LinkedIn web search on or off | `FRAUD_WEB_SEARCH` and `FRAUD_MAX_SEARCHES` in `python-service/.env` |
| Where the application log is written | `APPLICATION_LOG_PATH` (Excel) and `APPLICATION_LEDGER_PATH` (SQLite ledger) in `.env` |
| Claude model and effort | `python-service/.env`: `AI_MODEL` (default), `AI_MODEL_FRAUD` / `AI_EFFORT_FRAUD`, `AI_MODEL_MATCH` / `AI_EFFORT_MATCH`, `AI_EFFORT_DOCUMENTS`, `AI_EFFORT_ANSWERS` |
| Cover letter style | The `cover_letter()` prompt in `python-service/app/ai.py` |
| Cover letter header and layout | `write_cover_letter()` in `python-service/app/documents.py`. The header (name and contact line) is copied from the tailored resume, so editing your base resume's header changes it in every new letter. The code always adds the date, recipient block, `Re:` line, greeting and signature; the AI writes only the body. |
| Where resumes and cover letters are saved | `APPLICATION_DOCS_DIR` in `python-service/.env` (default: `application-docs/{YYYY-MM-DD}/{position} - {company} - {ids}/`) |
| Answers to common questions (relocation, pronouns, etc.) | `extraAnswers` in your profile, or `PUT /api/answers/:id` |
| Which job sites count | `websites` in each search (`LINKEDIN`, `GLASSDOOR`, `INDEED`, `COMPANY_SITE`, `OTHER`) |
| Match and fraud limits | `minMatchRating` / `maxFraudRating` in each search |
| Prefer LinkedIn/Glassdoor links over company sites | Set `PREFER_DIRECT_APPLY=false` in `.env` |
| Search and rating cache lifetimes, refresh threshold | `SEARCH_CACHE_TTL_HOURS`, `SEARCH_REFRESH_THRESHOLD`, `SEARCH_CACHE_MAX_PAGES`, `FRAUD_CACHE_TTL_DAYS`, `MATCH_CACHE_TTL_DAYS`, `EVALUATION_CACHE_VERSION` in `.env` |
| How long the filler watches a form | `AUTOFILL_WATCH_MINUTES` in `.env` |
| Fields filled from your profile | The `RULES` list in `src/autofill/profileMapper.ts` |
| Words that mean the application was submitted | `SUBMITTED_TEXT` in `src/autofill/autofill.service.ts` |
| Adding another search provider | Write a provider in `src/services/search/` that returns a `ProviderPage` and add it to `fetchFrom()` / `fetchWithFallback()` in `jobSearch.service.ts` |

---

## Database schema

### Tables

| Table | Purpose |
|---|---|
| `users` | `id` (the user ID), first name, last name, email, password hash, `credentials` (encrypted JSON of LinkedIn / Glassdoor / Indeed logins), timestamps |
| `sessions` | One row per sign-in: user, browser (user agent), IP address, last used, expiry, `revokedAt` (set on sign-out) |
| `password_reset_tokens` | Reset links: user, SHA-256 hash of the token, expiry, `usedAt`, requesting IP |
| `user_profiles` | One per user: phone, address, links, work authorisation, salary, notice period, extra answers. This is the data used to fill forms. |
| `user_settings` | One per user: `jobsPerSearch` (default 10) and `pagesPerSearch` (default 1). Created with the defaults the first time it's read. |
| `search_criteria` | Saved searches and filters per user: query, location, posted within (past week, 2 weeks or month), job and location types, sites, include/exclude keywords, minimum salary, match/fraud limits, optional `maxResults` override |
| `companies` | Name, head office location (optional), website link, timestamps. Shared by all users. |
| `blacklisted` | One row per user per company that user never wants to apply to: `userId`, `companyId`, `createdAt`, `updatedAt`. Unique on (`userId`, `companyId`). |
| `job_postings` | One row per posting, shared by every user who finds it: `externalId` (unique), provider, hiring company (`companyId` + `companyName`), position name, description, location, job type, location type, salary, `postedAt` (exact posting date), fraud rating with reason, details and `fraudEvaluatedAt` |
| `job_apply_options` | Every apply link for a posting: publisher, URL, whether it's the company's own page, job board. Unique on (`postingId`, `url`). |
| `applications` | One user's application to one posting (the API calls these "jobs"): `userId`, `postingId`, the search that found it, the chosen apply link (`applyOptionId`), the job board it was found on (`searchWebsite`), match rating with reason and details, application status, status message, application date, `savedAt` (saved jobs list), timestamps. Unique on (`userId`, `postingId`). Saved, applied and every other status live here. |
| `application_status_events` | Every status change of an application (from, to, message, when). Rows are never edited. |
| `application_files` | Related job, resume link, cover letter link (both default to the AI versions and can be changed), timestamps |
| `application_answers` | Saved answers to form questions per user, so the AI is asked each question once and your corrections are reused |
| `search_cache` | Search API results shared by all users, keyed by the normalised search parameters: cached jobs, pages fetched, next-page token, whether the provider has run out, API call and hit counts, expiry |
| `evaluation_cache` | Fraud and match results shared by all users, keyed by the posting (plus preferred resume track for match) and a fingerprint of the rules and resume files, with an expiry |
| `audit_logs` | HTTP requests and responses, external API calls, AI calls, auto-fill events, errors |
| `ai_token_usage` | One row per Claude call: model that answered, input / output / cache-write / cache-read tokens, web searches, what it was for (`action`: fraud rating, match rating, resume tailoring, cover letter, form answers), when (`usedAt`), estimated cost, the job it was for, fallback flag. Rows are never edited. |
| `api_services` | The paid APIs: name, kind (AI, job search, other), plan, cost, billing period (per request, per month, per year, pay-as-you-go, ...), included units |
| `api_payments` | Money paid per service: amount, billing period, period covered, `datePaid` (you enter it), invoice reference |
| `ai_model_prices` *(suggested)* | Claude prices per million tokens and per 1,000 web searches, with the date they apply from |
| `search_api_usage` *(suggested)* | One row per JSearch / SerpApi request: credits used, results, status. Rows are never edited. |
| `spending_budgets` *(suggested)* | Monthly limit per service, per kind of API or overall, with a warning percentage |

Every table has `createdAt` and `updatedAt`, except `audit_logs`, `ai_token_usage` and `search_api_usage`. Their rows are never edited, so they only record when they happened (`createdAt` or `usedAt`).

### What happens when a user or company is deleted

| Deleted | `blacklisted` rows | `applications` / `job_postings` rows | Other rows |
|---|---|---|---|
| A user (`DELETE /api/users/me`) | That user's rows are deleted | Applications **kept**, with `userId` set to `NULL`; postings are untouched | Profile, saved searches and saved answers are deleted; audit logs are kept with `userId` set to `NULL` |
| A company (`DELETE /api/companies/:id`) | Every user's row for that company is deleted | Postings **kept**, with `companyId` set to `NULL`. `job_postings.companyName` still shows who was hiring. | None |

The database enforces this with foreign keys (`ON DELETE CASCADE` on `blacklisted`, `ON DELETE SET NULL` on `applications.userId` and `job_postings.companyId`), so it also applies when rows are deleted outside the app, for example in Prisma Studio. An application with no `userId` no longer appears in anyone's job list; it stays only as history. `application_files` and `application_status_events` rows stay with their application. A posting can't be deleted while an application points at it (`ON DELETE RESTRICT`).

### Suggestions made in this schema, and why

1. **Separate login data from form data.** Things like phone, address and work authorisation go in `user_profiles`, not `users`. Login data and form answers change at different times, and auth code shouldn't load data it doesn't need.
2. **Encrypt `users.credentials`.** Job-site passwords are stored with AES-256-GCM, never as plain JSON. A better long-term option is to not store passwords at all and rely on the saved browser profile (option 1 above). You could then remove the column.
3. **Add a `search_criteria` table.** The job criteria and filters need somewhere to live, and each application records which search found it (`applications.searchCriteriaId`).
4. **Postings and applications in separate tables (third normal form).** The old single `jobs` table was keyed on (`userId`, `externalId`), but the title, description, salary and fraud rating depend on the posting alone. That is a partial dependency (it breaks 2NF, so also 3NF): the same posting was copied once per user, and the copies could disagree. Now `job_postings` holds posting facts once (key `externalId`) and `applications` holds what belongs to one user's application (key `userId` + `postingId`).
5. **Unique (`userId`, `postingId`) on `applications` and unique `externalId` on `job_postings`.** These stop the same posting, or the same user's application to it, being saved twice when a search runs again.
6. **Statuses stay in one table, not "saved" and "applied" tables.** Status is a column that changes. Separate tables per status would turn every status change into a delete + insert, break the unique key above and the `application_files` foreign key, and need `UNION`s for the job list. `application_status_events` keeps the history instead, and partial indexes or views can be added if one status needs its own fast list.
7. **`job_postings.postedAt` instead of a "posted within" column.** A stored bucket goes stale: a job "posted this week" is two weeks old next week. The search filter checks the exact date instead.
8. **`job_postings.companyName`.** The company name exactly as the posting shows it. It's a fact about the posting, not a copy of `companies.name` (which is the de-duplicated company, e.g. "ACME" for "Acme Inc."), and it keeps showing who was hiring if the company row is deleted.
9. **Where each column lives.** On `job_postings`: `description` (needed for AI scoring and documents), salary fields, `provider` (JSearch or SerpApi), and the fraud rating with `fraudReason` / `fraudDetails`, because fraud is judged from the posting alone. On `job_apply_options`: every apply link, one row each (no JSON list). On `applications`: the match rating with `matchReason` / `matchDetails` (it depends on the user's preferred resume track), `searchWebsite` (the board this user found it on, which isn't always the apply link's site), `statusMessage` and `applicationDate`. The application link is no longer stored separately; it's the URL of `applyOptionId`. `matchRating` stays empty when the fraud rating is 80 or more.
10. **Extra statuses:** `SKIPPED` (filtered out), `DOCUMENTS_READY` and `FORM_FILLED` (waiting for you to submit), alongside `FOUND`, `INCOMPLETE`, `ERROR`, `SAVED` and `APPLIED`.
11. **Extra columns on `application_files`:** `aiResumeLink` and `aiCoverLetterLink` keep the AI originals so you can switch back, and `baseResumeCategory` and `keywordsUsed` record how each resume was tailored.
12. **`companies.normalizedName` (unique).** "Acme Inc." and "ACME" become one company, so a blacklist applies to all of its jobs.
13. **Audit log upkeep:** the table grows fast. Add a scheduled cleanup, e.g. delete `HTTP_REQUEST`/`HTTP_RESPONSE` rows older than 30 days.
14. **`user_settings` as its own table, not a JSON column on `users`.** Each setting gets a type, a database default and a range check; adding a setting is a normal migration; and auth code that loads `users` doesn't pull settings along. A JSON column would avoid migrations, but defaults and validation would live only in code.
15. **`search_cache` and `evaluation_cache`.** Search results and AI ratings don't depend on who asked, so sharing them across users cuts API and AI spending. They're in Postgres (no Redis needed) so they survive restarts.
