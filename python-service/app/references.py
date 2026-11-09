"""
Loads the project's existing resume skills and reference files so the AI follows
the same rules you use by hand:

    .agents/skills/<category>-resume-guidance/SKILL.md   -> instructions per resume type
    .agents/skills/job-post-evaluation/SKILL.md          -> fraud and match rating rules (mirrored in fraud.py / match.py)
    shared-references/*.md                               -> format, skill placement, extended skills lists
    resumes/base resumes/*.docx                          -> base resumes (never modified)

To change how resumes are written, edit those files. No code change is needed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from docx import Document

from .config import settings

CATEGORIES = ("software_developer", "data_analyst", "business_analyst", "non_it")

SKILL_DIRS = {
    "software_developer": "software-developer-resume-guidance",
    "data_analyst": "data-analyst-resume-guidance",
    "business_analyst": "business-analyst-resume-guidance",
    "non_it": "non-it-resume-guidance",
}

# Fallback file-name patterns when SKILL.md does not name a base resume.
BASE_RESUME_GLOBS = {
    "software_developer": "software_developer_resume*.docx",
    "data_analyst": "data_analyst_resume*.docx",
    "business_analyst": "business_analyst_resume*.docx",
    "non_it": "admin_assistant_resume*.docx",
}

EXTENDED_SKILLS = {
    "software_developer": "software-related-skills-and-tools.md",
    "data_analyst": "data-related-skills-and-tools.md",
    "business_analyst": "data-related-skills-and-tools.md",
    "non_it": "shared_skills_and_tools.md",
}


@dataclass(frozen=True)
class CategoryReferences:
    category: str
    skill_text: str
    base_resume: Path
    base_resume_text: str
    extended_skills: str


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def _strip_frontmatter(text: str) -> str:
    return re.sub(r"\A---.*?---\s*", "", text, flags=re.S)


def _version_key(path: Path) -> tuple[int, ...]:
    m = re.search(r"v(\d+(?:\.\d+)*)", path.stem)
    return tuple(int(x) for x in m.group(1).split(".")) if m else (0,)


def _base_resume_for(category: str, skill_text: str) -> Path:
    base_dir = settings.root / "resumes" / "base resumes"
    m = re.search(r"resumes/base resumes/([^`\n]+?\.docx)", skill_text)
    if m and (base_dir / m.group(1)).exists():
        return base_dir / m.group(1)
    candidates = sorted(base_dir.glob(BASE_RESUME_GLOBS[category]), key=_version_key)
    if not candidates:
        raise FileNotFoundError(f"No base resume found for {category} in {base_dir}")
    return candidates[-1]


def docx_text(path: Path) -> str:
    return "\n".join(p.text for p in Document(str(path)).paragraphs if p.text.strip())


@lru_cache(maxsize=None)
def load_category(category: str) -> CategoryReferences:
    if category not in CATEGORIES:
        raise ValueError(f"Unknown resume category: {category}")
    skill_path = settings.root / ".agents" / "skills" / SKILL_DIRS[category] / "SKILL.md"
    skill_text = _strip_frontmatter(_read(skill_path))
    base = _base_resume_for(category, skill_text)
    return CategoryReferences(
        category=category,
        skill_text=skill_text,
        base_resume=base,
        base_resume_text=docx_text(base),
        extended_skills=_read(settings.root / "shared-references" / EXTENDED_SKILLS[category]),
    )


@lru_cache(maxsize=None)
def shared_rules() -> str:
    refs = settings.root / "shared-references"
    return (
        "## Format and tone\n" + _read(refs / "format.md")
        + "\n\n## Skill placement\n" + _read(refs / "skill-positional-guidance.md")
    )

