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
from functools import lru_cache
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
    company_on_web: Literal["found", "not_found", "not_checked"] = Field(
        default="not_checked",
        description="Result of searching for the company on the web, apart from LinkedIn. not_checked when no search was run")
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


# ───────────────────────── LinkedIn search names ─────────────────────────
# Local branches are often posted as "DoorDash Canada" while the LinkedIn company page is just
# "DoorDash". The search is run for the full name AND the name without the country at its
# start or end; a hit for either one counts as the company being found.
#
# The country list and the generic words are shared with the Node API's blacklist matching
# (src/services/search/normalize.ts), in shared-references/company-name-parts.json.
#
# Generic leftovers: when what is left after removing the country is only common words
# ("Air" from "Air Canada", "Life" from "Canada Life", "Post" from "Canada Post"), the country
# is part of the real name. That shorter name is not searched, so an unrelated "Air" company
# on LinkedIn can't count as finding Air Canada.

_NAME_PARTS_FILE = "shared-references/company-name-parts.json"
# Small words ignored when deciding whether a leftover is generic ("Bank of" -> "bank").
_FILLER_WORDS = {"the", "of", "and", "&", "for", "de", "du", "la", "le", "les", "et"}


@lru_cache(maxsize=1)
def _name_parts() -> tuple[re.Pattern, re.Pattern, frozenset[str]]:
    data = json.loads((settings.root / _NAME_PARTS_FILE).read_text(encoding="utf-8"))
    places = sorted({p.lower() for p in data["countries"] + data["regions"]}, key=len, reverse=True)
    alt = "|".join(re.escape(p) for p in places)
    sep = r"(?:\s*[-–—|:,/]\s*|\s+)"
    at_start = re.compile(rf"^\(?(?:{alt})\)?{sep}", re.I)
    at_end = re.compile(rf"{sep}\(?(?:{alt})\)?\.?$", re.I)
    return at_start, at_end, frozenset(w.lower() for w in data["genericWords"])


# Legal endings that can follow the country: "Siemens Canada Limited", "IBM Canada Ltd."
_LEGAL_ENDING = re.compile(
    r"(?:,?\s+(?:inc|ltd|llc|llp|lp|plc|corp|corporation|co|company|limited|ltée|ltee|ulc|gmbh|ag|sa|s\.a|sas|srl|"
    r"bv|b\.v|nv|pty|pvt|private limited|pte|ab|oy|kk)\.?)+$", re.I)


def is_generic_leftover(name: str) -> bool:
    """True when a name left after removing a country is too generic to search on its own:
    only common words ("Air", "Foods", "Royal Bank"), or one short word that is not an
    acronym ("Air" is generic, "IBM" and "RBC" are not)."""
    _, _, generic = _name_parts()
    words = [w for w in re.findall(r"[^\W_]+(?:'[^\W_]+)?", name) if w.lower() not in _FILLER_WORDS]
    if not words:
        return True
    if all(w.lower() in generic for w in words):
        return True
    return len(words) == 1 and len(words[0]) <= 3 and not words[0].isupper()


def name_without_country(company: str) -> tuple[str | None, list[str]]:
    """Removes a country or region at the start and/or end of the name, keeping any legal
    ending. Returns (shorter name or None, generic leftovers that were rejected)."""
    at_start, at_end, _ = _name_parts()
    full = re.sub(r"\s+", " ", company or "").strip()
    legal = _LEGAL_ENDING.search(full)
    core = full[:legal.start()] if legal else full
    no_start = at_start.sub("", core, count=1).strip()
    stripped = at_end.sub("", no_start, count=1).strip()
    if stripped.lower() == core.lower():
        return None, []
    stripped = stripped.strip(" -–—|:,/()")
    if not stripped:
        return None, []
    if is_generic_leftover(stripped):
        return None, [stripped]
    return stripped, []


