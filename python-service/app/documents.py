"""
Builds the tailored resume (.docx) and cover letter (.docx).

The resume is a COPY of the base resume. Only the professional summary, the
skill lines and the experience bullets are rewritten, in place, so fonts,
alignment, bullet numbering and section order stay exactly as in the base file.
"""

from __future__ import annotations

import copy
import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from urllib.parse import urlparse

from docx import Document
from docx.shared import Pt
from docx.text.paragraph import Paragraph

from . import ai
from . import references as refs
from .config import settings
from .schemas import Applicant, DocumentsRequest, Job

EDITABLE_SECTIONS = ("SUMMARY", "PROFILE", "SKILL", "EXPERIENCE")


@dataclass
class ParaInfo:
    index: int
    section: str
    kind: str  # heading | bullet | text
    paragraph: Paragraph


def _is_heading(p: Paragraph) -> bool:
    t = p.text.strip()
    return bool(t) and t.isupper() and len(t) < 45 and "|" not in t


def _is_bullet(p: Paragraph) -> bool:
    ppr = p._p.pPr
    return (ppr is not None and ppr.numPr is not None) or "List" in (p.style.name if p.style is not None else "")


def analyse(doc) -> list[ParaInfo]:
    section = "HEADER"
    out: list[ParaInfo] = []
    for i, p in enumerate(doc.paragraphs):
        if _is_heading(p):
            section = p.text.strip().upper()
            out.append(ParaInfo(i, section, "heading", p))
        elif p.text.strip():
            out.append(ParaInfo(i, section, "bullet" if _is_bullet(p) else "text", p))
    return out


def editable_indexes(infos: list[ParaInfo]) -> list[int]:
    allowed = []
    for info in infos:
        if info.kind == "heading" or not any(s in info.section for s in EDITABLE_SECTIONS):
            continue
        if "EXPERIENCE" in info.section and info.kind != "bullet":
            continue  # employer, title and date lines are never edited
        allowed.append(info.index)
    return allowed


# ───────────────────────── run rewriting ─────────────────────────

def _template_rpr(p: Paragraph):
    """Formatting of the first non-bold run (falls back to the first run)."""
    runs = [r for r in p.runs if r.text.strip()]
    plain = next((r for r in runs if not r.bold), runs[0] if runs else None)
    return copy.deepcopy(plain._r.rPr) if plain is not None and plain._r.rPr is not None else None


def _write_runs(p: Paragraph, segments: list[tuple[str, bool]]) -> None:
    rpr = _template_rpr(p)
    for r in list(p.runs):
        r._r.getparent().remove(r._r)
    for text, bold in segments:
        if not text:
            continue
        run = p.add_run(text)
        if rpr is not None:
            run._r.insert(0, copy.deepcopy(rpr))
        run.bold = True if bold else None


def _bold_segments(text: str, terms: list[str]) -> list[tuple[str, bool]]:
    terms = sorted({t.strip() for t in terms if t.strip()}, key=len, reverse=True)
    if not terms:
        return [(text, False)]
    pattern = re.compile(r"(?<![\w])(" + "|".join(re.escape(t) for t in terms) + r")(?![\w])")
    segments: list[tuple[str, bool]] = []
    last = 0
    for m in pattern.finditer(text):
        segments.append((text[last : m.start()], False))
        segments.append((m.group(0), True))
        last = m.end()
    segments.append((text[last:], False))
    return segments


def _apply(info: ParaInfo, new_text: str, bold_terms: list[str]) -> None:
    p = info.paragraph
    if "SKILL" in info.section and ":" in new_text:
        label, rest = new_text.split(":", 1)
        _write_runs(p, [(label + ":", True), (rest, False)])  # keep "Languages:" style labels bold
    elif "EXPERIENCE" in info.section:
        _write_runs(p, _bold_segments(new_text, bold_terms))
    else:
        _write_runs(p, [(new_text, False)])


def _safe(name: str) -> str:
    """Removes characters Windows does not allow in file names."""
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', " ", name)
    return re.sub(r"\s+", " ", cleaned).strip().rstrip(".")[:80] or "job"


# Folder names stay short enough for Windows. Title and company shrink first; ids stay intact.
FOLDER_NAME_MAX = 160

_INDEED_JK = re.compile(r"[?&]jk=([A-Za-z0-9]+)")
_LINKEDIN_VIEW = re.compile(r"/jobs/view/(?:[^/?#]*-)?(\d{5,})(?:/|$|[?#])")
_LINKEDIN_CURRENT = re.compile(r"[?&]currentJobId=(\d+)")
_GLASSDOOR_LISTING = re.compile(r"[?&]jobListingId=(\d+)", re.IGNORECASE)


def _host(url: str) -> str:
    try:
        return urlparse(url).netloc.lower()
    except ValueError:
        return ""


