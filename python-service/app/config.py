from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

SERVICE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=SERVICE_DIR / ".env", extra="ignore")

    anthropic_api_key: str = ""
    ai_model: str = "claude-opus-5-5"
    ai_effort_scoring: str = "low"
    ai_effort_documents: str = "high"
    ai_effort_answers: str = "medium"

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
