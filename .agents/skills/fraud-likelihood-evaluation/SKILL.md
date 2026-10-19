---
name: fraud-likelihood-evaluation
description: checks the given websites, evaluates whether the job posting is fraudulent and explain the result. Use when evaluating whether a job is fraudulent
metadata:
    author: Daniel Oyeleye
    version: "1.0"
---
## Goal
- Determine the likelihood that a job posting is false with the given information and explain the reasons why the job posting was given said likelihood

## Steps
1. Accept a company website, name of position, company and job posting page
2. Scrape the job description off the job description website
3. Search for company name on LinkedIn
4. Check if the company name on website and job posting are the same doesn't apply to recruitment agencies
5. Check the validity of the job posting website
6. Evaluate whether the job posting is fraudulent and explain the findings

## Best Practices
- Start by giving the percentage chance that the job posting is fake
- Keep the explanation concise and use simple vocabulary 

