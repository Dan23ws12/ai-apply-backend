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

    project_root: Path = Path("../..")
    output_dir: Path = Path("../storage/documents")

    def resolve(self, p: Path) -> Path:
        return p if p.is_absolute() else (SERVICE_DIR / p).resolve()

    @property
    def root(self) -> Path:
        return self.resolve(self.project_root)

    @property
    def out(self) -> Path:
        path = self.resolve(self.output_dir)
        path.mkdir(parents=True, exist_ok=True)
        return path


settings = Settings()  # type: ignore[call-arg]
