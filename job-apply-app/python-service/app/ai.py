"""
All Claude API calls. Each task returns a validated Pydantic object using
structured outputs (client.messages.parse + output_format).
"""

from __future__ import annotations

import json
import logging
from typing import TypeVar

import anthropic
from pydantic import BaseModel

from . import references as refs
from .config import settings
from .schemas import (
    Answers,
    AnswersRequest,
    Applicant,
    CoverLetter,
    Job,
    ResumeEdits,
    ScoreRequest,
    ScoreResult,
)

log = logging.getLogger("ai")
client = anthropic.Anthropic(api_key=settings.anthropic_api_key or None, max_retries=3)

T = TypeVar("T", bound=BaseModel)


class AIError(RuntimeError):
    pass


def _ask(system: list[dict], user: str, output: type[T], effort: str, max_tokens: int = 16000) -> T:
    """One structured-output request. Server-side fallbacks retry a refused request on another model."""
    try:
        response = client.messages.parse(
            model=settings.ai_model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
            output_config={"effort": effort},
            output_format=output,
            extra_headers={"anthropic-beta": "server-side-fallback-2026-07-01"},
            extra_body={"fallbacks": "default"},
        )
    except anthropic.RateLimitError as e:
        raise AIError("Claude API rate limit reached; try again shortly") from e
    except anthropic.APIStatusError as e:
        raise AIError(f"Claude API error {e.status_code}: {e.message}") from e
    except anthropic.APIConnectionError as e:
        raise AIError("Could not reach the Claude API") from e
    except TypeError as e:
        if "authentication" in str(e).lower():
            raise AIError("No Claude credentials found. Set ANTHROPIC_API_KEY in python-service/.env") from e
        raise

    if response.stop_reason == "refusal":
        raise AIError("The model declined this request")
    if response.stop_reason == "max_tokens":
        raise AIError("The model ran out of output tokens")
    if response.parsed_output is None:
        raise AIError("The model returned no structured output")
    log.info("AI %s: in=%s out=%s", output.__name__, response.usage.input_tokens, response.usage.output_tokens)
    return response.parsed_output


