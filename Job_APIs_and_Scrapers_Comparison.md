# LinkedIn & Glassdoor: APIs and Scrapers for Finding and Applying to Jobs

_Researched 2026-11-09. Prices come from vendor listings, marketplace pages and third-party reviews (several written by competitors), and they change often. Check each vendor's live pricing page and run a small test before you commit._

## Key facts first

- **There is no official public API for job seekers on either site.**
  - **LinkedIn:** the Jobs/Talent APIs (Job Posting API, Apply Connect) are only for approved ATS and recruiting partners on the employer side. You can't use them to search for jobs or submit applications as a candidate.
  - **Glassdoor:** the public API has been discontinued. Glassdoor says it "no longer supports API partnerships", and the old endpoint returns HTTP 410.
- **Every option below is unofficial.** It either scrapes public pages or automates your own logged-in browser session.
- **Terms of service risk:** LinkedIn's User Agreement (Section 8.2) bans bots, scrapers and automation plugins. Scraping public job listings without logging in is lower risk. **Auto-applying from your own logged-in account carries a real risk of restrictions or a ban.** Glassdoor's ToS also prohibit scraping.
- **The safest setup for this project:** use a scraper or aggregator API to *find* jobs, use the resume skills to *tailor* documents, then *submit* the application yourself or with a human-in-the-loop browser assistant.

---

## Part 1: Getting jobs (search and scrape)

