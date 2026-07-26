"""
ML risk score tool — registered in TOOL_REGISTRY.

Loads the XGBoost baseline trained by scripts/train_xgboost_baseline.py and
scores each account's transactions in the DuckDB window.

Features computed at inference time mirror the training features:
  sender_out_degree  — distinct receivers for sender account in window
  receiver_in_degree — distinct senders for receiver account in window
  log_amount_paid    — log1p(amount) as proxy for Amount Paid
  amount_entropy     — Shannon entropy of discretised amounts per sender account
  hod_*              — one-hot of hour-of-day (0-23)
  dow_*              — one-hot of day-of-week (0=Mon..6=Sun)
  fmt_*              — one-hot of channel (Payment Format), categories from training

Returns per-account max probability across all their transactions, plus the top
contributing features by XGBoost feature importance (no SHAP required).
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

import joblib
import numpy as np
import pandas as pd
from pydantic import BaseModel, Field

from agent.registry import tool
from data.db import get_connection

logger = logging.getLogger(__name__)

_MODEL_PATH = Path(__file__).parent.parent / "data/models/xgb_baseline.joblib"

# ── Load model at import time ──────────────────────────────────────────────────
_model          = None
_feat_cols      = None
_fmt_cols       = None
_hod_cols       = None
_dow_cols       = None
_threshold      = 0.5
_MODEL_READY    = False
_ENTROPY_BINS   = 10

try:
    _payload        = joblib.load(_MODEL_PATH)
    _model          = _payload["model"]
    _feat_cols      = _payload["feature_cols"]
    _fmt_cols       = _payload["fmt_cols"]
    _hod_cols       = _payload.get("hod_cols", [])
    _dow_cols       = _payload.get("dow_cols", [])
    _threshold      = _payload["threshold"]
    _MODEL_READY    = True
    logger.info("XGBoost baseline loaded from %s (threshold=%.4f)", _MODEL_PATH, _threshold)
except FileNotFoundError:
    logger.warning(
        "XGBoost model not found at %s — run scripts/train_xgboost_baseline.py first. "
        "ml_risk_score will return empty results until the model is available.",
        _MODEL_PATH,
    )
except Exception as exc:
    logger.error("Failed to load XGBoost model: %s", exc)


# ── Tool definition ────────────────────────────────────────────────────────────

class MLRiskScoreArgs(BaseModel):
    account_ids: Optional[list[str]] = Field(
        default=None,
        description=(
            "Specific sender account IDs to score. "
            "None = score all accounts active in the window."
        ),
    )
    window_days: int = Field(
        default=30, ge=1, le=365,
        description="Transaction history window for degree feature computation.",
    )
    top_n: int = Field(
        default=20, ge=1, le=200,
        description="Return only the top-N highest-probability accounts.",
    )


@tool(
    name="ml_risk_score",
    description=(
        "Scores accounts with a supervised XGBoost model trained on labeled IBM HI-Small "
        "transactions. Returns per-account ML probability (0-1), binary label at the "
        "F1-tuned threshold, and top contributing features by importance. "
        "Complements detect_anomalies with a supervised signal."
    ),
    schema=MLRiskScoreArgs,
)
def ml_risk_score(args: MLRiskScoreArgs) -> dict:
    if not _MODEL_READY:
        return {
            "model_ready":    False,
            "message":        (
                "XGBoost model not loaded. Run scripts/train_xgboost_baseline.py "
                "to generate data/models/xgb_baseline.joblib."
            ),
            "scored_accounts": [],
        }

    con = get_connection()

    # ── Pull raw transactions from the window ──────────────────────────────────
    if args.account_ids:
        placeholders = ", ".join(f"'{aid}'" for aid in args.account_ids)
        where = f"AND (sender_account_id IN ({placeholders}) OR receiver_account_id IN ({placeholders}))"
    else:
        where = ""

    query = f"""
        SELECT
            transaction_id,
            timestamp,
            sender_account_id,
            receiver_account_id,
            amount,
            channel
        FROM transactions
        WHERE timestamp >= (SELECT MAX(timestamp) FROM transactions) - INTERVAL {args.window_days} DAY
        {where}
        ORDER BY timestamp
    """
    df = con.execute(query).df()

    if df.empty:
        return {
            "model_ready":     True,
            "scored_accounts": [],
            "message":         "No transactions found in the specified window.",
        }

    # ── Compute degree features from the window ────────────────────────────────
    # (These are live counts from available data, not from the training split.)
    out_deg = df.groupby("sender_account_id")["receiver_account_id"].nunique()
    in_deg  = df.groupby("receiver_account_id")["sender_account_id"].nunique()

    df["sender_out_degree"]  = df["sender_account_id"].map(out_deg).fillna(0.0)
    df["receiver_in_degree"] = df["receiver_account_id"].map(in_deg).fillna(0.0)
    df["log_amount_paid"]    = np.log1p(df["amount"].astype("float64"))

    # ── Amount entropy per sender account ─────────────────────────────────────
    def _shannon_entropy(values):
        if len(values) == 0:
            return 0.0
        counts, _ = np.histogram(values, bins=_ENTROPY_BINS)
        probs = counts / counts.sum()
        probs = probs[probs > 0]
        return float(-np.sum(probs * np.log2(probs)))

    acct_entropy = df.groupby("sender_account_id")["amount"].apply(
        lambda s: _shannon_entropy(s.values.astype(float))
    )
    df["amount_entropy"] = df["sender_account_id"].map(acct_entropy).fillna(0.0)

    # ── Time-of-day / day-of-week one-hot ─────────────────────────────────────
    hod_dummies = pd.get_dummies(df["timestamp"].dt.hour, prefix="hod", dtype=int)
    dow_dummies = pd.get_dummies(df["timestamp"].dt.dayofweek, prefix="dow", dtype=int)
    hod_dummies = hod_dummies.reindex(columns=_hod_cols, fill_value=0)
    dow_dummies = dow_dummies.reindex(columns=_dow_cols, fill_value=0)
    for col in _hod_cols:
        df[col] = hod_dummies[col].values
    for col in _dow_cols:
        df[col] = dow_dummies[col].values

    # ── Payment Format one-hot — categories fixed from training ───────────────
    fmt_dummies = pd.get_dummies(df["channel"].fillna(""), prefix="fmt", dtype=int)
    fmt_dummies = fmt_dummies.reindex(columns=_fmt_cols, fill_value=0)
    for col in _fmt_cols:
        df[col] = fmt_dummies[col].values

    # ── Score each transaction ─────────────────────────────────────────────────
    X = df[_feat_cols].values
    probs = _model.predict_proba(X)[:, 1]
    df["ml_prob"] = probs

    # ── Aggregate per sender account ───────────────────────────────────────────
    agg = (
        df.groupby("sender_account_id")
        .agg(
            max_prob  = ("ml_prob", "max"),
            mean_prob = ("ml_prob", "mean"),
            txn_count = ("transaction_id", "count"),
        )
        .reset_index()
        .rename(columns={"sender_account_id": "account_id"})
    )
    agg["ml_flagged"] = agg["max_prob"] >= _threshold

    # ── Filter to requested account_ids ───────────────────────────────────────
    if args.account_ids:
        agg = agg[agg["account_id"].isin(args.account_ids)]

    # ── Sort and limit ─────────────────────────────────────────────────────────
    agg = agg.sort_values("max_prob", ascending=False).head(args.top_n)

    # ── Build feature contribution summary (importance-based, no SHAP) ─────────
    imp_map = dict(zip(_feat_cols, _model.feature_importances_))
    top_feats = [
        {"feature": f, "importance": round(float(v), 4)}
        for f, v in sorted(imp_map.items(), key=lambda x: -x[1])[:5]
    ]

    results = []
    for row in agg.itertuples(index=False):
        # Per-account highest-risk transaction
        top_txn = df[df["sender_account_id"] == row.account_id].nlargest(1, "ml_prob")
        results.append({
            "account_id":   row.account_id,
            "ml_probability": round(float(row.max_prob), 4),
            "ml_mean_prob":   round(float(row.mean_prob), 4),
            "ml_flagged":     bool(row.ml_flagged),
            "txn_count":      int(row.txn_count),
            "top_transaction": {
                "transaction_id": top_txn["transaction_id"].iloc[0],
                "amount":         float(top_txn["amount"].iloc[0]),
                "ml_prob":        round(float(top_txn["ml_prob"].iloc[0]), 4),
            } if not top_txn.empty else None,
        })

    flagged_count = sum(1 for r in results if r["ml_flagged"])

    return {
        "model_ready":       True,
        "threshold":         round(_threshold, 4),
        "window_days":       args.window_days,
        "accounts_scored":   len(results),
        "accounts_flagged":  flagged_count,
        "top_features":      top_feats,
        "scored_accounts":   results,
    }
