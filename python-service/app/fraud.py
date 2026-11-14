"""
Fraud likelihood rating (job-post-evaluation skill, "Fraud likelihood rating").

Hybrid:
  script  -> step 1 (inputs), step 2 (download the posting page when the description is thin),
             step 4 (company name vs website domain), step 5 (posting site checks),
             plus free red-flag patterns in the text
  AI call -> step 3 (search the company on LinkedIn with the web search tool), confirms or
             rejects the script findings, adds its own, and writes the reasoning (step 6)
  script  -> turns the confirmed red flags into the 1-100 rating

This module never sees the resume or the match rating, so it cannot be influenced by them.
"""

from __future__ import annotations

import html
import ipaddress
import json
import logging
import re
import socket
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Literal
from urllib.parse import urlparse

import anthropic
from pydantic import BaseModel, Field, ValidationError

from . import usage
from .config import settings

log = logging.getLogger("fraud")

Weight = Literal["critical", "high", "medium", "low"]
POINTS: dict[str, int] = {"critical": 45, "high": 25, "medium": 10, "low": 4}
SKIP_MATCH_AT = 80


# ───────────────────────── request / result models ─────────────────────────

class FraudRequest(BaseModel):
    title: str
    company: str
    company_website: str | None = None
    description: str = ""
    location: str | None = None
    apply_url: str | None = None
    publisher: str | None = None


class FraudFlag(BaseModel):
    flag: str
    weight: Weight


class FraudJudgments(BaseModel):
    linkedin: Literal["found", "not_found", "not_checked"] = Field(
        description="Result of searching for the company on LinkedIn")
    company_name_matches: Literal["yes", "no", "recruitment_agency", "unknown"] = Field(
        description="Company name on the website vs the posting")
    posting_site: Literal["company_domain", "job_board", "applicant_tracking_system", "lookalike_or_unrelated", "broken", "unknown"]
    red_flags: list[FraudFlag] = Field(description="Confirmed red flags only. Empty for a normal posting.")
    reasoning: str = Field(description="Two or three short sentences in simple words explaining the rating")


class FraudResult(BaseModel):
    fraud_rating: int
    reasoning: str
    red_flags: list[FraudFlag]
    checks: dict
    skip_match: bool


# ───────────────────────── script checks (steps 1, 2, 4, 5) ─────────────────────────

KNOWN_SITES = (
    "linkedin.com", "glassdoor.", "indeed.", "ziprecruiter.", "monster.", "simplyhired.", "jobbank.gc.ca",
    "greenhouse.io", "lever.co", "myworkdayjobs.com", "workday.com", "ashbyhq.com", "smartrecruiters.com",
    "workable.com", "bamboohr.com", "icims.com", "jobvite.com", "taleo.net", "successfactors.", "recruitee.com",
    "breezy.hr", "jazzhr.com", "applytojob.com", "dayforcehcm.com", "ultipro.com", "paylocity.com",
)
FREE_EMAIL = re.compile(r"[\w.+-]+@(gmail|yahoo|outlook|hotmail|aol|proton(mail)?|icloud|gmx|mail)\.\w+", re.I)
TEXT_PATTERNS: list[tuple[re.Pattern, str, Weight]] = [
    (re.compile(r"\b(telegram|whats\s?app|signal app|wickr|google hangouts)\b", re.I), "Interview or contact through a chat app", "high"),
    (re.compile(r"\b(purchase|buy)\b.{0,60}\b(equipment|laptop|software|starter kit|supplies)\b|\b(cheque|check)\b.{0,50}\b(deposit|reimburs|purchase)", re.I), "Asks the applicant to buy equipment or deposit a cheque", "critical"),
    (re.compile(r"\b(bank (account|details|information)|direct deposit (form|details)|SIN\b|social insurance number|social security|SSN|driver'?s licen[cs]e (copy|photo))", re.I), "Asks for banking or government ID details", "critical"),
    (re.compile(r"\b(training|registration|application|processing|onboarding) fee\b|\bpay (a|the) fee\b", re.I), "Asks the applicant to pay a fee", "critical"),
    (re.compile(r"\b(urgent(ly)? hiring|urgent(ly)?|immediate start|start immediately|act now|limited (spots|positions))\b", re.I), "Urgency or pressure wording", "low"),
    (re.compile(r"\bno (experience|interview) (needed|required|necessary)\b", re.I), "No experience or interview required", "medium"),
]