def linkedin_search_names(company: str) -> tuple[list[str], list[str]]:
    """Names to search LinkedIn for, and generic leftovers that were not used.
    "DoorDash Canada" -> (["DoorDash Canada", "DoorDash"], []);
    "Cliniconex Inc." -> (["Cliniconex Inc.", "Cliniconex"], []) since LinkedIn pages rarely
    carry the legal ending; "Air Canada" -> (["Air Canada"], ["Air"])."""
    full = re.sub(r"\s+", " ", company or "").strip()
    if not full:
        return [], []
    short, rejected = name_without_country(full)
    legal = _LEGAL_ENDING.search(full)
    bare = full[:legal.start()].strip(" ,") if legal else ""
    names = [full]
    candidates = ((short,) if short else ()) + ((bare,) if bare else ()) + \
        ((short + legal.group(0),) if short and legal else ())
    for name in candidates:
        if name.lower() not in {n.lower() for n in names}:
            names.append(name)
    return names[:3], rejected


@dataclass
class ScriptChecks:
    description: str
    page: dict | None
    company_host: str
    posting_host: str
    posting_site: str
    name_matches_website: str
    findings: list[dict] = field(default_factory=list)
    linkedin_names: list[str] = field(default_factory=list)
    generic_names_skipped: list[str] = field(default_factory=list)


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

    linkedin_names, generic_skipped = linkedin_search_names(req.company)
    return ScriptChecks(description, page, company_host, posting_host, posting_site, name_matches, findings,
                        linkedin_names, generic_skipped)


# ───────────────────────── AI call (steps 3 and 6) ─────────────────────────

RULES = """You check one job posting for fraud. You do NOT see the applicant or their resume,
and you must not consider whether the job suits anyone. Judge only whether the posting is
real.

Steps (already done by a program where noted):
1. Inputs: company website, position, company, job posting page (given).
2. Job description (given; may include text scraped from the posting page).
3. Search for the company twice when a web search tool is available: once for the company
   on the web ("<company>"), and once for its LinkedIn page ("<company> LinkedIn"). A
   company page must exist; its size, industry and location should fit the posting.
   Run each search as its own direct web_search call with one query; do not run searches
   from code (searches are limited, and a failed code run still uses them up).
   <linkedin_search_names> lists the names to look for: the full company name, the name
   without a legal ending ("Cliniconex" for "Cliniconex Inc."; LinkedIn pages usually
   leave it off) and, when the name starts or ends with a country or region (e.g.
   "DoorDash Canada"), the name without it ("DoorDash"). If the full name finds nothing,
   search the shorter names too.
   A fitting company page under ANY of the names means linkedin is found (a local branch
   of a global company is normal). Only set linkedin to not_found when none of the names
   has a company page. The shorter name must clearly be the same company (same brand
   and industry): "Air" from "Air Canada" matching an unrelated "Air" company does not
   count. Likewise, finding the company on the web under any of the names
   means company_on_web is found.
   Set linkedin and company_on_web to found or not_found from those searches. If no tool
   is available, set both to not_checked. not_checked is not a red flag.
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
  (not an agency); no company page on LinkedIn after a search; no trace of the company
  on the web after a search. These last two are separate flags. If linkedin is not_found,
  include a high flag "No company page found on LinkedIn". If company_on_web is not_found,
  include a high flag "No trace of the company on the web". A program then raises the
  rating to at least 80 for either flag. Do not add either flag when the check was
  not_checked.
- medium: pay far above the market for the duties; vague duties and no company details;
  "no experience needed" with high pay; posting site broken or without HTTPS.
- low: urgency wording; spelling/grammar problems; very short posting.
Recruitment agencies, remote work and a missing salary are not red flags by themselves.
Confirm or reject every program finding (it may be wrong), and add any others you find.
Return an empty red_flags list for a normal posting. Do not give a number; a program
calculates the rating from your red flags."""

JSON_INSTRUCTION = (
    "When you have finished checking, reply with ONLY one JSON object (no other text) with "
    "these keys: linkedin (found|not_found|not_checked), company_on_web "
    "(found|not_found|not_checked), company_name_matches "
    "(yes|no|recruitment_agency|unknown), posting_site (company_domain|job_board|"
    "applicant_tracking_system|lookalike_or_unrelated|broken|unknown), red_flags (list of "
    "{flag, weight: critical|high|medium|low}), reasoning (two or three short sentences)."
)


