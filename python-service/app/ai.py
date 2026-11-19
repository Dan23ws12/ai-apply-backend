"""
All Claude API calls. Each task returns a validated Pydantic object using
structured outputs (client.messages.parse + output_format).
"""

from __future__ import annotations

import json
import logging
import time
from typing import TypeVar

import anthropic
from pydantic import BaseModel

from . import references as refs
from . import usage
from .config import settings
from .schemas import (
    Answers,
    AnswersRequest,
    Applicant,
    CoverLetter,
    Job,
    ResumeEdits,
)

log = logging.getLogger("ai")
client = anthropic.Anthropic(api_key=settings.anthropic_api_key or None, max_retries=3)

T = TypeVar("T", bound=BaseModel)


class AIError(RuntimeError):
    pass


def _ask(system: list[dict], user: str, output: type[T], effort: str, max_tokens: int = 16000, *, action: str) -> T:
    """One structured-output request. Server-side fallbacks retry a refused request on another model."""
    started = time.time()
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
            raise AIError("No Claude credentials found. Set ANTHROPIC_API_KEY in the backend .env or python-service/.env") from e
        raise

    usage.record(response, action, started)
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
    return _ask(system, user, ResumeEdits, settings.ai_effort_documents, action=usage.RESUME_TAILORING)


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
        f"Applicant: {applicant.first_name} {applicant.last_name}.\n"
        "Write only the 3-4 body paragraphs and the sign-off word. The program adds the header, date, "
        "recipient address, subject line, greeting and signed name, so do not include any of those in the "
        "paragraphs. Set hiring_manager_name (and hiring_manager_title) only when the posting names the "
        "person; otherwise leave them null."
    )
    return _ask(system, user, CoverLetter, settings.ai_effort_documents, max_tokens=8000, action=usage.COVER_LETTER)


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
    return _ask(system, user, Answers, settings.ai_effort_answers, max_tokens=8000, action=usage.FORM_ANSWERS)