def _host(url: str | None) -> str:
    if not url or url.lower().startswith("mailto:"):
        return ""
    if "//" not in url:
        url = "https://" + url
    return (urlparse(url).hostname or "").lower().removeprefix("www.")


def _base_domain(host: str) -> str:
    parts = host.split(".")
    # Keep 3 labels for country second-level domains such as company.co.uk / company.com.au
    if len(parts) >= 3 and parts[-2] in {"co", "com", "org", "net", "gov", "ac"} and len(parts[-1]) == 2:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def _name_tokens(name: str) -> list[str]:
    stop = {"inc", "ltd", "llc", "corp", "co", "company", "group", "the", "and", "of", "limited", "corporation", "solutions", "services"}
    return [t for t in re.findall(r"[a-z0-9]+", name.lower()) if t not in stop and len(t) > 2]


def _is_public_host(host: str) -> bool:
    """Blocks private, loopback and link-local addresses before downloading a page."""
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            return False
    return True


def fetch_page(url: str, max_bytes: int = 400_000) -> dict:
    """Step 2 + 5: download the posting page (best effort). Never raises."""
    result = {"url": url, "reachable": False, "status": None, "https": url.lower().startswith("https://"),
              "final_host": _host(url), "text": "", "error": None}
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        result["error"] = "not a web link"
        return result
    if not _is_public_host(parsed.hostname):
        result["error"] = "host does not resolve to a public address"
        return result
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (job-apply fraud check)"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310 - http(s) only, public hosts only
            body = resp.read(max_bytes).decode(resp.headers.get_content_charset() or "utf-8", "replace")
            result.update(reachable=True, status=resp.status, final_host=_host(resp.geturl()),
                          https=resp.geturl().lower().startswith("https://"))
    except urllib.error.HTTPError as e:
        result.update(status=e.code, error=f"HTTP {e.code}")
        return result
    except Exception as e:  # noqa: BLE001 - network errors are a finding, not a crash
        result["error"] = type(e).__name__
        return result
    body = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", body)
    text = html.unescape(re.sub(r"(?s)<[^>]+>", " ", body))
    result["text"] = re.sub(r"\s+", " ", text).strip()[:8000]
    return result


@dataclass
class ScriptChecks:
    description: str
    page: dict | None
    company_host: str
    posting_host: str
    posting_site: str
    name_matches_website: str
    findings: list[dict] = field(default_factory=list)


def script_checks(req: FraudRequest) -> ScriptChecks:
    description = req.description or ""
    page = None
    if settings.fraud_fetch_posting_page and req.apply_url and req.apply_url.startswith("http"):
        page = fetch_page(req.apply_url)
        # Step 2: use the scraped page text when the API gave little or no description.
        if len(description) < 400 and page.get("text"):
            description = (description + "\n\n[Text scraped from the posting page]\n" + page["text"]).strip()

    company_host = _host(req.company_website)
    posting_host = (page or {}).get("final_host") or _host(req.apply_url)
    findings: list[dict] = []

    # Step 5: validity of the posting website
    if not posting_host:
        posting_site = "unknown"
    elif any(s in posting_host for s in KNOWN_SITES):
        posting_site = "job_board_or_ats"
    elif company_host and _base_domain(posting_host) == _base_domain(company_host):
        posting_site = "company_domain"
    else:
        posting_site = "unrelated_domain"
        tokens = _name_tokens(req.company)
        lookalike = any(t in posting_host for t in tokens)
        findings.append({"finding": f"Posting site {posting_host} is not the company's domain"
                         + (f" ({company_host})" if company_host else "")
                         + (" and looks like a look-alike of the company name" if lookalike else "")
                         + " and not a known job board", "suggested_weight": "high"})
    if page is not None:
        if not page["https"]:
            findings.append({"finding": "Posting page does not use HTTPS", "suggested_weight": "medium"})
        if not page["reachable"] and posting_site != "job_board_or_ats":
            # Job boards often block automated downloads, so only flag other sites.
            findings.append({"finding": f"Posting page could not be loaded ({page['error']})", "suggested_weight": "medium"})

    # Step 4: company name vs website domain
    tokens = _name_tokens(req.company)
    if company_host and tokens:
        name_matches = "yes" if any(t in company_host for t in tokens) else "no"
        if name_matches == "no":
            findings.append({"finding": f"Company name '{req.company}' does not appear in its website domain ({company_host}); "
                                        "ignore if this is a recruitment agency or a brand name", "suggested_weight": "high"})
    else:
        name_matches = "unknown"

    # Free red-flag patterns in the text
    for pattern, label, weight in TEXT_PATTERNS:
        if pattern.search(description):
            findings.append({"finding": label, "suggested_weight": weight})
    if FREE_EMAIL.search(description):
        findings.append({"finding": "Contact email uses a free personal email domain", "suggested_weight": "high"})

    return ScriptChecks(description, page, company_host, posting_host, posting_site, name_matches, findings)


