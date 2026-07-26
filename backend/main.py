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

    Feedback overrides are queried via the main process's DuckDB connection
    and passed to the subprocess as a temp JSON file to avoid lock contention
    (DuckDB allows only one writer at a time on the file).
    """
    import json as _json
    import subprocess
    import sys as _sys
    import tempfile
    from pathlib import Path

    script = str(Path(__file__).parent / "scripts" / "retrain_with_feedback.py")

    # Query feedback overrides here (main process already has the DB lock)
    feedback_rows = []
    try:
        conn = _get_conn()
        rows = conn.execute(
            "SELECT account_id, label FROM analyst_feedback ORDER BY created_at"
        ).fetchall()
        feedback_rows = [{"account_id": r[0], "label": bool(r[1])} for r in rows]
    except Exception:
        feedback_rows = []

    try:
        if feedback_rows:
            with tempfile.NamedTemporaryFile(
                mode="w", suffix=".json", delete=False, prefix="feedback_"
            ) as f:
                _json.dump(feedback_rows, f)
                feedback_path = f.name
            result = subprocess.run(
                [_sys.executable, script, "--feedback-json", feedback_path],
                capture_output=True,
                text=True,
                timeout=120,
            )
            Path(feedback_path).unlink(missing_ok=True)
        else:
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
# Dashboard summary endpoint — real aggregates from DuckDB
# ---------------------------------------------------------------------------


@app.get("/dashboard/summary", tags=["dashboard"])
def dashboard_summary(window_days: int = 30) -> dict:
    """
    Real dashboard aggregates computed from the current DuckDB data.
    Returns at-risk capital, flagged accounts by risk tier / typology,
    SAR-filing-required count, and total accounts/transactions analyzed.
    """
    conn = _get_conn()

    # Total transactions and accounts
    total_txns = conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
    total_accounts = conn.execute(
        "SELECT COUNT(DISTINCT sender_account_id) FROM transactions"
    ).fetchone()[0]

    # Flagged accounts — we approximate via detect_anomalies output
    # stored in account_features (txn_count, near_threshold_count, velocity)
    flagged_count = conn.execute(
        """SELECT COUNT(DISTINCT account_id) FROM account_features
           WHERE (near_threshold_count IS NOT NULL AND near_threshold_count >= 2)
              OR (velocity IS NOT NULL AND velocity > 10)"""
    ).fetchone()[0]

    # At-risk capital: sum of amounts near threshold (structuring candidates)
    at_risk = conn.execute(
        """SELECT COALESCE(SUM(amount), 0) FROM transactions
           WHERE amount >= 9000 AND amount < 10000
             AND timestamp >= (SELECT MAX(timestamp) FROM transactions) - INTERVAL '30 days'"""
    ).fetchone()[0]

    # SAR-required count: accounts with 4+ near-threshold txns
    sar_required = conn.execute(
        """SELECT COUNT(*) FROM (
               SELECT sender_account_id, COUNT(*) as cnt
               FROM transactions
               WHERE amount >= 9000 AND amount < 10000
               GROUP BY sender_account_id
               HAVING cnt >= 4
           )"""
    ).fetchone()[0]

    # Typology distribution (approximate from features / raw data)
    structuring_count = conn.execute(
        """SELECT COUNT(DISTINCT sender_account_id) FROM transactions
           WHERE amount >= 9000 AND amount < 10000"""
    ).fetchone()[0]

    smurfing_count = conn.execute(
        """SELECT COUNT(*) FROM (
               SELECT sender_account_id, COUNT(DISTINCT receiver_account_id) as fan_out
               FROM transactions GROUP BY sender_account_id HAVING fan_out >= 3
           )"""
    ).fetchone()[0]

    # Accounts analyzed (present in account_features — coverage metric)
    accounts_analyzed = conn.execute(
        "SELECT COUNT(DISTINCT account_id) FROM account_features"
    ).fetchone()[0]

    # Risk tier counts from account_features
    high_risk = conn.execute(
        """SELECT COUNT(DISTINCT account_id) FROM account_features
           WHERE near_threshold_count >= 4 OR velocity > 50"""
    ).fetchone()[0]
    medium_risk = conn.execute(
        """SELECT COUNT(DISTINCT account_id) FROM account_features
           WHERE (near_threshold_count >= 2 AND near_threshold_count < 4)
              OR (velocity > 10 AND velocity <= 50)"""
    ).fetchone()[0]
    low_risk = conn.execute(
        """SELECT COUNT(DISTINCT account_id) FROM account_features
           WHERE near_threshold_count < 2 AND velocity <= 10"""
    ).fetchone()[0]

    # Velocity-count — accounts with elevated velocity
    velocity_count = conn.execute(
        """SELECT COUNT(DISTINCT account_id) FROM account_features
           WHERE velocity IS NOT NULL AND velocity > 10"""
    ).fetchone()[0]

    # Layering proxy — accounts that appear as both sender and receiver (multi-hop behavior)
    layering_count = conn.execute(
        """SELECT COUNT(DISTINCT a.account_id) FROM (
               SELECT sender_account_id AS account_id FROM transactions
               INTERSECT
               SELECT receiver_account_id AS account_id FROM transactions
           ) a"""
    ).fetchone()[0]

    # Mule-ring proxy — accounts with both high near-threshold activity AND velocity
    mule_rings_count = conn.execute(
        """SELECT COUNT(DISTINCT account_id) FROM account_features
           WHERE near_threshold_count >= 3 AND velocity > 15"""
    ).fetchone()[0]

    coverage_pct = round((accounts_analyzed / max(total_accounts, 1)) * 100, 1) if accounts_analyzed > 0 else 0.0

    return {
        "total_transactions": total_txns,
        "total_accounts": total_accounts,
        "accounts_analyzed": accounts_analyzed,
        "coverage_pct": coverage_pct,
        "flagged_accounts": flagged_count,
        "at_risk_capital": at_risk,
        "sar_filing_required": sar_required,
        "risk_tiers": {
            "high": high_risk,
            "medium": medium_risk,
            "low": low_risk,
        },
        "typology_counts": {
            "structuring": structuring_count,
            "smurfing": smurfing_count,
            "velocity": velocity_count,
            "layering": layering_count,
            "mule_rings": mule_rings_count,
        },
        "window_days": window_days,
    }


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

@app.post("/stream/inject-attack", tags=["stream"])
async def stream_inject_attack() -> dict:
    """
    Inject a synthetic, clearly-labeled suspicious transaction pattern into
    the live stream. Transactions are sent to stream subscribers as SSE events
    with "synthetic": true so the frontend can distinguish them from real
    replayed data.
    """
    import uuid as _uuid
    from datetime import datetime as _dt

    if not _stream_sim.status.running:
        return {"error": "Stream is not running. Start the stream first."}

    target_acct = f"SYNTH_ATTACK_{_uuid.uuid4().hex[:4].upper()}"
    now_str = _dt.now().strftime("%Y/%m/%d %H:%M")

    txns = [
        {"sender": target_acct, "receiver": "SYNTH_RECEIVER_01", "amount": 9600.0, "timestamp": now_str, "currency": "USD", "tx_type": "cash_deposit", "channel": "branch", "is_laundering": True},
        {"sender": target_acct, "receiver": "SYNTH_RECEIVER_01", "amount": 9750.0, "timestamp": now_str, "currency": "USD", "tx_type": "cash_deposit", "channel": "branch", "is_laundering": True},
        {"sender": target_acct, "receiver": "SYNTH_RECEIVER_01", "amount": 9820.0, "timestamp": now_str, "currency": "USD", "tx_type": "cash_deposit", "channel": "branch", "is_laundering": True},
    ]

    from stream_simulator import StreamEvent

    # Insert into DuckDB so investigations can find them
    import data.db as _db
    _conn = _db.get_connection()
    for i, txn in enumerate(txns):
        _conn.execute(
            """INSERT OR IGNORE INTO transactions
               (transaction_id, timestamp, sender_account_id, receiver_account_id,
                amount, currency, transaction_type, country, channel, is_laundering)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                f"SYNTH-INJECT-{_dt.now().strftime('%H%M%S')}-{i}",
                txn["timestamp"],
                txn["sender"],
                txn["receiver"],
                txn["amount"],
                txn["currency"],
                txn["tx_type"],
                "__SYNTH__",
                txn["channel"],
                txn["is_laundering"],
            ],
        )

    for txn in txns:
        await _stream_sim._broadcast(StreamEvent("transaction", {
            "type": "transaction", "synthetic": True, **txn,
        }))

    await _stream_sim._broadcast(StreamEvent("alert", {
        "type": "alert", "synthetic": True, "alert_type": "structuring", "severity": "high",
        "account_id": target_acct,
        "message": f"⚠ SYNTHETIC ATTACK: Structuring pattern detected — 3 near-threshold deposits totalling $29,170.00 from {target_acct}",
        "near_threshold_count": 3, "total_amount": 29170.0,
    }))

    return {
        "status": "injected",
        "synthetic": True,
        "target_account": target_acct,
        "injected_transactions": 3,
        "message": "Synthetic structuring attack injected into live stream. Three near-threshold cash deposits persisted in DuckDB.",
    }


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


