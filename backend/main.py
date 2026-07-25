"""FinSherlock AI — FastAPI application entry point."""

from __future__ import annotations

import logging
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

load_dotenv()  # reads backend/.env if present; safe no-op when file is absent

# Importing tools package fires all @tool decorators — must happen before
# we reference TOOL_REGISTRY.
import tools  # noqa: F401
from agent.orchestrator import execute_plan, execute_plan_stream
from agent.planner import call_planner
from agent.registry import TOOL_REGISTRY, call_tool, get_llm_tool_schemas, list_tools

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="FinSherlock AI",
    description=(
        "Agentic AML investigation platform. "
        "Each /tools/{name} endpoint corresponds to one registered analytical tool "
        "and can be called independently — no LLM required."
    ),
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Utility endpoints
# ---------------------------------------------------------------------------


@app.get("/", tags=["meta"])
def root():
    return {
        "service": "FinSherlock AI",
        "registered_tools": [t["name"] for t in list_tools()],
    }


@app.get("/tools", tags=["meta"])
def list_registered_tools():
    """List all registered tools with their descriptions."""
    return list_tools()


@app.get("/tools/llm-schemas", tags=["meta"])
def llm_tool_schemas():
    """Return OpenAI-compatible function-calling schemas for all tools."""
    return get_llm_tool_schemas()


# ---------------------------------------------------------------------------
# Auto-generated per-tool POST endpoints
# ---------------------------------------------------------------------------
# We cannot define FastAPI routes with a dynamic Pydantic body type at class
# definition time (FastAPI validates body models at startup), so we use a
# generic dict body and validate inside call_tool() via the registry's schema.


class ToolCallRequest(BaseModel):
    args: dict[str, Any] = {}


def _make_tool_handler(tool_name: str):
    """Closure that captures tool_name for each generated endpoint."""
    def handler(request: ToolCallRequest) -> dict:
        try:
            return call_tool(tool_name, request.args)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
        except Exception as exc:
            logger.exception("Tool '%s' raised an error", tool_name)
            raise HTTPException(status_code=500, detail=str(exc))
    return handler


# ---------------------------------------------------------------------------
# Investigate endpoint — planner + orchestrator in one call
# ---------------------------------------------------------------------------


class InvestigateRequest(BaseModel):
    query: str


@app.post("/investigate", tags=["investigate"])
def investigate(request: InvestigateRequest) -> dict:
    """
    Full agentic pipeline:
      1. Planner parses the query → execution plan (LLM or deterministic fallback)
      2. Orchestrator executes each plan step via the tool registry
      3. Returns {plan, results, timing, errors}

    Works with zero API keys configured — the deterministic fallback handles it.
    Add GROQ_API_KEY or GEMINI_API_KEY to .env to enable the LLM planner.
    """
    if not request.query.strip():
        raise HTTPException(status_code=400, detail="query must not be empty")
    try:
        plan = call_planner(request.query)
        return execute_plan(plan)
    except Exception as exc:
        logger.exception("Investigation failed for query: %r", request.query)
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/investigate/stream", tags=["investigate"])
def investigate_stream(request: InvestigateRequest) -> StreamingResponse:
    """
    Streaming version of /investigate.
    Returns text/event-stream — each tool emits a 'tool_done' event as it completes
    so the frontend can render results progressively without waiting for the full plan.

    Use fetch() + ReadableStream on the frontend (EventSource only supports GET).
    """
    if not request.query.strip():
        raise HTTPException(status_code=400, detail="query must not be empty")

    import json

    def event_stream():
        try:
            plan = call_planner(request.query)
            yield from execute_plan_stream(plan)
        except Exception as exc:
            logger.exception("Streaming investigation failed for query: %r", request.query)
            yield f"data: {json.dumps({'type': 'error', 'error': str(exc)})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection":        "keep-alive",
        },
    )


# ---------------------------------------------------------------------------
# Metrics endpoint — precision/recall/F1 against ground-truth labels
# ---------------------------------------------------------------------------

_cached_metrics: dict | None = None


@app.get("/metrics", tags=["meta"])
def get_metrics(limit: int = 500_000) -> dict:
    """
    Evaluate detection tools against IBM AML ground-truth labels.

    Returns precision/recall/F1 for each rule-based detector, a naive baseline
    comparison, and false-positive reduction percentages.

    Results are cached in-memory after the first call since the dataset is static.
    """
    global _cached_metrics
    if _cached_metrics is not None:
        return _cached_metrics

    from pathlib import Path
    try:
        from scripts.evaluate_detection import run_evaluation

        csv_path = Path(__file__).parent / "data/raw/HI-Small_Trans.csv"
        if not csv_path.exists():
            raise HTTPException(
                status_code=404,
                detail="HI-Small_Trans.csv not found. Place the IBM AML dataset in backend/data/raw/",
            )

        _cached_metrics = run_evaluation(csv_path=csv_path, limit=limit)
        return _cached_metrics
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        logger.exception("Metrics evaluation failed")
        raise HTTPException(status_code=500, detail=str(exc))


# Register one POST /tools/{name} per entry in TOOL_REGISTRY at startup
for _name, _entry in TOOL_REGISTRY.items():
    _handler = _make_tool_handler(_name)
    _handler.__name__ = f"call_{_name}"   # FastAPI uses __name__ for route IDs
    app.add_api_route(
        path=f"/tools/{_name}",
        endpoint=_handler,
        methods=["POST"],
        tags=["tools"],
        summary=_entry["description"],
        response_model=None,
    )
