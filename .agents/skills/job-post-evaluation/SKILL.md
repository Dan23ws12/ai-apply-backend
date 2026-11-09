---
name: job-post-evaluation
description: >-
  Rates from 1 to 100 how well a job posting matches the applicant's base
  resume and extended skills lists, scoring keywords, required skills,
  experience, education and seniority. Picks the right base resume for the
  role (software developer, data analyst, business analyst or non-IT). Use when
  the user asks to evaluate, score, rate or match a job posting, or asks
  whether a job is a good fit or worth applying to.
metadata:
  author: Daniel Oyeleye
  version: "1.2"
---

# Job post evaluation

Give one job posting a **match rating from 1 to 100**. A higher rating means the applicant's resume and skills fit the posting better. The rating answers one question: how well does the right base resume, plus the skills the applicant also has, cover what this posting asks for?

This skill only rates. It does not write or edit a resume, and it does not judge whether the posting is fraudulent (use `fraud-likelihood-evaluation` for that).

Requests usually look like this:

```
Evaluate this job posting: __job_website__
```

or the posting text pasted into the message, sometimes with `__position__` and `__company__`.

## Step 1: Get the posting

1. If the user gave a link, open it and extract the position name, company, duties, required qualifications and preferred qualifications. If the page cannot be read, ask the user to paste the posting text and stop.
2. If the user pasted the text, use it as given.
3. Sort every qualification into **required** or **preferred**:
   - Preferred: lines marked nice to have, asset, bonus, plus, preferred or "would be great". Anything inside a required line that is marked preferred (for example "SQL databases (PostgreSQL preferred)") is preferred; the rest of that line stays required.
   - Required: everything else under the requirements or qualifications heading, and all duties.
   - If the same item is both required somewhere (for example in a duty) and marked preferred elsewhere, it is required.

## Step 2: Choose the base resume

Pick the track that best matches the posting's **title and main duties**:

| Track | Typical titles | Resume guide (holds the base resume path) |
|---|---|---|
| Software developer | Software developer or engineer, full stack, frontend, backend, web developer, mobile or app developer, API developer | `.agents/skills/software-developer-resume-guidance/SKILL.md` |
| Data analyst | Data analyst, reporting analyst, data engineer, data architect, analytics engineer, junior data scientist | `.agents/skills/data-analyst-resume-guidance/SKILL.md` |
| Business analyst | Business analyst, business intelligence (BI) analyst or developer, Power BI developer, systems analyst, product or operations analyst | `.agents/skills/business-analyst-resume-guidance/SKILL.md` |
| Non-IT | Administrative or executive assistant, office or customer service roles, sales, data entry, and other roles without a technical focus | `.agents/skills/non-it-resume-guidance/SKILL.md` |

Use the base resume named in that track's resume guide (the `resumes/base resumes/...docx` path in its "Never modify" line). Read the full text of that `.docx`. Never modify it.

- **Two tracks.** If more than a third of the main duties belong to a second track (for example a "Python Developer, Data Platform" role that is half backend coding and half data pipelines), rate the posting against both resumes and report the higher rating. Add a line to the reply giving the other track's rating.
- **No track fits.** If the role is in a field none of the tracks cover (for example nursing, law, skilled trades or teaching), use the Non-IT resume, score as normal, and say "No track fits this role" in the summary.

## Step 3: Read the skills lists

Read both of these files:

1. The extended skills list for the track:

   | Track | Extended skills list |
   |---|---|
   | Software developer | `shared-references/software-related-skills-and-tools.md` |
   | Data analyst | `shared-references/data-related-skills-and-tools.md` |
   | Business analyst | `shared-references/data-related-skills-and-tools.md` |
   | Non-IT | `shared-references/shared_skills_and_tools.md` |

2. The shared list, `shared-references/shared_skills_and_tools.md`, for every track.

Skills in these lists are ones the applicant has but that may not be on the base resume. Text in parentheses is another name for the same item, so "React.js" in a posting matches "React (React.js, ReactJS)".

## Step 4: Score the posting

Score each part below, then add the parts together.

### Building the item lists (Parts A and C)

- **One item per distinct skill, tool, language, method or domain keyword.** Terms joined by a slash, "and" or a comma are separate items when they are different things: "Git/GitHub" is two items (Git, GitHub), "JavaScript/TypeScript" is two items.
- **Named services are separate items.** "AWS (S3, Glue, Redshift)" is three items: S3, Glue, Redshift. Add the umbrella term (AWS) as its own item only when the posting also asks for it on its own (for example "Strong AWS experience").
- **A single example in parentheses is one item.** "Infrastructure as code (Terraform)" is one item: Terraform.
- **Count each item once**, even if the posting repeats it. Repetition never adds weight.
- **Leave out of Parts A and C:**
  - General soft skills: communication, teamwork, collaboration, time management, problem-solving, attention to detail, organisation. Leave them out even when they are listed as requirements.
  - Leadership and mentoring duties. Score them in Part B (duties) instead.
  - Degrees, licences, professional designations and certifications. Score them in Part D.
  - Years of experience. Score them in Part B.
- **Ignore level words** such as expert, strong, advanced or production experience. Score the skill itself. Level is covered by Part B (years) and Part E (seniority).

### How much credit each item gets

Give each item the **highest** credit that applies:

| Where the applicant shows it | Credit |
|---|---|
| On the base resume (any section: summary, skills or experience bullets) | 1.0 |
| In the extended skills list or the shared list | 0.75 |
| A close equivalent is on the resume or in a list | 0.5 |
| Nowhere | 0 |

