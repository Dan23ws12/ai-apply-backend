# AI Job Apply

AI Job Apply finds jobs that match your search criteria and filters, rates each one for fit and for fraud risk, and writes a tailored resume and cover letter for the good matches. It then opens the application form in a visible browser and fills it in for you.

**The app never submits an application.** It fills in the form, and you check the answers and click **Submit** yourself. This keeps automated actions off your LinkedIn and Glassdoor accounts, which is what gets accounts restricted or banned, and it stops wrong answers from being sent without anyone seeing them.

```
Search criteria ──► JSearch (SerpApi Google Jobs if JSearch fails)
                     │
                     ▼
            Filter: LinkedIn/Glassdoor only, location type, job type,
                    keywords, salary, blacklisted companies, duplicates
                     │
                     ▼
            Claude: match rating + fraud rating ──► below your limits → SKIPPED
                     │
                     ▼
            Claude: tailored resume (.docx) + cover letter (.docx)
                     │
                     ▼
            Playwright opens the apply page and fills it in
                     │
                     ▼
            YOU review and click Submit ──► job marked APPLIED
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
├── .agents/skills/           # Existing resume and fraud-check skills (read by the AI)
├── shared-references/        # Existing format rules and extended skills lists (read by the AI)
├── resumes/
│   ├── base resumes/         # Your base resumes (copied, never changed)
│   └── jb resumes/           # ★ Tailored resumes the app creates: "{position}-{company}.docx"
├── cover-letters/            # ★ Cover letters the app creates: "{position}-{company}.docx"
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
│       ├── main.py           # FastAPI endpoints: /score /documents /answers /health
│       ├── ai.py             # All Claude calls (structured JSON outputs)
│       ├── documents.py      # Edits a copy of the base resume and writes the cover letter
│       ├── references.py     # Loads the repo's resume skills, reference files and base resumes
│       ├── schemas.py        # Pydantic models
│       └── config.py
└── storage/                  # Created at runtime (git-ignored)
    └── browser-profiles/     # Saved browser profile, so you stay logged in
```

Generated documents use the same naming as the resume skills: `{position}-{company}.docx`. Generating documents again for the same position and company replaces both files. Characters Windows doesn't allow in file names (such as `/` or `:`) are replaced with spaces. To save the documents somewhere else, change `RESUME_OUTPUT_DIR` and `COVER_LETTER_OUTPUT_DIR` in `python-service/.env`.

The Python service reuses files that already exist in this repository:

| Repo file | Used for |
|---|---|
| `.agents/skills/*-resume-guidance/SKILL.md` | Rules for tailoring each type of resume |
| `.agents/skills/fraud-likelihood-evaluation/SKILL.md` | Fraud rating instructions |
| `shared-references/format.md`, `skill-positional-guidance.md` | Resume format and where each skill goes |
| `shared-references/*-skills-and-tools.md` | Extended skills lists, used for match ratings and keywords |
| `resumes/base resumes/*.docx` | Base resumes. They're only ever copied, never changed. |

---

## Credentials and API keys you need

