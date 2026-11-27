from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

SERVICE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    # Reads the backend's .env first, then python-service/.env, which wins when both set a value.
    # Empty values are ignored, so a key (e.g. ANTHROPIC_API_KEY) can live in either file.
    model_config = SettingsConfigDict(
        env_file=(SERVICE_DIR.parent / ".env", SERVICE_DIR / ".env"),
        env_ignore_empty=True,
        extra="ignore",
    )

    anthropic_api_key: str = ""
    ai_model: str = "claude-opus-5-5"
    ai_effort_documents: str = "high"
    ai_effort_answers: str = "medium"

    # Job post evaluation (two independent calls). Empty model = use ai_model.
    ai_model_fraud: str = ""
    ai_effort_fraud: str = "low"
    ai_model_match: str = ""
    ai_effort_match: str = "low"
    # Fraud check step 3: search for the company on the web and on LinkedIn.
    fraud_web_search: bool = True
    fraud_max_searches: int = 5
    # Fraud check steps 2 and 5: download the posting page to read it and check the site.
    fraud_fetch_posting_page: bool = True

    @property
    def fraud_model(self) -> str:
        return self.ai_model_fraud or self.ai_model

    @property
    def match_model(self) -> str:
        return self.ai_model_match or self.ai_model

    python_service_token: str

    # Repo root: holds .agents/skills, shared-references, resumes/ and application-docs/.
    # A relative path is resolved from the python-service folder.
    project_root: Path = Path("..")
    # Date folders, each holding that day's application folders. A relative path is resolved from project_root.
    application_docs_dir: Path = Path("application-docs")

    @property
    def root(self) -> Path:
        p = self.project_root
        return p if p.is_absolute() else (SERVICE_DIR / p).resolve()

    def _output(self, p: Path) -> Path:
        path = p if p.is_absolute() else self.root / p
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def application_docs(self) -> Path:
        return self._output(self.application_docs_dir)


settings = Settings()  # type: ignore[call-arg]
