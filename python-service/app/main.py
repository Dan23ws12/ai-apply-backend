"""
AI + document service. Only the Node API calls it (shared token in X-Service-Token).

Run:  uvicorn app.main:app --port 8000
"""

from __future__ import annotations

import hmac
import logging

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.concurrency import run_in_threadpool

import anthropic

from . import ai, documents
from .fraud import FraudRequest, FraudResult, evaluate_fraud
from .match import MatchRequest, MatchResult, evaluate_match
from .config import settings
from .references import CATEGORIES, load_category
from .schemas import Answers, AnswersRequest, DocumentsRequest

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
        "fraud_model": settings.fraud_model,
        "match_model": settings.match_model,
        "fraud_web_search": settings.fraud_web_search,
        "api_key_set": bool(settings.anthropic_api_key),
        "missing": missing,
    }


def _ai_error(e: Exception) -> HTTPException:
    """Turns Claude API errors into a 502 with a readable message."""
    if isinstance(e, anthropic.RateLimitError):
        msg = "Claude API rate limit reached; try again shortly"
    elif isinstance(e, anthropic.APIStatusError):
        msg = f"Claude API error {e.status_code}: {e.message}"
    elif isinstance(e, anthropic.APIConnectionError):
        msg = "Could not reach the Claude API"
    elif isinstance(e, TypeError) and "authentication" in str(e).lower():
        msg = "No Claude credentials found. Set ANTHROPIC_API_KEY in python-service/.env"
    else:
        msg = str(e)
    return HTTPException(status_code=502, detail=msg)


AI_ERRORS = (anthropic.APIError, TypeError, RuntimeError)


@app.post("/evaluate/fraud", response_model=FraudResult, dependencies=[Depends(require_token)])
async def fraud(req: FraudRequest) -> FraudResult:
    """Fraud likelihood rating, 1-100 (higher = more likely a scam). Never sees the resume."""
    try:
        return await run_in_threadpool(evaluate_fraud, ai.client, req)
    except AI_ERRORS as e:
        raise _ai_error(e) from e


@app.post("/evaluate/match", response_model=MatchResult, dependencies=[Depends(require_token)])
async def match(req: MatchRequest) -> MatchResult:
    """Job match rating, 1-100 (higher = better fit). Never sees fraud findings."""
    try:
        return await run_in_threadpool(
            lambda: evaluate_match(ai.client, req, model=settings.match_model, effort=settings.ai_effort_match))
    except AI_ERRORS as e:
        raise _ai_error(e) from e


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