def _cached(text: str) -> dict:
    """System block marked for prompt caching (stable text shared across requests)."""
    return {"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}


def _job_block(job: Job) -> str:
    return (
        f"<job>\nPosition: {job.title}\nCompany: {job.company}\n"
        f"Company website: {job.company_website or 'unknown'}\nLocation: {job.location or 'unknown'}\n"
        f"Apply link: {job.apply_url or 'unknown'}\nListed on: {job.publisher or 'unknown'}\n\n"
        f"Description:\n{job.description}\n</job>"
    )


# ───────────────────────────── scoring ─────────────────────────────

def score_job(req: ScoreRequest) -> ScoreResult:
    resumes = "\n\n".join(
        f'<resume category="{c}">\n{refs.load_category(c).base_resume_text}\n</resume>\n'
        f'<extended_skills category="{c}">\n{refs.load_category(c).extended_skills}\n</extended_skills>'
        for c in refs.CATEGORIES
    )
    system = [
        _cached(
            "You screen job postings for one applicant. You have their base resumes (one per career "
            "track) and, for each track, an extended list of skills and tools they also know.\n\n"
            + resumes
            + "\n\n# Fraud check instructions\n" + refs.fraud_skill()
            + "\n\nYou cannot browse the web here, so judge fraud only from the posting text, company "
            "name, website and apply link. Common signs of fraud: payment or equipment purchase requested, "
            "chat-app interviews (Telegram/WhatsApp), personal email domains, vague duties with very high pay, "
            "company name that does not match the website or apply link, urgency pressure, requests for "
            "banking or ID details before an offer. Recruitment agencies are not fraud by themselves."
        )
    ]
    preferred = (
        f"The applicant prefers the '{req.preferred_category}' resume; use it unless it clearly does not fit."
        if req.preferred_category
        else "Choose the resume category that fits this job best."
    )
    user = (
        f"{_job_block(req.job)}\n\n{preferred}\n\n"
        "Return:\n"
        "- resume_category: the base resume to tailor.\n"
        "- match_rating 0-100: how well the posting's duties and requirements match that resume plus its "
        "extended skills list. 80+ strong, 60-79 reasonable, below 60 weak. Penalise hard requirements the "
        "applicant clearly lacks (years, licences, degrees, clearances).\n"
        "- fraud_rating 0-100 and fraud_reason (start with the percentage).\n"
        "- keywords: up to 15 ranked terms from the posting worth adding to the resume, strongest and most "
        "repeated first, only ones the applicant can honestly claim."
    )
    return _ask(system, user, ScoreResult, settings.ai_effort_scoring, max_tokens=4000)


# ───────────────────────────── resume ─────────────────────────────

def resume_edits(category: str, job: Job, keywords: list[str], numbered_resume: str, editable: list[int]) -> ResumeEdits:
    ref = refs.load_category(category)
    system = [
        _cached(
            "You tailor an applicant's existing resume to one job posting by rewriting selected paragraphs. "
            "Follow these rules from the applicant's own resume guide. Ignore its steps about opening files, "
            "file names, asking the user questions, or replying with a report: the program handles those.\n\n"
            f"# Resume guide\n{ref.skill_text}\n\n# Shared rules\n{refs.shared_rules()}\n\n"
            f"# Extended skills and tools list\n{ref.extended_skills}"
        )
    ]
    user = (
        f"{_job_block(job)}\n\n"
        f"<keywords>{json.dumps(keywords)}</keywords>\n\n"
        "<resume>\nEach line is one paragraph: [index] (section, kind) text\n"
        f"{numbered_resume}\n</resume>\n\n"
        f"You may only edit these paragraph indexes: {editable}. Every other paragraph (name, contact, "
        "employers, dates, job titles, education, certifications, headings) must stay exactly as it is.\n"
        "Return edits for the professional summary, the skill lines and the experience bullets you change. "
        "For a skill line keep its label (for example 'Languages:') at the start of new_text. "
        "Use new_bullets only when a job needs an extra bullet to reach four. "
        "Put every tool or keyword that appears in an experience bullet in bold_terms. "
        "Never invent employers, dates, metrics, certifications or duties. Keep the resume to one page."
    )
    return _ask(system, user, ResumeEdits, settings.ai_effort_documents)


# ─────────────────────────── cover letter ───────────────────────────

def cover_letter(category: str, job: Job, applicant: Applicant, resume_text: str) -> CoverLetter:
    system = [
        _cached(
            "You write short, specific cover letters (250-350 words) in plain language. No clichés like "
            "'I am writing to express my interest'. Use only facts from the applicant's resume. "
            "Past tense for past work, no invented metrics. Address the hiring manager by name only if the "
            "posting gives one."
        )
    ]
    user = (
        f"{_job_block(job)}\n\n<resume category=\"{category}\">\n{resume_text}\n</resume>\n\n"
        f"Applicant: {applicant.first_name} {applicant.last_name}. "
        "Write the greeting, 3-4 body paragraphs and the closing word (the name is added by the program)."
    )
    return _ask(system, user, CoverLetter, settings.ai_effort_documents, max_tokens=8000)


# ─────────────────────────── form answers ───────────────────────────

def answer_questions(req: AnswersRequest) -> Answers:
    system = [
        _cached(
            "You fill in job application form fields for an applicant. The applicant reviews every answer "
            "and submits the form themselves.\n"
            "Rules:\n"
            "- Use only the applicant details given. Never invent facts, numbers, licences or experience.\n"
            "- For select/radio questions, answer with the exact text of one option.\n"
            "- Voluntary demographic questions (gender, race, disability, veteran status): choose the "
            "'decline to answer' style option if there is one, and set confident=false.\n"
            "- If the details do not answer the question, return an empty answer with confident=false.\n"
            "- Free-text questions (why this company, describe a project): write 2-4 honest sentences based "
            "on the job and the applicant's background, and set confident=false so the applicant checks it.\n"
            "- Yes/no questions about work authorisation or sponsorship: answer only from the details."
        )
    ]
    applicant = req.applicant.model_dump(exclude_none=True)
    questions = [q.model_dump(exclude_none=True) for q in req.questions]
    user = (
        f"{_job_block(req.job)}\n\n<applicant>\n{json.dumps(applicant, indent=2)}\n</applicant>\n\n"
        f"<questions>\n{json.dumps(questions, indent=2)}\n</questions>\n\n"
        "Return one answer per question id."
    )
    return _ask(system, user, Answers, settings.ai_effort_answers, max_tokens=8000)
