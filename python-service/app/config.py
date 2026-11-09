from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

SERVICE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=SERVICE_DIR / ".env", extra="ignore")

    anthropic_api_key: str = ""
    ai_model: str = "claude-opus-5-5"
    ai_effort_documents: str = "high"
    ai_effort_answers: str = "medium"

    # Job post evaluation (two independent calls). Empty model = use ai_model.
    ai_model_fraud: str = ""
    ai_effort_fraud: str = "low"
    ai_model_match: str = ""
    ai_effort_match: str = "low"
    # Fraud check step 3: search for the company on LinkedIn with Claude's web search tool.
    fraud_web_search: bool = True
    fraud_max_searches: int = 3
    # Fraud check steps 2 and 5: download the posting page to read it and check the site.
    fraud_fetch_posting_page: bool = True

    @property
    def fraud_model(self) -> str:
        return self.ai_model_fraud or self.ai_model

    @property
    def match_model(self) -> str:
        return self.ai_model_match or self.ai_model

    python_service_token: str

    # Repo root: holds .agents/skills, shared-references, resumes/ and cover-letters/.
    # A relative path is resolved from the python-service folder.
    project_root: Path = Path("..")
    # Output folders. Relative paths are resolved from project_root.
    resume_output_dir: Path = Path("resumes/jb resumes")
    cover_letter_output_dir: Path = Path("cover-letters")

    @property
    def root(self) -> Path:
        p = self.project_root
        return p if p.is_absolute() else (SERVICE_DIR / p).resolve()

    def _output(self, p: Path) -> Path:
        path = p if p.is_absolute() else self.root / p
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def resume_out(self) -> Path:
        return self._output(self.resume_output_dir)

    @property
    def cover_letter_out(self) -> Path:
        return self._output(self.cover_letter_output_dir)


settings = Settings()  # type: ignore[call-arg]