| Tool | Type | LinkedIn | Glassdoor | Key features | Pricing (approx.) | Limitations |
|---|---|:-:|:-:|---|---|---|
| **JobSpy** (`python-jobspy`, open source) | Python library | ✅ | ✅ | One call scrapes LinkedIn, Indeed, Glassdoor, ZipRecruiter and Google Jobs at once. Returns a pandas DataFrame or CSV with filters for location, remote, hours old and job type. | **Free** (MIT). You may need proxies at scale. | LinkedIn rate-limits after about 10 pages per IP, so you'll need proxies. Glassdoor blocking is frequent. Fixes depend on the maintainer, and the library breaks when the sites change. |
| **Apify: LinkedIn Jobs Scraper actors** (e.g. hydedata, bebity, thirdwatch, agentx) | Hosted scraper (cloud + REST API) | ✅ | — | No login or cookies needed. Gets title, company, salary, description, applicant count and posted date. Supports scheduling, webhooks, and JSON/CSV export. | About **$0.30–$4.00 per 1,000 jobs**, depending on the actor. Some charge **$29.99/mo + usage**. Apify gives **$5/mo in free credit**. | Quality and upkeep vary by actor, and community actors can be abandoned. Platform compute is billed separately on some actors. |
| **Apify: Glassdoor Jobs Scraper actors** (e.g. cryptosignals, agentx, boncross, inovaflow) | Hosted scraper | — | ✅ | Gets jobs plus salary ranges, company ratings and reviews. Some flag "Easy Apply" jobs. | About **$0.25–$3.90 per 1,000 jobs**. Some don't charge for blocked or expired results. | Glassdoor's login wall and anti-bot measures cause partial results, and coverage varies by country. |
| **Bright Data: Web Scraper API and Datasets** | Enterprise scraper API + ready-made datasets | ✅ | ✅ | Ready-made LinkedIn and Glassdoor job endpoints with built-in proxies and unblocking. Bulk datasets are also available. | Scraper API about **$1.50 per 1K records**. Datasets from about **$2.50 per 1K** (minimum order around $250). Plans from about **$499/mo**. Free tier of about 5K records/mo on some products. | Aimed at enterprises, so it's expensive at low volume. Account verification is required for LinkedIn data. |
| **JSearch** (OpenWeb Ninja, via RapidAPI or Apify) | Aggregator REST API | ✅ (via Google for Jobs) | ✅ (via Google for Jobs) | A single endpoint covers LinkedIn, Glassdoor, Indeed, ZipRecruiter and others. Includes salary estimates and apply links. Simple JSON. | **Free tier: about 200 requests/mo.** Paid plans start around **$25/mo for about 10K requests** (sources conflict). Via Apify: about **$0.75 per 1K requests**. | Data comes from Google for Jobs, so it's not a full copy of each board. Descriptions are sometimes truncated, and you don't get applicant counts or Easy Apply flags. |
| **JobsPipe** | Aggregator job API (has an MCP server) | ✅ | ✅ | Pre-scraped job index with an MCP server for AI agents. | Reported at about **$49/mo for 100K requests** (the vendor's own claim). | Newer vendor, and the figures above are self-reported. Freshness depends on its crawl schedule. |
| **SerpApi: Google Jobs API** | Search-results API | Indirect | Indirect | Structured Google for Jobs results that link to LinkedIn and Glassdoor postings. Very reliable. | Free plan: 100 searches/mo. Paid from about **$75/mo for 5K searches**. | You only get what Google indexes, and it doesn't scrape the boards directly. |
| **DIY: Playwright or Selenium** | Self-built scraper | ✅ | ✅ | Full control, and you can scrape exactly the fields you need. | Free, plus proxy costs (about $5–15/GB for residential proxies). | Highest upkeep: selectors break, plus CAPTCHAs and IP bans. You carry all the ToS risk yourself. |

---

## Part 2: Applying to jobs (automation)

> No official API can submit applications on LinkedIn or Glassdoor. Every tool here drives a browser (usually **your logged-in session**), so all of them carry the ToS and account-ban risk described above.

| Tool | Type | LinkedIn | Glassdoor | Key features | Pricing (approx.) | Limitations |
|---|---|:-:|:-:|---|---|---|
| **Apify: LinkedIn Easy Apply Bot** (sunny_spade) | Hosted bot | ✅ Easy Apply | — | AI filters to skip poor-fit jobs. Fills Easy Apply forms. Runs in the cloud. | About **$200 per 1,000 applications submitted**, plus a Browserbase account. | Needs your LinkedIn session cookie, which carries a high ban risk. Only works on Easy Apply jobs. |
| **Apify: LinkedIn Easy Apply** (giovannibiancia) | Hosted bot | ✅ Easy Apply | — | Automates Easy Apply with your profile. | About **$25/mo + usage**. | Same session and ban risk. Struggles with custom screening questions. |
| **LoopCV** | SaaS auto-apply | ✅ | Partial (via job links / email) | Runs a daily "loop" that finds and applies to jobs across 20–30+ boards. Can email recruiters, and has an analytics dashboard. | **Free plan.** Paid tiers reported at about **$9.99 / $16 / $89 per month** (billed in euros until Sept 2026). | Little control over each application. Quality depends on matching, and mass applications can hurt response rates. |
| **LazyApply** | Chrome extension | ✅ | ❌ (LinkedIn, Indeed, ZipRecruiter) | Bulk one-click applying with daily limits per plan. | About **$99–$999/year** or a one-time lifetime deal (sources conflict). | No Glassdoor support. Mixed reviews on accuracy. Runs in your browser, so it uses your session. |
| **JobEasyApply** | Chrome extension | ✅ Easy Apply | — | Queues and submits Easy Apply jobs, with AI answers to screening questions. | **Free (5–10/day)**. Pro from **$19/mo**, or **$79 lifetime**. | Chrome has to stay open and active. Easy Apply jobs only. |
| **AutoApplyMax** | Chrome extension | ✅ Easy Apply | — | Easy Apply auto-apply on the free plan. | **Free**. Premium **$6.99/mo** or **$49.90 lifetime**. | Easy Apply only, from a small vendor. |
| **ApplyAI Pro** | Chrome extension | ✅ | — | Pay-per-use passes. | From **$2.99 for 100 auto-applies** (day pass). | Short-lived passes and limited track record. |
| **AIHawk / Jobs_Applier_AI_Agent** (open source) | Python + LLM agent | ⚠️ (LinkedIn module removed from the public repo) | — | Uses an LLM to tailor resumes and answer questions. Self-hosted. | **Free**, plus your LLM API costs. | The LinkedIn auto-apply was pulled from the main repo, so forks may be stale. Requires technical setup. |
| **DIY: Playwright + LLM (human-in-the-loop)** | Self-built | ✅ | ✅ | Pre-fills forms with tailored resumes from this project, then **pauses for you to review and click Submit**. | Free, plus LLM costs. | You maintain it. Still automates a logged-in session, but the pause for review lowers both ban risk and bad-application risk. |

---

## Recommendation for this project

1. **Discovery:** use **JobSpy** (free) for prototyping. If you need something reliable that you don't have to maintain, add **JSearch** (free tier, then about $25/mo) or an **Apify** LinkedIn and Glassdoor actor (about $1 per 1K jobs).
2. **Tailoring:** feed the job descriptions into the existing resume skills in this repo.
3. **Applying:** stay **semi-automated**. Open the apply link, pre-fill the form with the tailored resume, and let the user submit. Avoid cloud bots that need your LinkedIn session cookie.

## Sources

- [Apify: LinkedIn Jobs Scraper (hydedata)](https://apify.com/hydedata/linkedin-jobs-scraper) · [bebity](https://apify.com/bebity/linkedin-jobs-scraper) · [thirdwatch](https://apify.com/thirdwatch/linkedin-jobs-scraper)
- [Best LinkedIn Data APIs 2026 (SocialCrawl)](https://www.socialcrawl.dev/blog/best-linkedin-data-apis-2026) · [Apify LinkedIn pricing explained](https://apiserpent.com/blog/apify-linkedin-scraper-pricing-explained)
- [Apify: Glassdoor scrapers (cryptosignals)](https://apify.com/cryptosignals/glassdoor-scraper) · [agentx](https://apify.com/agentx/glassdoor-jobs-scraper) · [boncross](https://apify.com/boncross/glassdoor-jobs)
- [Bright Data: Glassdoor scraper](https://brightdata.com/solutions/web-crawler/glassdoor.md) · [Glassdoor API status (OpenWeb Ninja)](https://www.openwebninja.com/blog/glassdoor-api) · [Glassdoor scraper vs API (JobsPipe)](https://jobspipe.dev/blog/glassdoor-scraper-vs-api)
- [JSearch API](https://openwebninja.com/api/jsearch) · [JSearch on Apify](https://apify.com/openweb-ninja/jsearch) · [Free job APIs 2026 (JobsPipe)](https://jobspipe.dev/blog/free-job-api)
- [Apify: LinkedIn Easy Apply Bot](https://apify.com/sunny_spade/linkedin-easy-apply-bot) · [Apify: Linkedin Easy Apply](https://apify.com/giovannibiancia/linkedin-easy-apply)
- [AutoApplyMax pricing](https://autoapplymax.com/pricing) · [JobEasyApply review](https://www.gappsy.com/tools/jobeasyapply/) · [ApplyAI Pro](https://www.stork.ai/en/applyai-pro)
- [LinkedIn Easy Apply automation risks (Resumly)](https://resumly.ai/best/best-linkedin-easy-apply-automation-tools) · [LinkedIn auto apply safety (Scoutify)](https://scoutify.com/blog/linkedin-auto-apply/)
- [LazyApply review](https://www.loopcv.pro/directory/lazyapply/) · [LoopCV review (Scoutify)](https://scoutify.com/blog/loopcv-review/) · [Auto-apply tools by price](https://blog.loopcv.pro/auto-apply-tools-by-price/)