# ---------------------------------------------------------------------------
# AI Compliance Copilot Chatbot Endpoint
# ---------------------------------------------------------------------------

class CopilotRequest(BaseModel):
    message: str
    account_id: Optional[str] = None


@app.post("/copilot", tags=["copilot"])
def copilot_chat(request: CopilotRequest) -> dict:
    """
    AI Compliance Assistant — answers regulatory questions (FinCEN/BSA CTR/SAR rules),
    explains system architecture (Two-Brain model, Louvain community detection), or
    provides compliance advice for an investigator.
    """
    q = request.message.strip()
    if not q:
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    q_lower = q.lower()

    # 1. Check if LLM API keys are configured
    import os
    if os.getenv("GROQ_API_KEY") or os.getenv("GEMINI_API_KEY"):
        try:
            import litellm
            model = "groq/llama-3.3-70b-versatile" if os.getenv("GROQ_API_KEY") else "gemini/gemini-2.0-flash"
            prompt = (
                "You are FinSherlock AI Copilot, a senior Anti-Money Laundering (AML) compliance expert. "
                "Provide a concise, professional 2-3 sentence answer to the analyst's question. "
                f"Question: {q}"
            )
            res = litellm.completion(
                model=model,
                messages=[{"role": "system", "content": prompt}],
                max_tokens=300,
                temperature=0.2,
            )
            answer = res.choices[0].message.content.strip()
            return {"answer": answer, "source": "llm"}
        except Exception as exc:
            logger.warning("Copilot LLM failed, using compliance knowledge base: %s", exc)

    # 2. Knowledge-base fallback responses
    if "structuring" in q_lower or "ctr" in q_lower or "10,000" in q_lower or "10000" in q_lower or "31 u.s.c" in q_lower:
        answer = (
            "Structuring is a federal crime under 31 U.S.C. § 5324 where cash deposits are intentionally "
            "broken into amounts under $10,000 to evade Bank Secrecy Act (BSA) Currency Transaction Reporting (CTR). "
            "FinSherlock AI flags deposits within 5% of the threshold over rolling time windows."
        )
    elif "sar" in q_lower or "deadline" in q_lower or "report" in q_lower or "filing" in q_lower:
        answer = (
            "Under FinCEN regulations, financial institutions must file a Suspicious Activity Report (SAR) "
            "within 30 calendar days after the date of initial detection of a suspicious transaction. "
            "If no suspect is identified, the deadline extends to 60 days."
        )
    elif "mule" in q_lower or "ring" in q_lower or "louvain" in q_lower or "community" in q_lower:
        answer = (
            "FinSherlock AI uses Louvain Community Detection to identify money mule rings. "
            "The algorithm analyzes transaction graph density and internal circulation ratios to flag clusters "
            "of accounts moving money primarily inside the group before transferring funds outward."
        )
    elif "two-brain" in q_lower or "architecture" in q_lower or "hallucinat" in q_lower:
        answer = (
            "Our Two-Brain Architecture separates LLM planning from mathematical execution. "
            "Brain 1 (LLM) only parses query intent and generates a tool call plan. "
            "Brain 2 (Python/DuckDB/XGBoost) executes 100% of calculation and risk scoring, guaranteeing zero LLM hallucinations."
        )
    elif "velocity" in q_lower or "spike" in q_lower or "surge" in q_lower:
        answer = (
            "Velocity spike detection compares an account's recent 7-day transaction frequency against its 90-day baseline. "
            "Surges of 3× or greater are flagged as high-risk, as sudden bursts often indicate compromised or automated mule activity."
        )
    else:
        answer = (
            "As your AML Compliance Copilot, I'm here to assist with FinCEN/BSA regulations, CTR/SAR filing guidance, "
            "typology explanations (Structuring, Smurfing, Layering, Mule Rings), or model metrics. "
            "Try asking about structuring thresholds, SAR deadlines, or our Louvain ring detector!"
        )

    return {"answer": answer, "source": "compliance_kb"}



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
