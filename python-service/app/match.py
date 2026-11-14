"""
Job match rating (job-post-evaluation skill, "Job match rating").

Hybrid:
  AI call -> judgments only (track, item evidence, duty coverage, job relevance,
             degree/certification/seniority facts, keywords to add)
  script  -> reads job dates from the resume, counts months, applies the skill's
             40/30/10/10/10 weights, caps and rounding

This module never receives fraud findings, so the fraud check cannot influence the match.
The cached system prompt (rules + all base resumes + skills lists) is identical for every
call, so after the first call it is billed at the cache-read rate.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from datetime import date
from typing import Literal

import anthropic
from docx import Document
from pydantic import BaseModel, Field

from . import references as refs
from . import usage
from .documents import analyse

# ───────────────────────── resume facts (script) ─────────────────────────

MONTHS = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august",
     "september", "october", "november", "december"], start=1)}
DATE_RANGE = re.compile(
    r"([A-Za-z]+)\s+(\d{4})\s*[–—\-�]+\s*(?:([A-Za-z]+)\s+(\d{4})|(Present|Current|Now))", re.I)


@dataclass
class ResumeJob:
    id: str
    title: str
    start: tuple[int, int]
    end: tuple[int, int]
    bullets: list[str] = field(default_factory=list)


def _ym(month: str, year: str) -> tuple[int, int]:
    """("March", "2026") or ("Sept", "2019") -> (2026, 3)."""
    prefix = month.lower()[:3]
    return int(year), next(num for name, num in MONTHS.items() if name.startswith(prefix))


def resume_jobs(category: str, today: date | None = None) -> list[ResumeJob]:
    """Job title lines with a date range inside the experience section."""
    today = today or date.today()
    doc = Document(str(refs.load_category(category).base_resume))
    jobs: list[ResumeJob] = []
    for info in analyse(doc):
        if "EXPERIENCE" not in info.section:
            continue
        text = info.paragraph.text
        if info.kind == "bullet":
            if jobs:
                jobs[-1].bullets.append(text.strip())
            continue
        m = DATE_RANGE.search(text)
        if not m:
            continue
        start = _ym(m.group(1), m.group(2))
        end = (today.year, today.month) if m.group(5) else _ym(m.group(3), m.group(4))
        title = re.sub(r"\s+", " ", text[: m.start()]).strip(" ,|\t")
        jobs.append(ResumeJob(f"J{len(jobs) + 1}", title, start, end))
    return jobs


def _months(ranges: list[tuple[tuple[int, int], tuple[int, int]]]) -> set[tuple[int, int]]:
    out: set[tuple[int, int]] = set()
    for (sy, sm), (ey, em) in ranges:
        y, m = sy, sm
        while (y, m) <= (ey, em):
            out.add((y, m))
            y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


# ───────────────────────── AI judgments (structured output) ─────────────────────────

Evidence = Literal["resume", "skills_list", "equivalent", "missing"]


class Item(BaseModel):
    item: str
    evidence: Evidence
    matched_as: str | None = Field(default=None, description="Applicant's term or equivalent used; null when missing")


class Duty(BaseModel):
    duty: str
    coverage: Literal["full", "partial", "none"]


class JobRelevance(BaseModel):
    job_id: str = Field(description="Job id from the chosen track's job list, e.g. J1")
    relevance: Literal["full", "half", "none"]


class Judgments(BaseModel):
    track: Literal["software_developer", "data_analyst", "business_analyst", "non_it"]
    no_track_fits: bool
    required_items: list[Item]
    preferred_items: list[Item] = Field(description="Preferred skills/tools only; no certifications")
    duties: list[Duty]
    job_relevance: list[JobRelevance]
    required_years: float | None = Field(description="Lower bound of required years; null if not stated")
    degree: Literal["meets_or_none_required", "related_and_posting_allows_related", "related_only", "missing"]
    certifications: Literal["none_named_or_all_held", "only_preferred_missing", "required_missing"]
    posting_level: Literal["junior", "intermediate", "senior", "lead", "not_stated"]
    unmeetable_requirements: list[str] = Field(description="Licences, designations, clearances, citizenship, languages the applicant cannot meet")
    keywords_to_add: list[str] = Field(description="Up to 10 posting keywords to add when tailoring, strongest first, only ones the applicant can honestly claim")
    summary: str = Field(description="Two or three short sentences on the main strengths and gaps")


RULES = """You judge how well one job posting fits one applicant. A program computes the final scores
from your judgments, so judge carefully and do NOT compute any scores yourself.

