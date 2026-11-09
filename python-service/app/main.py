"""
AI + document service. Only the Node API calls it (shared token in X-Service-Token).

Run:  uvicorn app.main:app --port 8000
"""

from __future__ import annotations

import hmac
import logging

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.concurrency import run_in_threadpool

from . import ai, documents
from .config import settings
from .references import CATEGORIES, load_category
from .schemas import Answers, AnswersRequest, DocumentsRequest, ScoreRequest, ScoreResult

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
app = FastAPI(title="Job Apply AI service", version="0.1.0")


def require_token(x_service_token: str = Header(default="")) -> None:
    if not hmac.compare_digest(x_service_token, settings.python_service_token):
        raise HTTPException(status_code=401, detail="Invalid service token")


@app.get("/health")
def health() -> dict:
    missing = []
    for c in CATEGORIES:
        try:
            load_category(c)
        except FileNotFoundError as e:
            missing.append(str(e))
    return {
        "status": "ok" if not missing else "degraded",
        "model": settings.ai_model,
        "api_key_set": bool(settings.anthropic_api_key),
        "missing": missing,
    }


@app.post("/score", response_model=ScoreResult, dependencies=[Depends(require_token)])
async def score(req: ScoreRequest) -> ScoreResult:
    try:
        return await run_in_threadpool(ai.score_job, req)
    except ai.AIError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@app.post("/documents", dependencies=[Depends(require_token)])
async def build_documents(req: DocumentsRequest) -> dict:
    try:
        return await run_in_threadpool(documents.build_documents, req)
    except ai.AIError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/answers", response_model=Answers, dependencies=[Depends(require_token)])
async def answers(req: AnswersRequest) -> Answers:
    if not req.questions:
        return Answers(answers=[])
    try:
        return await run_in_threadpool(ai.answer_questions, req)
    except ai.AIError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
