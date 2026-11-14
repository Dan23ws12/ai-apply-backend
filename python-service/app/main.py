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
from . import usage
from .fraud import FraudRequest, evaluate_fraud
from .match import MatchRequest, evaluate_match
from .config import settings
from .references import CATEGORIES, load_category
from .schemas import AnswersRequest, DocumentsRequest

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


def _error(e: Exception, status: int = 502) -> HTTPException:
    """Readable error, plus the token usage spent before it failed (so it is still recorded)."""
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
    return HTTPException(status_code=status, detail={"message": msg, "usage": getattr(e, "usage", [])})


AI_ERRORS = (anthropic.APIError, ai.AIError, TypeError, RuntimeError)


async def _tracked(fn, *args, **kwargs) -> dict:
    """Runs fn in a worker thread and returns its result as a dict with a "usage" list."""
    result, records = await run_in_threadpool(usage.run_tracked, fn, *args, **kwargs)
    body = result.model_dump() if hasattr(result, "model_dump") else dict(result)
    body["usage"] = records
    return body


@app.post("/evaluate/fraud", dependencies=[Depends(require_token)])
async def fraud(req: FraudRequest) -> dict:
    """Fraud likelihood rating, 1-100 (higher = more likely a scam). Never sees the resume."""
    try:
        return await _tracked(evaluate_fraud, ai.client, req)
    except AI_ERRORS as e:
        raise _error(e) from e


@app.post("/evaluate/match", dependencies=[Depends(require_token)])
async def match(req: MatchRequest) -> dict:
    """Job match rating, 1-100 (higher = better fit). Never sees fraud findings."""
    try:
        return await _tracked(evaluate_match, ai.client, req, model=settings.match_model, effort=settings.ai_effort_match)
    except AI_ERRORS as e:
        raise _error(e) from e


@app.post("/documents", dependencies=[Depends(require_token)])
async def build_documents(req: DocumentsRequest) -> dict:
    try:
        return await _tracked(documents.build_documents, req)
    except AI_ERRORS as e:
        raise _error(e) from e
    except FileNotFoundError as e:
        raise _error(e, 500) from e


@app.post("/answers", dependencies=[Depends(require_token)])
async def answers(req: AnswersRequest) -> dict:
    if not req.questions:
        return {"answers": [], "usage": []}
    try:
        return await _tracked(ai.answer_questions, req)
    except AI_ERRORS as e:
        raise _error(e) from e