# ───────────────────────── AI call (steps 3 and 6) ─────────────────────────

RULES = """You check one job posting for fraud. You do NOT see the applicant or their resume,
and you must not consider whether the job suits anyone. Judge only whether the posting is
real.

Steps (already done by a program where noted):
1. Inputs: company website, position, company, job posting page (given).
2. Job description (given; may include text scraped from the posting page).
3. Search for the company name on LinkedIn. If a web search tool is available, use it
   (for example: "<company> LinkedIn"). Check that a company page exists and that its size,
   industry and location fit the posting. If no tool is available, answer not_checked.
4. Company name on the website vs on the posting (program finding given). Recruitment
   agencies posting for a client are fine.
5. Validity of the posting website (program findings given): HTTPS, link works, company
   domain or a known job board / applicant tracking system; look-alike domains are bad.
6. Decide which red flags are real and explain.

Red flag weights:
- critical: asks the applicant to pay anything (fees, training, equipment from a vendor);
  sends a cheque to deposit or forward; asks for banking details, SIN/SSN or ID before a
  written offer.
- high: interview only through a chat app; company email on a free domain; posting or
  apply link on a look-alike or unrelated domain; company name does not match the website
  (not an agency); no trace of the company on LinkedIn or the web.
- medium: pay far above the market for the duties; vague duties and no company details;
  "no experience needed" with high pay; posting site broken or without HTTPS.
- low: urgency wording; spelling/grammar problems; very short posting.
Recruitment agencies, remote work and a missing salary are not red flags by themselves.
Confirm or reject every program finding (it may be wrong), and add any others you find.
Return an empty red_flags list for a normal posting. Do not give a number; a program
calculates the rating from your red flags."""

JSON_INSTRUCTION = (
    "When you have finished checking, reply with ONLY one JSON object (no other text) with "
    "these keys: linkedin (found|not_found|not_checked), company_name_matches "
    "(yes|no|recruitment_agency|unknown), posting_site (company_domain|job_board|"
    "applicant_tracking_system|lookalike_or_unrelated|broken|unknown), red_flags (list of "
    "{flag, weight: critical|high|medium|low}), reasoning (two or three short sentences)."
)


def _user_message(req: FraudRequest, chk: ScriptChecks) -> str:
    page_info = None
    if chk.page is not None:
        page_info = {k: chk.page[k] for k in ("reachable", "status", "https", "final_host", "error")}
    return (
        f"<company>{req.company}</company>\n<company_website>{req.company_website or 'unknown'}</company_website>\n"
        f"<position>{req.title}</position>\n<location>{req.location or 'unknown'}</location>\n"
        f"<listed_on>{req.publisher or 'unknown'}</listed_on>\n<posting_link>{req.apply_url or 'unknown'}</posting_link>\n"
        f"<posting_page_check>{json.dumps(page_info)}</posting_page_check>\n"
        f"<program_findings>{json.dumps(chk.findings)}</program_findings>\n"
        f"<company_name_matches_website>{chk.name_matches_website}</company_name_matches_website>\n"
        f"<description>\n{chk.description[:12000]}\n</description>"
    )


