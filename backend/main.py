"""FinSherlock AI — FastAPI application entry point."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Optional
from uuid import uuid4

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import data.db as db_module

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
def get_metrics(limit: int | None = None) -> dict:
    """
    Evaluate detection tools against IBM AML ground-truth labels.

    Returns precision/recall/F1 for each rule-based detector, a naive baseline
    comparison, false-positive reduction percentages, and XGBoost model metrics.

    Evaluates the full CSV by default (same methodology as scripts/evaluate_detection.py).
    Results are cached in-memory after the first call since the dataset is static.
    Pass ?limit=N to restrict to the first N rows (only for debugging — produces
    in-sample-inflated XGBoost metrics since the first rows overlap with the training split).
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


# Watchlist endpoints
# ---------------------------------------------------------------------------


@app.get("/watchlist", tags=["watchlist"])
def watchlist(top_n: int = 50, window_days: int = 30) -> dict:
    """
    Ranked watchlist — scores every account with XGBoost and returns
    the top-N ranked by ML probability. The "daily analyst briefing" endpoint.
    """
    try:
        return call_tool("ml_risk_score", {"top_n": top_n, "window_days": window_days})
    except Exception as exc:
        logger.exception("Watchlist failed")
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/watchlist/temporal", tags=["watchlist"])
def watchlist_temporal(
    account_ids: str = "",
    windows: str = "7,30,90",
    top_n: int = 50,
) -> dict:
    """
    Temporal analysis — runs the full detection stack (structuring, smurfing,
    layering, ML) at multiple time windows per account. Shows how risk evolves.
    """
    try:
        ids = [a.strip() for a in account_ids.split(",") if a.strip()] or None
        ws = [int(w.strip()) for w in windows.split(",") if w.strip()]
        return call_tool("temporal_analysis", {
            "account_ids": ids,
            "windows": ws,
            "top_n": top_n,
        })
    except Exception as exc:
        logger.exception("Temporal analysis failed")
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# Case Management endpoints
# ---------------------------------------------------------------------------

_VALID_STATUSES = ("open", "under_review", "escalated", "closed")
_VALID_TRANSITIONS = {
    "open":       ("under_review", "closed"),
    "under_review": ("escalated", "closed"),
    "escalated":  ("closed",),
    "closed":     (),
}
_VALID_RESOLUTIONS = ("true_positive", "false_positive")


class CaseCreateRequest(BaseModel):
    account_id: str
    query_text: str = ""
    risk_score: Optional[float] = None
    findings_json: Optional[dict] = None
    created_by: str = "analyst"
    notes: str = ""


class CaseUpdateRequest(BaseModel):
    status: Optional[str] = None
    resolution: Optional[str] = None
    notes: Optional[str] = None
    assigned_to: Optional[str] = None


def _get_conn():
    return db_module.get_connection()