def _ids_in_url(url: str) -> list[tuple[str, str]]:
    """Board-searchable ids in one apply link: (board, token)."""
    host = _host(url)
    found: list[tuple[str, str]] = []
    if "indeed." in host:
        m = _INDEED_JK.search(url)
        if m:
            found.append(("indeed", m.group(1)))
    if "linkedin." in host:
        m = _LINKEDIN_VIEW.search(url) or _LINKEDIN_CURRENT.search(url)
        if m:
            found.append(("linkedin", m.group(1)))
    if "glassdoor." in host:
        m = _GLASSDOOR_LISTING.search(url)
        if m:
            found.append(("glassdoor", m.group(1)))
    return found


def _preferred_board(search_website: str | None) -> str | None:
    site = (search_website or "").strip().lower()
    if "indeed" in site:
        return "indeed"
    if "linkedin" in site:
        return "linkedin"
    if "glassdoor" in site:
        return "glassdoor"
    return None


def _fallback_job_id(external_id: str | None) -> str:
    """Short provider id when the apply links have no Indeed, LinkedIn, or Glassdoor key."""
    raw = (external_id or "").strip()
    if ":" in raw:
        raw = raw.split(":", 1)[1]
    token = re.sub(r"[^A-Za-z0-9_-]+", "", raw)[:24]
    return f"job-{token}" if token else "job-unknown"


def board_ids(job: Job) -> list[str]:
    """Up to three ids. The board this application was found on comes first."""
    urls: list[str] = []
    if job.apply_url:
        urls.append(job.apply_url)
    for url in job.apply_urls:
        if url and url not in urls:
            urls.append(url)

    preferred = _preferred_board(job.search_website)
    ranked: list[tuple[int, int, str]] = []
    seen: set[str] = set()
    order = 0
    for url in urls:
        for board, token in _ids_in_url(url):
            label = f"{board}-{token}"
            if label in seen:
                continue
            seen.add(label)
            rank = 0 if preferred and board == preferred else 1
            ranked.append((rank, order, label))
            order += 1
    ranked.sort()
    labels = [label for _, _, label in ranked[:3]]
    return labels or [_fallback_job_id(job.external_id)]


def application_folder_name(job: Job, ids: list[str] | None = None) -> str:
    """`{position} - {company} - {ids}`, capped so the ids are never trimmed away."""
    labels = ids if ids is not None else board_ids(job)
    id_part = " - ".join(labels)
    # Room for "{title} - {company} - " in front of the ids.
    prefix_budget = FOLDER_NAME_MAX - len(id_part) - 3
    title = _safe(job.title)
    company = _safe(job.company)
    room = prefix_budget - 3  # the " - " between title and company
    if room < 3:
        return id_part[:FOLDER_NAME_MAX].rstrip(" .-") or "job"
    while len(title) + len(company) > room and (len(title) > 1 or len(company) > 1):
        if len(title) >= len(company) and len(title) > 1:
            title = title[:-1]
        elif len(company) > 1:
            company = company[:-1]
        else:
            title = title[:-1]
    title = title.rstrip(" .") or "job"
    company = company.rstrip(" .") or "co"
    name = f"{title} - {company} - {id_part}"
    if len(name) <= FOLDER_NAME_MAX:
        return name
    return id_part[:FOLDER_NAME_MAX].rstrip(" .") or "job"


def _apply_urls(job: Job) -> list[str]:
    urls: list[str] = []
    if job.apply_url:
        urls.append(job.apply_url)
    for url in job.apply_urls:
        if url and url not in urls:
            urls.append(url)
    return urls


def write_job_note(folder: Path, req: DocumentsRequest, ids: list[str], created: date) -> None:
    """Plain-text note for searching the folder. Not uploaded with the application."""
    job = req.job
    lines = [
        f"Created: {created:%Y-%m-%d}",
        f"Position: {job.title}",
        f"Company: {job.company}",
        f"Search website: {job.search_website or ''}",
        "Board ids:",
        *(f"- {label}" for label in ids),
        f"External id: {job.external_id or ''}",
        f"Application id: {req.job_id}",
        "Apply links:",
        *(f"- {url}" for url in _apply_urls(job)),
    ]
    if not ids:
        lines.insert(5, "-")
    if not _apply_urls(job):
        lines.append("-")
    (folder / "job.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")


# ───────────────────────── public API ─────────────────────────