def _extract_json(text: str) -> dict:
    m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.S)
    if m:
        return json.loads(m.group(1))
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("no JSON object in reply")
    return json.loads(text[start:end + 1])


def _with_web_search(client: anthropic.Anthropic, user: str) -> FraudJudgments:
    """Step 3 with Claude's server-side web search. Final answer is a JSON object in text."""
    model = settings.fraud_model
    tool_type = "web_search_20250305" if "haiku" in model else "web_search_20260209"
    messages: list[dict] = [{"role": "user", "content": user + "\n\n" + JSON_INSTRUCTION}]
    response = None
    for _ in range(4):  # the server pauses long tool loops with stop_reason "pause_turn"
        started = time.time()
        response = client.messages.create(
            model=model,
            max_tokens=8000,
            system=[{"type": "text", "text": RULES, "cache_control": {"type": "ephemeral"}}],
            messages=messages,
            tools=[{"type": tool_type, "name": "web_search", "max_uses": settings.fraud_max_searches}],
            output_config={"effort": settings.ai_effort_fraud},
        )
        usage.record(response, usage.FRAUD_RATING, started)  # each continuation is billed separately
        if response.stop_reason != "pause_turn":
            break
        messages = [messages[0], {"role": "assistant", "content": response.content}]
    if response is None or response.stop_reason == "refusal":
        raise RuntimeError("fraud check was refused")
    text = "".join(b.text for b in response.content if b.type == "text")
    return FraudJudgments.model_validate(_extract_json(text))


def _without_tools(client: anthropic.Anthropic, user: str) -> FraudJudgments:
    started = time.time()
    response = client.messages.parse(
        model=settings.fraud_model,
        max_tokens=6000,
        system=[{"type": "text", "text": RULES + "\n\nNo web search tool is available: set linkedin to not_checked.",
                 "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": user}],
        output_config={"effort": settings.ai_effort_fraud},
        output_format=FraudJudgments,
    )
    usage.record(response, usage.FRAUD_RATING, started)
    if response.stop_reason == "refusal" or response.parsed_output is None:
        raise RuntimeError(f"fraud check returned no result (stop_reason={response.stop_reason})")
    return response.parsed_output


# ───────────────────────── rating (script) ─────────────────────────

def fraud_rating(flags: list[FraudFlag]) -> int:
    """1 = no red flags. Each confirmed flag adds its points; any critical flag means at least 80."""
    rating = 1 + sum(POINTS[f.weight] for f in flags)
    if any(f.weight == "critical" for f in flags):
        rating = max(rating, SKIP_MATCH_AT)
    return max(1, min(100, rating))


def evaluate_fraud(client: anthropic.Anthropic, req: FraudRequest) -> FraudResult:
    chk = script_checks(req)
    user = _user_message(req, chk)
    judgments: FraudJudgments | None = None
    if settings.fraud_web_search:
        try:
            judgments = _with_web_search(client, user)
        except (ValidationError, ValueError, json.JSONDecodeError) as e:
            log.warning("Fraud check with web search gave no usable JSON (%s); retrying without tools", e)
    if judgments is None:
        judgments = _without_tools(client, user)

    rating = fraud_rating(judgments.red_flags)
    flags_text = "; ".join(f"{f.flag} ({f.weight})" for f in judgments.red_flags) or "none"
    reasoning = f"{judgments.reasoning} Red flags: {flags_text}."
    return FraudResult(
        fraud_rating=rating,
        reasoning=reasoning,
        red_flags=judgments.red_flags,
        checks={
            "linkedin": judgments.linkedin,
            "company_name_matches": judgments.company_name_matches,
            "posting_site": judgments.posting_site,
            "posting_page": None if chk.page is None else {k: chk.page[k] for k in ("reachable", "status", "https", "final_host", "error")},
            "program_findings": chk.findings,
        },
        skip_match=rating >= SKIP_MATCH_AT,
    )