@app.post("/cases", tags=["cases"], status_code=201)
def create_case(request: CaseCreateRequest) -> dict:
    """Create a new investigation case."""
    case_id = f"CASE-{uuid4().hex[:12].upper()}"
    conn = _get_conn()
    conn.execute(
        """INSERT INTO cases (case_id, account_id, query_text, risk_score, findings_json, created_by, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        [case_id, request.account_id, request.query_text,
         request.risk_score, json.dumps(request.findings_json) if request.findings_json else None,
         request.created_by, request.notes],
    )
    row = conn.execute("SELECT * FROM cases WHERE case_id = ?", [case_id]).fetchone()
    return _case_row_to_dict(row)


@app.get("/cases", tags=["cases"])
def list_cases(
    status: Optional[str] = Query(None, description="Filter by status"),
    account_id: Optional[str] = Query(None, description="Filter by account"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> dict:
    """List investigation cases with optional filters."""
    conn = _get_conn()
    where, params = [], []
    if status:
        where.append("status = ?")
        params.append(status)
    if account_id:
        where.append("account_id = ?")
        params.append(account_id)
    where_clause = f"WHERE {' AND '.join(where)}" if where else ""

    total = conn.execute(f"SELECT COUNT(*) FROM cases {where_clause}", params).fetchone()[0]
    rows = conn.execute(
        f"SELECT * FROM cases {where_clause} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        params + [limit, offset],
    ).fetchall()
    return {
        "cases": [_case_row_to_dict(r) for r in rows],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@app.get("/cases/{case_id}", tags=["cases"])
def get_case(case_id: str) -> dict:
    """Get a single case by ID."""
    conn = _get_conn()
    row = conn.execute("SELECT * FROM cases WHERE case_id = ?", [case_id]).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail=f"Case {case_id} not found")
    return _case_row_to_dict(row)


@app.patch("/cases/{case_id}", tags=["cases"])
def update_case(case_id: str, request: CaseUpdateRequest) -> dict:
    """Update case status, resolution, notes, or assignment."""
    conn = _get_conn()
    row = conn.execute("SELECT * FROM cases WHERE case_id = ?", [case_id]).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail=f"Case {case_id} not found")

    current = _case_row_to_dict(row)
    updates, params = [], []

    if request.status is not None:
        if request.status not in _VALID_STATUSES:
            raise HTTPException(400, f"Invalid status: {request.status}")
        if request.status not in _VALID_TRANSITIONS.get(current["status"], ()):
            raise HTTPException(
                400,
                f"Cannot transition from '{current['status']}' to '{request.status}'"
            )
        updates.append("status = ?")
        params.append(request.status)

    if request.resolution is not None:
        if request.resolution not in _VALID_RESOLUTIONS:
            raise HTTPException(400, f"Invalid resolution: {request.resolution}")
        if current["status"] != "closed":
            raise HTTPException(400, "Resolution can only be set on closed cases")
        updates.append("resolution = ?")
        params.append(request.resolution)

    if request.notes is not None:
        updates.append("notes = ?")
        params.append(request.notes)

    if request.assigned_to is not None:
        updates.append("assigned_to = ?")
        params.append(request.assigned_to)

    if not updates:
        return current

    updates.append("updated_at = CURRENT_TIMESTAMP")
    params.append(case_id)
    conn.execute(f"UPDATE cases SET {', '.join(updates)} WHERE case_id = ?", params)
    row = conn.execute("SELECT * FROM cases WHERE case_id = ?", [case_id]).fetchone()
    return _case_row_to_dict(row)


@app.delete("/cases/{case_id}", tags=["cases"])
def delete_case(case_id: str) -> dict:
    """Delete a case."""
    conn = _get_conn()
    row = conn.execute("SELECT * FROM cases WHERE case_id = ?", [case_id]).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail=f"Case {case_id} not found")
    conn.execute("DELETE FROM cases WHERE case_id = ?", [case_id])
    return {"deleted": case_id}


def _case_row_to_dict(row) -> dict:
    """Convert a DuckDB case row to a dict."""
    if row is None:
        return {}
    cols = ["case_id", "account_id", "status", "query_text", "risk_score",
            "findings_json", "resolution", "created_by", "assigned_to",
            "notes", "created_at", "updated_at"]
    return {col: row[i] for i, col in enumerate(cols)}


# ---------------------------------------------------------------------------
# Feedback endpoints (active learning)
# ---------------------------------------------------------------------------

_MODEL_VERSION = "v1"  # bumped on retrain


class FeedbackCreateRequest(BaseModel):
    account_id: str
    case_id: Optional[str] = None
    label: bool  # True = TP, False = FP
    risk_score: Optional[float] = None
    query_text: Optional[str] = None
    transaction_ids: Optional[list] = None
    notes: Optional[str] = None
    created_by: str = "analyst"


@app.post("/feedback", tags=["feedback"], status_code=201)
def create_feedback(request: FeedbackCreateRequest) -> dict:
    """Record an analyst TP/FP label for active learning."""
    feedback_id = f"FB-{uuid4().hex[:12].upper()}"
    conn = _get_conn()
    conn.execute(
        """INSERT INTO analyst_feedback
           (feedback_id, account_id, case_id, label, risk_score, model_version,
            query_text, transaction_ids, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        [
            feedback_id, request.account_id, request.case_id,
            request.label, request.risk_score, _MODEL_VERSION,
            request.query_text,
            str(request.transaction_ids) if request.transaction_ids else None,
            request.notes, request.created_by,
        ],
    )
    # If linked to a case, auto-set the case resolution
    if request.case_id:
        resolution = "true_positive" if request.label else "false_positive"
        conn.execute(
            "UPDATE cases SET resolution = ?, status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE case_id = ?",
            [resolution, request.case_id],
        )
    row = conn.execute(
        "SELECT * FROM analyst_feedback WHERE feedback_id = ?", [feedback_id]
    ).fetchone()
    return _feedback_row_to_dict(row)


@app.get("/feedback", tags=["feedback"])
def list_feedback(
    account_id: Optional[str] = Query(None),
    label: Optional[bool] = Query(None),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> dict:
    """List analyst feedback records."""
    conn = _get_conn()
    where, params = [], []
    if account_id:
        where.append("account_id = ?")
        params.append(account_id)
    if label is not None:
        where.append("label = ?")
        params.append(label)
    where_clause = f"WHERE {' AND '.join(where)}" if where else ""

    total = conn.execute(
        f"SELECT COUNT(*) FROM analyst_feedback {where_clause}", params
    ).fetchone()[0]
    rows = conn.execute(
        f"SELECT * FROM analyst_feedback {where_clause} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        params + [limit, offset],
    ).fetchall()
    return {
        "feedback": [_feedback_row_to_dict(r) for r in rows],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@app.get("/feedback/stats", tags=["feedback"])
def feedback_stats() -> dict:
    """Return feedback statistics for the dashboard."""
    conn = _get_conn()
    total = conn.execute("SELECT COUNT(*) FROM analyst_feedback").fetchone()[0]
    tp = conn.execute("SELECT COUNT(*) FROM analyst_feedback WHERE label = TRUE").fetchone()[0]
    fp = conn.execute("SELECT COUNT(*) FROM analyst_feedback WHERE label = FALSE").fetchone()[0]
    latest = conn.execute(
        "SELECT created_at FROM analyst_feedback ORDER BY created_at DESC LIMIT 1"
    ).fetchone()
    return {
        "total": total,
        "true_positives": tp,
        "false_positives": fp,
        "precision": round(tp / total, 4) if total > 0 else None,
        "latest_feedback": latest[0] if latest else None,
        "model_version": _MODEL_VERSION,
    }


@app.post("/feedback/retrain", tags=["feedback"])
def trigger_retrain() -> dict:
    """
    Trigger model retraining with analyst feedback labels.
    Runs synchronously (fine for demo). In production, this would be a
    background task via Celery/RQ.
    """
    import subprocess
    import sys as _sys

    script = str(Path(__file__).parent / "scripts" / "retrain_with_feedback.py")
    try:
        result = subprocess.run(
            [_sys.executable, script],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=f"Retrain failed:\n{result.stderr[-500:]}",
            )
        # Hot-reload the new model into the ml_risk_score module
        import tools.ml_risk_score as ml_mod
        ml_mod.reload_model()
        return {
            "status": "retrained",
            "output": result.stdout[-2000:],
            "model_version": _MODEL_VERSION,
        }
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="Retrain timed out (120s)")
    except Exception as exc:
        logger.exception("Retrain failed")
        raise HTTPException(status_code=500, detail=str(exc))


def _feedback_row_to_dict(row) -> dict:
    """Convert a DuckDB feedback row to a dict."""
    if row is None:
        return {}
    cols = [
        "feedback_id", "account_id", "case_id", "label", "risk_score",
        "model_version", "query_text", "transaction_ids", "notes",
        "created_by", "created_at",
    ]
    return {col: row[i] for i, col in enumerate(cols)}


# ---------------------------------------------------------------------------
# Real-time stream simulation endpoints
# ---------------------------------------------------------------------------

from stream_simulator import simulator as _stream_sim


class StreamStartRequest(BaseModel):
    speed: float = Field(default=100.0, ge=0.1, le=10000, description="Real-time multiplier (100x = 1s real = 100s data)")


@app.post("/stream/start", tags=["stream"])
async def stream_start(request: StreamStartRequest = StreamStartRequest()) -> dict:
    """Start the transaction stream simulation in the background."""
    result = await _stream_sim.start(speed=request.speed)
    if "error" in result:
        raise HTTPException(status_code=409, detail=result["error"])
    return result


@app.post("/stream/stop", tags=["stream"])
async def stream_stop() -> dict:
    """Stop the running stream simulation."""
    result = await _stream_sim.stop()
    if "error" in result:
        raise HTTPException(status_code=409, detail=result["error"])
    return result


@app.post("/stream/pause", tags=["stream"])
async def stream_pause() -> dict:
    """Pause the stream (transactions stop inserting)."""
    result = await _stream_sim.pause()
    if "error" in result:
        raise HTTPException(status_code=409, detail=result["error"])
    return result


@app.post("/stream/resume", tags=["stream"])
async def stream_resume() -> dict:
    """Resume a paused stream."""
    result = await _stream_sim.resume()
    if "error" in result:
        raise HTTPException(status_code=409, detail=result["error"])
    return result


@app.get("/stream/status", tags=["stream"])
def stream_status() -> dict:
    """Get current stream simulation status."""
    return _stream_sim.status.to_dict()


@app.get("/stream/events", tags=["stream"])
async def stream_events():
    """
    SSE endpoint — streams live transaction + alert events.
    Each event is `data: {json}\n\n`.
    Event types: transaction, alert, status, complete, error.
    """
    queue = _stream_sim.subscribe()

    async def event_generator():
        try:
            # Send current status immediately
            import json as _json
            yield f"data: {_json.dumps(_stream_sim.status.to_dict(), default=str)}\n\n"
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30)
                    yield event.to_sse()
                    if event.type == "complete":
                        break
                except asyncio.TimeoutError:
                    # Send heartbeat to keep connection alive
                    yield ": heartbeat\n\n"
        finally:
            _stream_sim.unsubscribe(queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# ---------------------------------------------------------------------------
# Live Attack Simulator Endpoint — Injects real-time synthetic attack into DuckDB
# ---------------------------------------------------------------------------

@app.post("/simulate-attack", tags=["simulation"])
def simulate_attack() -> dict:
    """
    Injects a live synthetic Structuring attack into DuckDB transactions table:
    3 near-threshold cash deposits ($9,600, $9,750, $9,820) for sender 'ACC_ATTACK_SIM_99'.
    """
    from data.db import get_connection
    import uuid
    from datetime import datetime

    conn = get_connection()
    target_acct = f"ACC_ATTACK_{uuid.uuid4().hex[:4].upper()}"
    now = datetime.now()

    txns = [
        (str(uuid.uuid4()), now, target_acct, "ACC_RECEIVER_99", 9600.0, "USD", "cash_deposit", "US", "branch", True),
        (str(uuid.uuid4()), now, target_acct, "ACC_RECEIVER_99", 9750.0, "USD", "cash_deposit", "US", "branch", True),
        (str(uuid.uuid4()), now, target_acct, "ACC_RECEIVER_99", 9820.0, "USD", "cash_deposit", "US", "branch", True),
    ]

    conn.executemany(
        """
        INSERT INTO transactions (
            transaction_id, timestamp, sender_account_id, receiver_account_id,
            amount, currency, transaction_type, country, channel, is_laundering
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        txns,
    )

    return {
        "status": "success",
        "target_account": target_acct,
        "injected_transactions": 3,
        "query": f"Investigate account {target_acct} for structuring",
    }


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