A **close equivalent** is either:
- a different tool that does the same job (Tableau for Power BI, MySQL for PostgreSQL, Vue for React, Azure for AWS, Azure Data Factory for Airflow or AWS Glue), or
- a category in a list that clearly includes the item (for example "Data warehousing (cloud data warehouses)" for Snowflake or Redshift).

Note each equivalent you use in the reply.

Coverage = total credit ÷ number of items.

### A. Required skills and keywords (40 points)

Build the item list from the **required** qualifications and the duties.

Score = 40 × coverage.

### B. Experience (30 points)

**Years (15 points)**

1. **Pick the relevant jobs** on the base resume, judged against **this posting's** field, not just the track:
   - A job counts **in full** if at least half of its bullets show the kind of work the posting's duties describe. A job with only one or two bullets needs all of them to fit.
   - A job counts at **half** its months if it has at least one such bullet but does not count in full.
   - Otherwise it does not count.
2. **Count months.** Count calendar months from the start month to the end month, including both. "Present" means the current month. Where jobs overlap, count each month once. For example, July 2025 to November 2026 is 17 months.
3. **Score.** Relevant years = months ÷ 12. Compare that to the years the posting requires. With a range such as "3–5 years", use the lower number.
   - No years stated, or the applicant meets them: 15.
   - Below the requirement: 15 × (relevant years ÷ required years).

**Duties (15 points)**

List the posting's main duties (about 4 to 8), including leadership or mentoring duties. For each one, decide whether **any** experience bullet on the base resume shows the same kind of work: 1 for clearly yes, 0.5 for partly or similar, 0 for no. A bullet can count here even when its job did not count toward years.

Score = 15 × (total ÷ number of duties).

### C. Preferred skills (10 points)

Build the item list from the **preferred** qualifications, without certifications (those go in Part D). Score = 10 × coverage.

If the posting has no preferred items, use Part A's coverage: Score = 10 × Part A coverage.

### D. Education and certifications (10 points)

**Degree (6 points)**

| Applicant's degree | Points |
|---|---|
| Meets the posting's level and field, or the posting asks for no degree | 6 |
| Related field, when the posting says "or related field" (a minor in the asked field counts as related) | 6 |
| Related field, when the posting does not say "or related" | 3 |
| A required degree level or field is clearly missing | 0 |

**Certifications (4 points)**

| Situation | Points |
|---|---|
| The posting names no certifications, or the applicant has every one it names | 4 |
| Only preferred certifications are missing | 2 |
| A required certification is missing | 0 |

### E. Role and seniority fit (10 points)

1. **Applicant's level.** Add up all professional experience on the base resume, counting months as in Part B:

   | Total experience | Level |
   |---|---|
   | Under 2 years | Junior / entry |
   | 2 years to under 5 | Intermediate |
   | 5 years to under 8 | Senior |
   | 8 years or more | Lead |

2. **Posting's level.** Take it from the title (junior, intermediate, senior, lead, principal, staff, manager, director, head). With no level in the title, use the required years with the same table. With neither, treat the posting as intermediate.
3. **Score.**
   - 10: same level, or the applicant is above the posting's level.
   - 5: the applicant is one level below.
   - 0: two or more levels below, or no track fits the role (Step 2).

### Caps and the final number

Add A to E. Then check every cap below and use the **lowest** one that applies:

- A required item the applicant cannot meet at all (licence, professional designation, security clearance, a specific citizenship, or a required language they do not speak): **cap at 40**.
- Fewer than half the required years of experience: **cap at 55**.
- Part A coverage below 0.5: **cap at 50**.

Round to a whole number. The lowest rating is 1 and the highest is 100.

### What the rating means

| Rating | Meaning |
|---|---|
| 85–100 | Excellent match. Apply. |
| 70–84 | Strong match. Apply and tailor the resume. |
| 55–69 | Moderate match. Apply if the role is wanted; expect gaps. |
| 40–54 | Weak match. Several requirements are missing. |
| 1–39 | Poor match. Not recommended. |

## Rules

- Use only the base resume, the extended skills list for the track and the shared list as evidence. Do not assume experience, years, degrees or certifications they do not show.
- Give credit for an equivalent only under the close-equivalent rule above.
- If the posting has no clear requirements list, build Part A from the duties and title, and say the posting was vague.
- Score the same way every time: list the items for each part, give each item its credit, then do the arithmetic.

## Reply

Start with the rating, then keep the rest short and in plain words:

- Show each part score to one decimal place. The rating is the rounded total after caps.
- In the caps row, list every cap that applies. Add "(no effect)" when the score was already below it.

```
Match rating: 73/100 (Strong match)
Position: <position> at <company>
Resume used: <track> (<base resume file name>)

| Part | Score | Notes |
|---|---|---|
| A. Required skills and keywords | 31.0/40 | 9.3 of 12 items |
| B. Experience (years + duties) | 21.0/30 | 1.4 of 2 years; 4 of 6 duties |
| C. Preferred skills | 6.0/10 | 2.4 of 4 items |
| D. Education and certifications | 10.0/10 | |
| E. Role and seniority fit | 5.0/10 | Intermediate role, junior applicant |
| Caps applied | none | |

Matched on resume: <Part A and C items with credit 1.0>
Matched from skills lists: <items with credit 0.75> (not on the base resume yet)
Close equivalents: <posting item → applicant's equivalent>
Missing: <items with credit 0, required ones first>

Summary: <two or three sentences on the main strengths and gaps>
Keywords to add when tailoring: <up to 10, strongest first, only ones the applicant can honestly claim>
```

- With no years required, write "no years stated" in the Part B notes.
- With two tracks, add `Other track: <track> scored <rating>` under "Resume used".

"Keywords to add when tailoring" can be passed straight to the matching resume guide skill as `__list_of_keywords__`.
