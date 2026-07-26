"""
Temporal analysis tool — registered in TOOL_REGISTRY.

Runs the full detection stack (structuring, smurfing, layering, ML) at multiple
time windows (7d, 30d, 90d) for each account. Shows how risk evolves over time —
structuring that looks mild at 7 days often becomes obvious at 90.

Performance: uses groupby-based degree computation (not networkx graph) and
limited DFS for layering to keep the watchlist responsive.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from typing import Optional

import numpy as np
import pandas as pd
from pydantic import BaseModel, Field

from agent.registry import tool
from data.db import get_connection

logger = logging.getLogger(__name__)

_REPORTING_THRESHOLD: float = 10_000.0
_NEAR_THRESHOLD_BAND: float = 0.05
_ENTROPY_BINS: int = 10
_MAX_LAYERING_HOPS: int = 6
_MAX_GAP_SECONDS: float = 24.0 * 3600.0  # 24 hours

# ── Load XGBoost model at import time ─────────────────────────────────────────
_model = None
_feat_cols = None
_fmt_cols = None
_hod_cols = None
_dow_cols = None
_MODEL_READY = False

try:
    from pathlib import Path
    import joblib

    _model_path = Path(__file__).parent.parent / "data/models/xgb_baseline.joblib"
    _payload = joblib.load(_model_path)
    _model = _payload["model"]
    _feat_cols = _payload["feature_cols"]
    _fmt_cols = _payload["fmt_cols"]
    _hod_cols = _payload.get("hod_cols", [])
    _dow_cols = _payload.get("dow_cols", [])
    _MODEL_READY = True
except Exception:
    pass


def _shannon_entropy(values):
    if len(values) == 0:
        return 0.0
    counts, _ = np.histogram(values, bins=_ENTROPY_BINS)
    probs = counts / counts.sum()
    probs = probs[probs > 0]
    return float(-np.sum(probs * np.log2(probs)))


def _score_window(
    con,
    window_days: int,
    as_of: pd.Timestamp,
    account_ids: Optional[list[str]] = None,
) -> list[dict]:
    """Run full detection stack for one time window. Returns per-account records."""
    window_start = as_of - pd.Timedelta(days=window_days)
    account_filter = ""
    if account_ids:
        ids_sql = ", ".join(f"'{a}'" for a in account_ids)
        account_filter = f"AND sender_account_id IN ({ids_sql})"

    df: pd.DataFrame = con.execute(
        f"""
        SELECT
            transaction_id, timestamp, sender_account_id, receiver_account_id,
            amount, channel
        FROM transactions
        WHERE timestamp >= TIMESTAMP '{window_start.isoformat()}'
          AND timestamp <= TIMESTAMP '{as_of.isoformat()}'
          {account_filter}
        ORDER BY sender_account_id, timestamp
        """
    ).df()

    if df.empty:
        return []

    # ── Degree features ───────────────────────────────────────────────────────
    out_deg = df.groupby("sender_account_id")["receiver_account_id"].nunique()
    in_deg = df.groupby("receiver_account_id")["sender_account_id"].nunique()

    df["sender_out_degree"]  = df["sender_account_id"].map(out_deg).fillna(0.0)
    df["receiver_in_degree"] = df["receiver_account_id"].map(in_deg).fillna(0.0)
    df["log_amount_paid"]    = np.log1p(df["amount"].astype("float64"))

    # ── Amount entropy ─────────────────────────────────────────────────────────
    acct_entropy = df.groupby("sender_account_id")["amount"].apply(
        lambda s: _shannon_entropy(s.values.astype(float))
    )
    df["amount_entropy"] = df["sender_account_id"].map(acct_entropy).fillna(0.0)

    # ── Time features ─────────────────────────────────────────────────────────
    if _MODEL_READY and _hod_cols and _dow_cols:
        hod_dummies = pd.get_dummies(df["timestamp"].dt.hour, prefix="hod", dtype=int)
        dow_dummies = pd.get_dummies(df["timestamp"].dt.dayofweek, prefix="dow", dtype=int)
        hod_dummies = hod_dummies.reindex(columns=_hod_cols, fill_value=0)
        dow_dummies = dow_dummies.reindex(columns=_dow_cols, fill_value=0)
        for col in _hod_cols:
            df[col] = hod_dummies[col].values
        for col in _dow_cols:
            df[col] = dow_dummies[col].values

    # ── Payment format one-hot ────────────────────────────────────────────────
    if _MODEL_READY and _fmt_cols:
        fmt_dummies = pd.get_dummies(df["channel"].fillna(""), prefix="fmt", dtype=int)
        fmt_dummies = fmt_dummies.reindex(columns=_fmt_cols, fill_value=0)
        for col in _fmt_cols:
            df[col] = fmt_dummies[col].values

    # ── ML scoring ────────────────────────────────────────────────────────────
    ml_probs = {}
    if _MODEL_READY and _feat_cols:
        if "is_currency_mismatch" in _feat_cols:
            df["is_currency_mismatch"] = 0
        X = df[_feat_cols].fillna(0.0).values
        probs = _model.predict_proba(X)[:, 1]
        df["ml_prob"] = probs
        ml_probs = df.groupby("sender_account_id")["ml_prob"].max().to_dict()

    # ── Structuring rule ──────────────────────────────────────────────────────
    near_lo = _REPORTING_THRESHOLD * (1.0 - _NEAR_THRESHOLD_BAND)
    near_hi = _REPORTING_THRESHOLD
    struct_counts = {}
    if "amount" in df.columns:
        near_mask = (df["amount"] >= near_lo) & (df["amount"] < near_hi)
        struct_counts = df[near_mask].groupby("sender_account_id").size().to_dict()

    # ── Smurfing (groupby-based, not networkx) ────────────────────────────────
    smurfing_fan_out = df.groupby("sender_account_id")["receiver_account_id"].nunique().to_dict()
    smurfing_fan_in = df.groupby("receiver_account_id")["sender_account_id"].nunique().to_dict()

    # ── Layering (simplified DFS) ─────────────────────────────────────────────
    layering_hops = {}
    adjacency = defaultdict(list)
    for _, row in df.iterrows():
        adjacency[str(row["sender_account_id"])].append(
            (str(row["receiver_account_id"]), row["timestamp"], float(row["amount"]))
        )
    for sender in adjacency:
        adjacency[sender].sort(key=lambda e: e[1])

    def _dfs(current, path, visited, last_ts):
        if len(path) - 1 >= 2:
            layering_hops[path[0]] = max(layering_hops.get(path[0], 0), len(path) - 1)
        if len(path) - 1 >= _MAX_LAYERING_HOPS:
            return
        for receiver, ts, amt in adjacency.get(current, []):
            if receiver in visited:
                continue
            gap = (ts - last_ts).total_seconds()
            if 0 <= gap <= _MAX_GAP_SECONDS:
                visited.add(receiver)
                path.append(receiver)
                _dfs(receiver, path, visited, ts)
                path.pop()
                visited.discard(receiver)

    start_candidates = list(set(account_ids or list(adjacency.keys())))[:200]
    for start in start_candidates:
        for receiver, ts, amt in adjacency.get(start, []):
            if receiver == start:
                continue
            visited = {start, receiver}
            _dfs(receiver, [start, receiver], visited, ts)

    # ── Aggregate per account ─────────────────────────────────────────────────
    all_accounts = set(
        list(ml_probs.keys())
        + list(struct_counts.keys())
        + list(smurfing_fan_out.keys())
        + list(layering_hops.keys())
    )

    records = []
    for acct in sorted(all_accounts):
        ml_p = ml_probs.get(acct, 0.0)
        s_count = struct_counts.get(acct, 0)
        fo = smurfing_fan_out.get(acct, 0)
        fi = smurfing_fan_in.get(acct, 0)
        lh = layering_hops.get(acct, 0)

        # Composite risk score (same logic as risk_classifier)
        ml_pts = 72.0 if ml_p >= 0.65 else (45.0 if ml_p >= 0.30 else 0.0)
        struct_pts = 80.0 if s_count >= 4 else (50.0 if s_count >= 2 else 0.0)
        smurf_pts = 75.0 if max(fo, fi) >= 6 else (45.0 if max(fo, fi) >= 3 else 0.0)
        layer_pts = 80.0 if lh >= 5 else (50.0 if lh >= 3 else 0.0)

        composite = max(ml_pts, struct_pts, smurf_pts, layer_pts)
        signal_count = sum([ml_p >= 0.30, s_count >= 2, max(fo, fi) >= 3, lh >= 3])
        if signal_count >= 2:
            composite = min(100.0, composite + 10.0)

        records.append({
            "account_id": acct,
            "window_days": window_days,
            "ml_prob": round(ml_p, 4),
            "structuring_count": s_count,
            "smurfing_fan_out": fo,
            "smurfing_fan_in": fi,
            "layering_hops": lh,
            "composite_risk": round(composite, 2),
        })

    records.sort(key=lambda r: r["composite_risk"], reverse=True)
    return records


class TemporalAnalysisArgs(BaseModel):
    account_ids: Optional[list[str]] = Field(
        default=None,
        description="Account IDs to analyze. None = auto-select top-N by transaction count.",
    )
    windows: list[int] = Field(
        default=[7, 30, 90],
        description="Time windows in days to analyze.",
    )
    top_n: int = Field(
        default=50,
        ge=1,
        le=200,
        description="Max accounts to analyze when account_ids is None.",
    )


@tool(
    name="temporal_analysis",
    description=(
        "Runs the full detection stack (structuring, smurfing, layering, ML) at "
        "multiple time windows (7d, 30d, 90d) per account. Shows how risk evolves "
        "over time — structuring that looks mild at 7 days often becomes obvious at 90. "
        "Returns per-account risk scores at each window with trend direction."
    ),
    schema=TemporalAnalysisArgs,
)
def temporal_analysis(args: TemporalAnalysisArgs) -> dict:
    con = get_connection()

    # ── Determine which accounts to analyze ───────────────────────────────────
    account_ids = args.account_ids
    if not account_ids:
        # Auto-select top-N by transaction count in the longest window
        max_window = max(args.windows)
        row = con.execute("SELECT MAX(timestamp) FROM transactions").fetchone()
        if row[0] is None:
            return {"windows": args.windows, "accounts_analyzed": 0, "temporal_profiles": []}
        as_of = pd.Timestamp(row[0])
        window_start = as_of - pd.Timedelta(days=max_window)
        top_df = con.execute(
            f"""
            SELECT sender_account_id, COUNT(*) AS cnt
            FROM transactions
            WHERE timestamp >= TIMESTAMP '{window_start.isoformat()}'
              AND timestamp <= TIMESTAMP '{as_of.isoformat()}'
            GROUP BY sender_account_id
            ORDER BY cnt DESC
            LIMIT {args.top_n}
            """
        ).df()
        account_ids = top_df["sender_account_id"].tolist()

    if not account_ids:
        return {"windows": args.windows, "accounts_analyzed": 0, "temporal_profiles": []}

    # ── Get reference date ────────────────────────────────────────────────────
    row = con.execute("SELECT MAX(timestamp) FROM transactions").fetchone()
    as_of = pd.Timestamp(row[0]) if row[0] else pd.Timestamp.now()

    # ── Run detection at each window ──────────────────────────────────────────
    window_results: dict[int, list[dict]] = {}
    for w in sorted(args.windows):
        window_results[w] = _score_window(con, w, as_of, account_ids)

    # ── Build temporal profiles ───────────────────────────────────────────────
    profiles = []
    for acct in account_ids:
        windows_data = []
        for w in sorted(args.windows):
            rec = next((r for r in window_results[w] if r["account_id"] == acct), None)
            if rec:
                windows_data.append(rec)
            else:
                windows_data.append({
                    "account_id": acct,
                    "window_days": w,
                    "ml_prob": 0.0,
                    "structuring_count": 0,
                    "smurfing_fan_out": 0,
                    "smurfing_fan_in": 0,
                    "layering_hops": 0,
                    "composite_risk": 0.0,
                })

        # Determine trend from composite_risk
        risks = [w["composite_risk"] for w in windows_data]
        if len(risks) >= 2:
            if risks[-1] > risks[0] * 1.2:
                trend = "increasing"
            elif risks[-1] < risks[0] * 0.8:
                trend = "decreasing"
            else:
                trend = "stable"
        else:
            trend = "stable"

        profiles.append({
            "account_id": acct,
            "windows": windows_data,
            "trend": trend,
        })

    # Sort by max composite risk across windows
    profiles.sort(
        key=lambda p: max(w["composite_risk"] for w in p["windows"]),
        reverse=True,
    )

    return {
        "windows": sorted(args.windows),
        "accounts_analyzed": len(profiles),
        "temporal_profiles": profiles,
    }
