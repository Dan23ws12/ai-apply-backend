---
name: software-developer-resume-guidance
description: >-
  Generates an ATS-friendly Microsoft Word resume for software developer, software engineer, fullstack developer, frontend developer, backend developer, mobile app developer and similar roles. Use when the user asks to generate an ATS-friendly resume for a
  position and company, supplies keywords, and includes a job posting link.
metadata:
  author: Daniel Oyeleye
  version: "2.0"
---

# Prompt Template and Output

Generate a new `.docx` resume. Do not edit an existing application resume unless the user asks to revise that file.

Requests usually look like this:

```
Generate an ATS friendly resume that fits the attached job description for a __position__ at __company__
Add the following keywords to the resume: __list_of_keywords__
job posting: __job_website__
```

`__position__` is the role being applied for. `__company__` is the hiring company, government, or recruitment agency. `__list_of_keywords__` is the keyword list to fit to the posting. `__job_website__` is the page with the position name, duties, and qualifications.

## Output

Save the file at:

`application-docs/{position} - {company} - {id}/Resume.docx`

Use the position and company from the request, plus an id you can search on the job site (Indeed `jk`, LinkedIn job id, or Glassdoor `jobListingId`). Example: `application-docs/Business Intelligence Analyst - OpenCircle Contractors Association - indeed-abc123def4567890/Resume.docx`.

Replace `Resume.docx` in that folder when regenerating the same position, company, and id. Never modify `resumes/base resumes/software_developer_resume v2.2.0.docx`.

## Before writing

1. Take `__position__`, `__company__`, `__list_of_keywords__`, and `__job_website__` from the request. If one is missing, ask for it and stop.
2. Open `__job_website__` and extract the position name, duties, and required qualifications. If the page cannot be read, ask the user to paste that text and stop.
3. Rank keywords. Put user-supplied keywords first. Then add repeated duties and qualification terms from the posting, highest frequency and strongest requirement first. Keep exact phrases from the posting when they match work already on the base resume.
4. Read [shared-references/format.md](../../../shared-references/format.md) for format and tone, and [shared-references/skill-positional-guidance.md](../../../shared-references/skill-positional-guidance.md) for which section each skill belongs in. Follow those files.
5. Read the text of `resumes/base resumes/software_developer_resume v2.2.0.docx` and [shared-references/software-related-skills-and-tools.md](../../../shared-references/software-related-skills-and-tools.md) before drafting. Use `shared-references/software-related-skills-and-tools.md` as the extended list of job-related skills and tools.

## Build the document

Copy the base `.docx` and edit that copy. Replace paragraph text in place so alignment, bullet numbering, and section order stay as they are. Clone an existing bullet paragraph in the same job when a bullet must be added. Do not rebuild the resume with tables, text boxes, columns, images, or content in headers or footers.

Keep these lines identical to the base resume:

- Name and contact line
- Employer names and dates
- Job titles under each employer
- Education block
- Certification line

Tailor only the professional summary, the technical-skills lines, and the experience bullets.

Give **professional experience** more weight on work typical of a software developer:

- Writing code that adhere to coding principles and standards
- Building and testing applications
- Collaborating with with other team members using Git and Github
- Creating API endpoints, API integration, and handling HTTP requests and responses

Lead bullets with those actions. Keep requirements gathering and other general business-analyst work only when the posting asks for it, and give it less space than analysis, reporting, and communication.

## Keywords and facts


A higher-ranked keyword may appear in more than one bullet. Place keywords in `__list_of_keywords__`, and higher-ranked posting keywords as specified in `shared-references/skill-positional-guidance.md`.

Use only employers, dates, and outcomes that appear in the base resume. Do not invent metrics, certifications, or duties. If a requested keyword cannot be added without inventing experience, leave it out.

## Reply

After the file is saved, report:

- The saved path
- The ranked keywords that were added
- Any requested keywords left out, and the reason