def _user_message(req: FraudRequest, chk: ScriptChecks) -> str:
    page_info = None
    if chk.page is not None:
        page_info = {k: chk.page[k] for k in ("reachable", "status", "https", "final_host", "error")}
    return (
        f"<company>{req.company}</company>\n"
        f"<linkedin_search_names>{json.dumps(chk.linkedin_names, ensure_ascii=False)}</linkedin_search_names>\n"
        f"<company_website>{req.company_website or 'unknown'}</company_website>\n"
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


def _searches_run(blocks: list) -> list[str]:
    """Queries of the web searches that returned results. A search that hit max_uses or
    another error is left out, so it cannot count as "searched and not found"."""
    queries: dict[str, str] = {}
    ok: set[str] = set()
    for b in blocks:
        if b.type == "server_tool_use" and isinstance(b.input, dict) and "query" in b.input:
            queries[b.id] = str(b.input["query"])
        elif b.type == "web_search_tool_result" and isinstance(b.content, list):
            ok.add(b.tool_use_id)
    return [q for i, q in queries.items() if i in ok]


def _with_web_search(client: anthropic.Anthropic, user: str) -> tuple[FraudJudgments, list[str]]:
    """Step 3 with Claude's server-side web search. Final answer is a JSON object in text.
    Also returns the queries of the searches that actually ran."""
    model = settings.fraud_model
    tool_type = "web_search_20250305" if "haiku" in model else "web_search_20260209"
    messages: list[dict] = [{"role": "user", "content": user + "\n\n" + JSON_INSTRUCTION}]
    response = None
    blocks: list = []
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
        blocks.extend(response.content)
        if response.stop_reason != "pause_turn":
            break
        messages = [messages[0], {"role": "assistant", "content": response.content}]
    if response is None or response.stop_reason == "refusal":
        raise RuntimeError("fraud check was refused")
    text = "".join(b.text for b in response.content if b.type == "text")
    return FraudJudgments.model_validate(_extract_json(text)), _searches_run(blocks)


def _drop_unsearched(judgments: FraudJudgments, searches: list[str]) -> tuple[FraudJudgments, str]:
    """not_found only counts when a search for it really ran. When the LinkedIn search (or
    every search) failed or was cut off by the search limit, the check becomes not_checked,
    which is not a red flag. Returns the corrected judgments and a note for the reasoning."""
    update: dict = {}
    if judgments.linkedin == "not_found" and not any("linkedin" in q.lower() for q in searches):
        update["linkedin"] = "not_checked"
    if judgments.company_on_web == "not_found" and not searches:
        update["company_on_web"] = "not_checked"
    if not update:
        return judgments, ""
    flags = [f for f in judgments.red_flags
             if not ("linkedin" in update and _linkedin_absence(f.flag))
             and not ("company_on_web" in update and _web_absence(f.flag))]
    update["red_flags"] = flags
    what = " and ".join({"linkedin": "LinkedIn", "company_on_web": "web"}[k] for k in ("linkedin", "company_on_web") if k in update)
    log.warning("Fraud check reported %s not_found without a completed search (searches run: %s); using not_checked",
                what, searches)
    noun = "searches" if " and " in what else "search"
    return judgments.model_copy(update=update), f" The {what} {noun} did not complete, so not finding the company was not counted."


def _without_tools(client: anthropic.Anthropic, user: str) -> FraudJudgments:
    started = time.time()
    response = client.messages.parse(
        model=settings.fraud_model,
        max_tokens=6000,
        system=[{"type": "text", "text": RULES + "\n\nNo web search tool is available: set linkedin and company_on_web to not_checked.",
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

LINKEDIN_ABSENT_FLAG = "No company page found on LinkedIn"
WEB_ABSENT_FLAG = "No trace of the company on the web"
# Either finding is a high fraud likelihood: very likely a scam, and the match rating is skipped.
NO_PRESENCE_FLOOR = SKIP_MATCH_AT


def _linkedin_absence(flag: str) -> bool:
    text = flag.lower()
    if "linkedin" not in text:
        return False
    return any(p in text for p in (
        "no company page",
        "no linkedin",
        "no page on linkedin",
        "not found",
        "cannot be found",
        "can't be found",
        "could not find",
        "could not be found",
        "no trace",
        "without a linkedin",
        "without a company page",
        "missing linkedin",
    ))


def _web_absence(flag: str) -> bool:
    text = flag.lower()
    return any(p in text for p in (
        "no trace of the company",
        "not found on the web",
        "cannot be found on the web",
        "no web presence",
        "not found online",
        "no online presence",
        "cannot be found on the net",
    ))


def _ensure_presence_flags(judgments: FraudJudgments) -> list[FraudFlag]:
    """A failed search is a red flag even when the model forgets to list it. A skipped search is not."""
    flags = list(judgments.red_flags)
    # Found under one of the names (e.g. "DoorDash" for "DoorDash Canada"): a leftover
    # "not found under the full name" flag must not push the rating to 80.
    if judgments.linkedin == "found":
        flags = [f for f in flags if not _linkedin_absence(f.flag)]
    if judgments.company_on_web == "found":
        flags = [f for f in flags if not _web_absence(f.flag)]
    if judgments.linkedin == "not_found" and not any(_linkedin_absence(f.flag) for f in flags):
        flags.append(FraudFlag(flag=LINKEDIN_ABSENT_FLAG, weight="high"))
    if judgments.company_on_web == "not_found" and not any(_web_absence(f.flag) for f in flags):
        flags.append(FraudFlag(flag=WEB_ABSENT_FLAG, weight="high"))
    return flags


def fraud_rating(flags: list[FraudFlag]) -> tuple[int, bool]:
    """1 = no red flags. Each confirmed flag adds its points.

    Any critical flag, or a confirmed failure to find the company on LinkedIn or on the web,
    means at least 80. The second value is true when that presence floor is what raised it.
    """
    rating = 1 + sum(POINTS[f.weight] for f in flags)
    if any(f.weight == "critical" for f in flags):
        rating = max(rating, SKIP_MATCH_AT)
    raised_for_presence = False
    if any(_linkedin_absence(f.flag) or _web_absence(f.flag) for f in flags) and rating < NO_PRESENCE_FLOOR:
        rating = NO_PRESENCE_FLOOR
        raised_for_presence = True
    return max(1, min(100, rating)), raised_for_presence


def evaluate_fraud(client: anthropic.Anthropic, req: FraudRequest) -> FraudResult:
    chk = script_checks(req)
    user = _user_message(req, chk)
    judgments: FraudJudgments | None = None
    search_note = ""
    if settings.fraud_web_search:
        try:
            judgments, searches = _with_web_search(client, user)
            judgments, search_note = _drop_unsearched(judgments, searches)
        except (ValidationError, ValueError, json.JSONDecodeError) as e:
            log.warning("Fraud check with web search gave no usable JSON (%s); retrying without tools", e)
    if judgments is None:
        judgments = _without_tools(client, user)

    flags = _ensure_presence_flags(judgments)
    rating, raised_for_presence = fraud_rating(flags)
    flags_text = "; ".join(f"{f.flag} ({f.weight})" for f in flags) or "none"
    reasoning = f"{judgments.reasoning}{search_note} Red flags: {flags_text}."
    if raised_for_presence:
        reasoning += " The rating is at least 80 because the company could not be found on LinkedIn or on the web."
    return FraudResult(
        fraud_rating=rating,
        reasoning=reasoning,
        red_flags=flags,
        checks={
            "linkedin": judgments.linkedin,
            "company_on_web": judgments.company_on_web,
            "company_name_matches": judgments.company_name_matches,
            "posting_site": judgments.posting_site,
            "linkedin_search_names": chk.linkedin_names,
            "generic_names_skipped": chk.generic_names_skipped,
            "posting_page": None if chk.page is None else {k: chk.page[k] for k in ("reachable", "status", "https", "final_host", "error")},
            "program_findings": chk.findings,
        },
        skip_match=rating >= SKIP_MATCH_AT,
    )
