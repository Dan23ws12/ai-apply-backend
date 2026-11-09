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
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]+', " ", name).strip()[:80] or "job"


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

    folder = settings.out / _safe(req.job_id)
    folder.mkdir(parents=True, exist_ok=True)
    stem = f"{_safe(req.job.title)}-{_safe(req.job.company)}"
    resume_path = folder / f"{stem} - Resume.docx"
    doc.save(str(resume_path))

    resume_text = "\n".join(p.text for p in Document(str(resume_path)).paragraphs if p.text.strip())
    letter = ai.cover_letter(req.resume_category, req.job, req.applicant, resume_text)
    cover_path = folder / f"{stem} - Cover Letter.docx"
    write_cover_letter(cover_path, req.applicant, req.job, letter)

    return {
        "resume_path": str(resume_path),
        "cover_letter_path": str(cover_path),
        "resume_category": req.resume_category,
        "keywords_used": edits.keywords_added,
    }


def write_cover_letter(path: Path, applicant: Applicant, job: Job, letter) -> None:
    doc = Document()
    style = doc.styles["Normal"]
    style.font.name = "Calibri"
    style.font.size = Pt(11)
    style.paragraph_format.space_after = Pt(8)

    name = doc.add_paragraph()
    run = name.add_run(f"{applicant.first_name} {applicant.last_name}")
    run.bold = True
    run.font.size = Pt(14)
    contact = [
        ", ".join(x for x in [applicant.city, applicant.region] if x),
        applicant.phone,
        applicant.email,
        applicant.linkedin_url,
    ]
    doc.add_paragraph(" | ".join(c for c in contact if c))
    doc.add_paragraph(date.today().strftime("%B %d, %Y").replace(" 0", " "))
    doc.add_paragraph(f"{job.company}\nRe: {job.title}")
    doc.add_paragraph(letter.greeting)
    for para in letter.paragraphs:
        doc.add_paragraph(para)
    doc.add_paragraph(f"{letter.closing}\n{applicant.first_name} {applicant.last_name}")
    doc.save(str(path))