def build_documents(req: DocumentsRequest) -> dict:
    ref = refs.load_category(req.resume_category)
    doc = Document(str(ref.base_resume))  # base file is opened read-only and saved under a new name
    infos = analyse(doc)
    by_index = {i.index: i for i in infos}
    editable = editable_indexes(infos)

    numbered = "\n".join(f"[{i.index}] ({i.section}, {i.kind}) {i.paragraph.text}" for i in infos)
    edits = ai.resume_edits(req.resume_category, req.job, req.keywords, numbered, editable)

    for e in edits.edits:
        if e.index in editable and e.new_text.strip():
            _apply(by_index[e.index], e.new_text.strip(), e.bold_terms)

    # New bullets: clone an existing bullet in the same job, highest index first so positions don't shift.
    for nb in sorted(edits.new_bullets, key=lambda b: b.after_index, reverse=True):
        anchor = by_index.get(nb.after_index)
        if not anchor or anchor.kind != "bullet" or "EXPERIENCE" not in anchor.section:
            continue
        new_p = copy.deepcopy(anchor.paragraph._p)
        anchor.paragraph._p.addnext(new_p)
        _apply(ParaInfo(-1, anchor.section, "bullet", Paragraph(new_p, anchor.paragraph._parent)), nb.text, nb.bold_terms)

    # application-docs/{YYYY-MM-DD}/{position} - {company} - {board ids}/
    # Every application created on the same day shares that date folder.
    # Regenerating the same posting on the same day replaces the three files.
    ids = board_ids(req.job)
    created = date.today()
    folder = settings.application_docs / f"{created:%Y-%m-%d}" / application_folder_name(req.job, ids)
    folder.mkdir(parents=True, exist_ok=True)
    resume_path = folder / "Resume.docx"
    doc.save(str(resume_path))

    resume_text = "\n".join(p.text for p in Document(str(resume_path)).paragraphs if p.text.strip())
    letter = ai.cover_letter(req.resume_category, req.job, req.applicant, resume_text)
    cover_path = folder / "Cover Letter.docx"
    write_cover_letter(cover_path, resume_path, req.applicant, req.job, letter)
    write_job_note(folder, req, ids, created)

    return {
        "resume_path": str(resume_path),
        "cover_letter_path": str(cover_path),
        "resume_category": req.resume_category,
        "keywords_used": edits.keywords_added,
    }


# ───────────────────────── cover letter ─────────────────────────
#
# Every cover letter gets the same header, built by code (not the AI):
#
#   NAME                         ┐ copied from the tailored resume, so the letter's
#   City | Phone | Email | Link  ┘ header, fonts and margins match the resume exactly
#
#   November 9, 2026             date
#
#   Hiring Manager / name        recipient block
#   Company
#   Job location
#
#   Re: Application for <Position>
#
#   Dear <name / Hiring Manager>,
#   ...body...
#   Sincerely,
#   <Full name>

BODY_SIZE = Pt(11)


def _resume_header(doc) -> list:
    """Paragraphs above the first section heading (name + contact lines)."""
    header = []
    for p in doc.paragraphs:
        if _is_heading(p):
            break
        if p.text.strip():
            header.append(p)
    return header


def _profile_contact_line(applicant: Applicant) -> str:
    location = ", ".join(x for x in [applicant.city, applicant.region] if x)
    parts = [location, applicant.phone, applicant.email, applicant.linkedin_url, applicant.portfolio_url]
    return " | ".join(p for p in parts if p)


def _body_font(header: list) -> str | None:
    """Font of the resume's contact line, so the letter body matches it."""
    for p in header[1:] + header[:1]:
        for r in p.runs:
            if r.font.name:
                return r.font.name
    return None


def _add_line(doc, text: str = "", *, bold: bool = False, font: str | None = None, space_after: float = 0):
    p = doc.add_paragraph()
    p.alignment = 0  # left
    p.paragraph_format.space_before = Pt(0)
    p.paragraph_format.space_after = Pt(space_after)
    if text:
        run = p.add_run(text)
        run.bold = bold or None
        run.font.size = BODY_SIZE
        if font:
            run.font.name = font
    return p


def write_cover_letter(path: Path, resume_path: Path, applicant: Applicant, job: Job, letter) -> None:
    # Start from the tailored resume so styles, page size, margins and the
    # header (including any LinkedIn hyperlink) carry over unchanged.
    doc = Document(str(resume_path))
    header = _resume_header(doc)
    body = doc.element.body
    keep = {p._p for p in header}
    for child in list(body):
        if child.tag.endswith("}sectPr") or child in keep:
            continue
        body.remove(child)

    full_name = f"{applicant.first_name} {applicant.last_name}"
    font = _body_font(header)

    if not header:
        # Fallback when the resume has no header lines: build one from the profile.
        name_p = _add_line(doc, full_name, bold=True, font=font)
        name_p.alignment = 1
        name_p.runs[0].font.size = Pt(16)
        contact_p = _add_line(doc, _profile_contact_line(applicant), font=font)
        contact_p.alignment = 1

    today = date.today()
    _add_line(doc)
    _add_line(doc, f"{today:%B} {today.day}, {today.year}", font=font)
    _add_line(doc)

    recipient = (letter.hiring_manager_name or "").strip()
    _add_line(doc, recipient or "Hiring Manager", font=font)
    if recipient and (letter.hiring_manager_title or "").strip():
        _add_line(doc, letter.hiring_manager_title.strip(), font=font)
    _add_line(doc, job.company, font=font)
    if job.location:
        _add_line(doc, job.location, font=font)
    _add_line(doc)

    _add_line(doc, f"Re: Application for {job.title}", bold=True, font=font, space_after=10)

    greeting = f"Dear {recipient}," if recipient else "Dear Hiring Manager,"
    _add_line(doc, greeting, font=font, space_after=10)
    for para in letter.paragraphs:
        if para.strip():
            _add_line(doc, para.strip(), font=font, space_after=10)

    _add_line(doc, (letter.closing or "Sincerely,").strip().rstrip(",") + ",", font=font)
    _add_line(doc, full_name, font=font)
    doc.save(str(path))