| Key | Where to get it | Goes in | Required? |
|---|---|---|---|
| `JSEARCH_API_KEY` | [RapidAPI → JSearch](https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch). Subscribe to a plan (there's a free tier) and copy `X-RapidAPI-Key`. | `.env` | Yes, unless you only use SerpApi |
| `SERPAPI_API_KEY` | [serpapi.com/manage-api-key](https://serpapi.com/manage-api-key) (free tier: 100 searches a month) | `.env` | Recommended as the backup |
| `ANTHROPIC_API_KEY` | [platform.claude.com → API keys](https://platform.claude.com/settings/keys) | `python-service/.env` | Yes |
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

1. **Log in by hand (recommended).** The first time a LinkedIn or Glassdoor page opens in the auto-fill browser, log in yourself. The browser profile is saved in `storage/browser-profiles/<your user id>`, so you stay logged in on later runs.
2. **Save the logins in the app.** They're encrypted with `CREDENTIALS_ENCRYPTION_KEY` before they're stored in `users.credentials`. The API only ever returns *which* sites have a saved login, never the password. When a sign-in page appears, the app fills in the email and password boxes, and **you click Sign in yourself** and complete any 2-step verification.

```http
PUT /api/users/me/credentials
Authorization: Bearer <token>
Content-Type: application/json

{ "linkedin": { "email": "you@example.com", "password": "..." },
  "glassdoor": { "email": "you@example.com", "password": "..." } }
```

`DELETE /api/users/me/credentials` removes them.

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
Fill in `ANTHROPIC_API_KEY` and `PYTHON_SERVICE_TOKEN` (the same token as in `../.env`).

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
| `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me` | Account and login |
| `PATCH /api/users/me` | Change your first or last name |
| `GET/PUT /api/users/me/profile` | Details used to fill application forms |
| `GET/PUT/DELETE /api/users/me/credentials` | Saved LinkedIn/Glassdoor logins (encrypted, never returned) |
| `GET/POST /api/search-criteria`, `GET/PATCH/DELETE /api/search-criteria/:id` | Saved searches |
| `POST /api/search-criteria/:id/run` | Run a search now |
| `GET /api/companies?blacklisted=true&search=`, `POST /api/companies`, `PATCH /api/companies/:id` | Companies. `{"blacklisted":true}` stops all applications to that company. |
| `GET /api/jobs?status=&website=&locationType=&minMatch=&maxFraud=&page=` | Your jobs |
| `GET/PATCH /api/jobs/:id` | Job details. Set the status by hand, e.g. `SAVED`, or `APPLIED` if submission wasn't detected. |
| `POST /api/jobs/:id/score` | Re-rate the match and fraud risk |
| `POST /api/jobs/:id/documents` | Generate or regenerate the resume and cover letter |
| `GET/PATCH /api/jobs/:id/files` | See or change which resume/cover letter the job uses. `null` switches back to the AI version. |
| `GET /api/jobs/:id/files/resume`, `.../files/cover-letter` | Download a document |
| `POST /api/jobs/:id/autofill`, `GET /api/jobs/:id/autofill` | Start auto-fill, or check its status |
| `GET /api/answers`, `PUT /api/answers/:id`, `DELETE /api/answers/:id` | Saved answers to application questions. Correct one once and it's reused every time. |
| `GET /api/audit-logs?type=&requestId=&limit=` | Developer log of your requests and API calls |

---

## Important information

- **You submit, not the app.** The filler only types into fields, picks options and uploads files. It never clicks Next, Submit, Easy Apply or any other button. On multi-step forms, click **Next** yourself and the filler fills each new step within a few seconds.
- **Lower ban risk.** With `PREFER_DIRECT_APPLY=true` (the default), the app opens the company's own careers page when JSearch provides one. That keeps automation off LinkedIn and Glassdoor completely. Easy Apply forms are still filled in your logged-in session, which LinkedIn's terms don't allow, so the risk is lower but not zero.
- **When an application counts as applied.** When a "thank you for applying" or "application submitted" page appears after you submit, the job is marked `APPLIED` with today's date. If that isn't detected, use `PATCH /api/jobs/:id` with `{"applicationStatus":"APPLIED"}`.
- **Check the AI's answers.** Answers the AI wasn't sure about are filled in but not saved for reuse, so look closely at free-text questions. Voluntary demographic questions get the "decline to answer" option when the form has one.
- **The fraud rating is a guide.** It's based only on the posting text, company name and links. The AI doesn't browse the web here. Always check a company before you send personal details.
- **Costs.** Each new job uses one JSearch request, one Claude scoring call, and two Claude calls for the resume and cover letter if it passes your limits. Use `maxResults`, `minMatchRating` and the `AI_EFFORT_*` settings to control spending.
- **Audit logs** record requests, responses, API calls, AI calls, auto-fill events and errors. Passwords, tokens, API keys and cookies are replaced with `[REDACTED]` before they're saved.

---

## Customising the app

| What to change | Where |
|---|---|
| How resumes are tailored (tone, keyword placement, which sections change) | Edit the repo's `.agents/skills/*-resume-guidance/SKILL.md` and `shared-references/*.md`. No code changes needed. |
| Base resume used for each track | Update the `resumes/base resumes/...docx` path in that track's `SKILL.md`. The app reads the path from there and otherwise falls back to the highest version number. |
| Extended skills lists | `shared-references/*-skills-and-tools.md` |
| Fraud check rules | `.agents/skills/fraud-likelihood-evaluation/SKILL.md` and the fraud signs in `python-service/app/ai.py` (`score_job`) |
| Claude model and effort | `python-service/.env`: `AI_MODEL`, `AI_EFFORT_SCORING`, `AI_EFFORT_DOCUMENTS`, `AI_EFFORT_ANSWERS` |
| Cover letter style | The `cover_letter()` prompt in `python-service/app/ai.py` |
| Cover letter header and layout | `write_cover_letter()` in `python-service/app/documents.py`. The header (name and contact line) is copied from the tailored resume, so editing your base resume's header changes it in every new letter. The code always adds the date, recipient block, `Re:` line, greeting and signature; the AI writes only the body. |
| Where resumes and cover letters are saved | `RESUME_OUTPUT_DIR` and `COVER_LETTER_OUTPUT_DIR` in `python-service/.env` (defaults: `resumes/jb resumes` and `cover-letters`) |
| Answers to common questions (relocation, pronouns, etc.) | `extraAnswers` in your profile, or `PUT /api/answers/:id` |
| Which job sites count | `websites` in each search (`LINKEDIN`, `GLASSDOOR`, `INDEED`, `COMPANY_SITE`, `OTHER`) |
| Match and fraud limits | `minMatchRating` / `maxFraudRating` in each search |
| Prefer LinkedIn/Glassdoor links over company sites | Set `PREFER_DIRECT_APPLY=false` in `.env` |
| How long the filler watches a form | `AUTOFILL_WATCH_MINUTES` in `.env` |
| Fields filled from your profile | The `RULES` list in `src/autofill/profileMapper.ts` |
| Words that mean the application was submitted | `SUBMITTED_TEXT` in `src/autofill/autofill.service.ts` |
| Adding another search provider | Write a provider in `src/services/search/` that returns `NormalizedJob[]` and add it to `searchJobs()` |

---

## Database schema

### Tables

| Table | Purpose |
|---|---|
| `users` | First name, last name, email, password hash, `credentials` (encrypted JSON of job-site logins), timestamps |
| `user_profiles` *(suggested)* | Phone, address, links, work authorisation, salary, notice period, extra answers: the data used to fill forms |
| `search_criteria` *(suggested)* | Saved searches and filters: query, location, date range, job and location types, sites, include/exclude keywords, minimum salary, match/fraud limits |
| `companies` | Name, head office location (optional), website link, `blacklisted`, timestamps |
| `jobs` | Position name, hiring company, fraud rating, match rating, location, job type, location type, search website, application status, date posted, created at, application date, application link, plus the extra columns below |
| `application_files` | Related job, resume link, cover letter link (both default to the AI versions and can be changed), timestamps |
| `application_answers` *(suggested)* | Saved answers to form questions, so the AI is asked each question once and your corrections are reused |
| `audit_logs` | HTTP requests and responses, external API calls, AI calls, auto-fill events, errors |

Every table has `createdAt` and `updatedAt`, except `audit_logs`. Log rows are never edited, so it only has `createdAt`.

### Suggestions made in this schema, and why

1. **Separate login data from form data.** Things like phone, address and work authorisation go in `user_profiles`, not `users`. Login data and form answers change at different times, and auth code shouldn't load data it doesn't need.
2. **Encrypt `users.credentials`.** Job-site passwords are stored with AES-256-GCM, never as plain JSON. A better long-term option is to not store passwords at all and rely on the saved browser profile (option 1 above). You could then remove the column.
3. **Add a `search_criteria` table.** The job criteria and filters you wanted need somewhere to live, and each job records which search found it (`jobs.searchCriteriaId`).
4. **Add `jobs.userId`.** Each user has their own job list, because application status, ratings and dates belong to one user's application.
5. **Add `jobs.externalId` with a unique `(userId, externalId)` key.** This stops the same job being saved twice when a search runs again.
6. **Store the exact posting date in `jobs.postedAt`.** `datePosted` (past week, 2 weeks or month) is worked out from it. On its own the bucket goes stale: a job "posted this week" is two weeks old next week. Consider dropping `datePosted` later and computing it when you query.
7. **Add columns to `jobs`:** `description` (needed for AI scoring and documents), `matchReason` and `fraudReason` (explain the ratings), `applyOptions` (every apply link found), salary fields, `provider` (JSearch or SerpApi; this is separate from `searchWebsite`, which is the job board), and `statusMessage` (why a job was skipped or failed).
8. **Add statuses:** `SKIPPED` (filtered out), `DOCUMENTS_READY` and `FORM_FILLED` (waiting for you to submit), alongside `FOUND`, `INCOMPLETE`, `ERROR`, `SAVED` and `APPLIED`.
9. **Add columns to `application_files`:** `aiResumeLink` and `aiCoverLetterLink` keep the AI originals so you can switch back, and `baseResumeCategory` and `keywordsUsed` record how each resume was tailored.
10. **Add a `companies.normalizedName` unique column.** "Acme Inc." and "ACME" become one company, so a blacklist applies to all of its jobs.
11. **Change later if several people share one install:** move `blacklisted` into a `user_company_preferences (userId, companyId, blacklisted)` table, because one person's blacklist shouldn't affect another's.
12. **Audit log upkeep:** the table grows fast. Add a scheduled cleanup, e.g. delete `HTTP_REQUEST`/`HTTP_RESPONSE` rows older than 30 days.