TRACK: choose the base resume whose track fits the posting's title and main duties:
software_developer (software/web/mobile/API developers and engineers), data_analyst
(data/reporting analysts, data engineers, analytics engineers), business_analyst (business,
BI, Power BI, systems, product analysts), non_it (admin, office, customer service, sales,
data entry). Set no_track_fits=true for fields no track covers (nursing, law, trades,
teaching) and use non_it.

ITEMS (required_items from required qualifications + duties; preferred_items from
nice-to-have/asset/preferred items, without certifications):
- One item per distinct skill, tool, language, method or domain keyword. "Git/GitHub" = 2
  items. "AWS (S3, Glue)" = S3 and Glue; add AWS only if asked for on its own. A single
  example in parentheses is one item ("infrastructure as code (Terraform)" = Terraform).
- Each item once. An item that is both required and marked preferred is required.
- Leave out soft skills, leadership/mentoring, degrees, licences, certifications, years.
- evidence (highest that applies, judged against the CHOSEN track's resume and lists):
  resume = on that base resume (any section); skills_list = in that track's extended list
  or the shared list; equivalent = a different tool doing the same job (Tableau/Power BI,
  MySQL/PostgreSQL, Vue/React, Azure/AWS, Azure Data Factory/Airflow) or a list category
  that clearly includes it; missing = none of these.

DUTIES: list the 4-8 main duties (include leadership duties). coverage = full / partial /
none depending on whether ANY bullet on the chosen resume shows that kind of work.

JOB RELEVANCE: for every job in the chosen track's job list, judged against THIS posting's
duties: full = at least half its bullets show that work (a job with 1-2 bullets needs all
of them); half = at least one such bullet; none = otherwise.

DEGREE: meets_or_none_required / related_and_posting_allows_related (posting says "or
related"; a minor in the asked field counts as related) / related_only / missing.
CERTIFICATIONS: none_named_or_all_held / only_preferred_missing / required_missing.
POSTING LEVEL: from the title (junior, intermediate, senior, lead/principal/staff/manager/
director/head); not_stated if the title has none.


KEYWORDS: up to 10 posting keywords worth adding when tailoring the resume, strongest
first, only ones the applicant can honestly claim.

Do not consider whether the posting might be fake: another check handles that."""


def build_system() -> list[dict]:
    parts = [RULES, "\n\n# Applicant materials\n"]
    for c in refs.CATEGORIES:
        ref = refs.load_category(c)
        jobs = "\n".join(f"{j.id}: {j.title} ({j.start[1]}/{j.start[0]} - {j.end[1]}/{j.end[0]}), {len(j.bullets)} bullets"
                         for j in resume_jobs(c))
        parts.append(
            f'\n<track name="{c}">\n<base_resume>\n{ref.base_resume_text}\n</base_resume>\n'
            f"<job_list>\n{jobs or '(none)'}\n</job_list>\n"
            f"<extended_skills_list>\n{ref.extended_skills}\n</extended_skills_list>\n</track>\n"
        )
    shared = (refs.settings.root / "shared-references" / "shared_skills_and_tools.md").read_text(encoding="utf-8")
    parts.append(f"\n<shared_skills_list>\n{shared}\n</shared_skills_list>")
    return [{"type": "text", "text": "".join(parts), "cache_control": {"type": "ephemeral"}}]


# ───────────────────────── scoring (script) ─────────────────────────

CREDIT = {"resume": 1.0, "skills_list": 0.75, "equivalent": 0.5, "missing": 0.0}
LEVELS = ["junior", "intermediate", "senior", "lead"]


def _coverage(items: list[Item]) -> float | None:
    return sum(CREDIT[i.evidence] for i in items) / len(items) if items else None


def _level_from_years(years: float) -> int:
    return 0 if years < 2 else 1 if years < 5 else 2 if years < 8 else 3


def score(j: Judgments, today: date | None = None) -> dict:
    jobs = {job.id: job for job in resume_jobs(j.track, today)}
    rel = {r.job_id: r.relevance for r in j.job_relevance}

    a_cov = _coverage(j.required_items) or 0.0
    a = 40 * a_cov

    full = _months([(jobs[k].start, jobs[k].end) for k in jobs if rel.get(k) == "full"])
    half = _months([(jobs[k].start, jobs[k].end) for k in jobs if rel.get(k) == "half"]) - full
    relevant_years = (len(full) + len(half) / 2) / 12
    if not j.required_years or relevant_years >= j.required_years:
        years_pts = 15.0
    else:
        years_pts = 15 * relevant_years / j.required_years
    duty_val = {"full": 1, "partial": 0.5, "none": 0}
    duties_pts = 15 * sum(duty_val[d.coverage] for d in j.duties) / len(j.duties) if j.duties else 15.0
    b = years_pts + duties_pts

    c_cov = _coverage(j.preferred_items)
    c = 10 * (c_cov if c_cov is not None else a_cov)

    d = {"meets_or_none_required": 6, "related_and_posting_allows_related": 6, "related_only": 3, "missing": 0}[j.degree]
    d += {"none_named_or_all_held": 4, "only_preferred_missing": 2, "required_missing": 0}[j.certifications]

    total_years = len(_months([(x.start, x.end) for x in jobs.values()])) / 12
    applicant_level = _level_from_years(total_years)
    if j.posting_level == "not_stated":
        posting_level = _level_from_years(j.required_years) if j.required_years else 1
    else:
        posting_level = LEVELS.index(j.posting_level)
    gap = posting_level - applicant_level
    e = 0.0 if j.no_track_fits else 10.0 if gap <= 0 else 5.0 if gap == 1 else 0.0

    raw = a + b + c + d + e
    caps = []
    if j.unmeetable_requirements:
        caps.append(40)
    if j.required_years and relevant_years < j.required_years / 2:
        caps.append(55)
    if a_cov < 0.5:
        caps.append(50)
    final = min([raw] + caps)
    match = max(1, min(100, round(final)))

    return {
        "match_rating": match,
        "parts": {"A": round(a, 1), "B": round(b, 1), "C": round(c, 1), "D": d, "E": e},
        "caps": caps,
        "relevant_years": round(relevant_years, 2),
        "a_coverage": round(a_cov, 2),
    }


# ───────────────────────── the call ─────────────────────────

class MatchRequest(BaseModel):
    title: str
    company: str
    description: str = ""
    location: str | None = None
    preferred_category: Literal["software_developer", "data_analyst", "business_analyst", "non_it"] | None = None


class MatchResult(BaseModel):
    match_rating: int
    resume_category: str
    no_track_fits: bool
    keywords: list[str]
    reasoning: str
    details: dict


_SYSTEM: list[dict] | None = None


def system_prompt() -> list[dict]:
    global _SYSTEM
    if _SYSTEM is None:
        _SYSTEM = build_system()
    return _SYSTEM


def evaluate_match(client: anthropic.Anthropic, req: MatchRequest, *, model: str, effort: str,
                   today: date | None = None, max_tokens: int = 16000) -> MatchResult:
    hint = (f"The applicant prefers the {req.preferred_category} resume; use it if it fits the posting "
            "as well as any other track.\n" if req.preferred_category else "")
    user = (
        f"<position>{req.title}</position>\n<company>{req.company}</company>\n"
        f"<location>{req.location or 'unknown'}</location>\n"
        f"<posting>\n{req.description[:20000]}\n</posting>\n"
        f"{hint}Today's date: {(today or date.today()).isoformat()}"
    )
    started = time.time()
    response = client.messages.parse(
        model=model,
        max_tokens=max_tokens,
        system=system_prompt(),
        messages=[{"role": "user", "content": user}],
        output_config={"effort": effort},
        output_format=Judgments,
    )
    usage.record(response, usage.MATCH_RATING, started)
    if response.stop_reason == "refusal":
        raise RuntimeError("match evaluation was refused")
    if response.parsed_output is None:
        raise RuntimeError(f"match evaluation returned no result (stop_reason={response.stop_reason})")
    j = response.parsed_output
    s = score(j, today)
    u = response.usage
    return MatchResult(
        match_rating=s["match_rating"],
        resume_category=j.track,
        no_track_fits=j.no_track_fits,
        keywords=j.keywords_to_add[:10],
        reasoning=j.summary,
        details={
            **s,
            "required_items": [i.model_dump() for i in j.required_items],
            "preferred_items": [i.model_dump() for i in j.preferred_items],
            "duties": [d.model_dump() for d in j.duties],
            "usage": {"input": u.input_tokens, "output": u.output_tokens,
                      "cache_read": getattr(u, "cache_read_input_tokens", 0) or 0,
                      "cache_write": getattr(u, "cache_creation_input_tokens", 0) or 0},
            "seconds": round(time.time() - started, 1),
        },
    )
