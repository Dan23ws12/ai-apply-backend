"""Request/response models for the HTTP API and the structured AI outputs."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Category = Literal["software_developer", "data_analyst", "business_analyst", "non_it"]


# ── HTTP request bodies (sent by the Node API) ──
class Job(BaseModel):
    title: str
    company: str
    company_website: str | None = None
    description: str = ""
    location: str | None = None
    apply_url: str | None = None
    publisher: str | None = None


class Applicant(BaseModel):
    first_name: str
    last_name: str
    email: str
    phone: str | None = None
    city: str | None = None
    region: str | None = None
    country: str | None = None
    linkedin_url: str | None = None
    github_url: str | None = None
    portfolio_url: str | None = None
    work_authorization: str | None = None
    requires_sponsorship: bool | None = None
    years_of_experience: int | None = None
    desired_salary: str | None = None
    notice_period: str | None = None
    extra_answers: dict[str, str] | None = None


class ScoreRequest(BaseModel):
    job: Job
    preferred_category: Category | None = None


class DocumentsRequest(BaseModel):
    job_id: str
    job: Job
    applicant: Applicant
    resume_category: Category
    keywords: list[str] = Field(default_factory=list)


class Question(BaseModel):
    id: str
    label: str
    type: Literal["text", "textarea", "select", "radio", "checkbox", "number", "date"] = "text"
    options: list[str] | None = None
    required: bool = False


class AnswersRequest(BaseModel):
    job: Job
    applicant: Applicant
    questions: list[Question]


# ── Structured outputs returned by Claude ──
class ScoreResult(BaseModel):
    match_rating: int = Field(description="0-100, how well the job fits the chosen base resume and extended skills list")
    match_reason: str = Field(description="Two or three short sentences")
    fraud_rating: int = Field(description="0-100, likelihood the posting is fraudulent")
    fraud_reason: str = Field(description="Starts with the percentage, then short reasons in simple words")
    resume_category: Category
    keywords: list[str] = Field(description="Ranked keywords from the posting to add to the resume, strongest first, max 15")


class ParagraphEdit(BaseModel):
    index: int = Field(description="Paragraph index from the numbered resume")
    new_text: str
    bold_terms: list[str] = Field(default_factory=list, description="Tools/keywords inside new_text to show in bold")


class NewBullet(BaseModel):
    after_index: int = Field(description="Index of an existing bullet in the same job; the new bullet copies its format")
    text: str
    bold_terms: list[str] = Field(default_factory=list)


class ResumeEdits(BaseModel):
    edits: list[ParagraphEdit]
    new_bullets: list[NewBullet] = Field(default_factory=list)
    keywords_added: list[str]
    keywords_left_out: list[str] = Field(default_factory=list)


class CoverLetter(BaseModel):
    """Only the body comes from the AI. The header, date, recipient block,
    subject line, greeting and signature are added by documents.py."""

    hiring_manager_name: str | None = Field(
        default=None, description="Full name of the hiring manager ONLY if the posting states it; otherwise null"
    )
    hiring_manager_title: str | None = Field(
        default=None, description="Their job title if the posting states it; otherwise null"
    )
    paragraphs: list[str] = Field(description="3 or 4 body paragraphs. No greeting, no sign-off, no name")
    closing: str = Field(default="Sincerely,", description="Sign-off word, e.g. 'Sincerely,'")


class Answer(BaseModel):
    id: str
    answer: str = Field(description="Exact option text for select/radio questions; empty string when unknown")
    confident: bool = Field(description="false when the applicant details do not clearly support this answer")


class Answers(BaseModel):
    answers: list[Answer]
