"""
SHAP per-transaction explainer tool.

Uses shap.TreeExplainer on the XGBoost baseline to compute per-transaction
SHAP values (log-odds space). Given account IDs, finds the highest-risk
transaction per account and returns a sorted feature-attribution breakdown.

Example output for an analyst:
  "Scored 0.94 because: Format: Bitcoin (+0.28); Hour of day 02:00 (+0.21);
   Sender unique receivers (+0.19). Base rate: 0.497."
"""

from __future__ import annotations

import logging
import math
from typing import Optional

import numpy as np
import pandas as pd
from pydantic import BaseModel, Field

from agent.registry import tool
from data.db import get_connection
from tools.model_store import load_xgb_payload

logger = logging.getLogger(__name__)

_model       = None
_explainer   = None
_feat_cols   = None
_fmt_cols    = None
_hod_cols    = None
_dow_cols    = None
_base_prob   = None   # sigmoid(expected_value)
_READY       = False
_ENTROPY_BINS = 10

_FEAT_LABELS: dict[str, str] = {
    "sender_out_degree":  "Sender unique receivers",
    "receiver_in_degree": "Receiver unique senders",
    "log_amount_paid":    "Log amount",
    "amount_entropy":     "Amount entropy (sender)",
}

def _hod_label(col: str) -> str:
    h = col.split("_", 1)[1]
    return f"Hour of day {int(h):02d}:00"

def _dow_label(col: str) -> str:
    days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    try:
        return f"Day: {days[int(col.split('_', 1)[1])]}"
    except (IndexError, ValueError):
        return col

def _fmt_label(col: str) -> str:
    return f"Format: {col[4:].replace('_', ' ').title()}"

def _label(col: str) -> str:
    if col in _FEAT_LABELS:
        return _FEAT_LABELS[col]
    if col.startswith("hod_"):
        return _hod_label(col)
    if col.startswith("dow_"):
        return _dow_label(col)
    if col.startswith("fmt_"):
        return _fmt_label(col)
    return col


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


try:
    import shap as _shap_lib
    _payload    = load_xgb_payload()
    _model      = _payload["model"]
    _feat_cols  = _payload["feature_cols"]
    _fmt_cols   = _payload["fmt_cols"]
    _hod_cols   = _payload.get("hod_cols", [])
    _dow_cols   = _payload.get("dow_cols", [])
    _explainer  = _shap_lib.TreeExplainer(_model)
    # expected_value may be a numpy array (e.g. shape (1,)) in newer SHAP versions
    _ev = _explainer.expected_value
    _ev_scalar = float(_ev[0]) if hasattr(_ev, "__len__") else float(_ev)
    _base_prob  = round(_sigmoid(_ev_scalar), 4)
    _READY      = True
    logger.info(
        "SHAP TreeExplainer ready. base_log_odds=%.4f base_prob=%.4f",
        _explainer.expected_value, _base_prob,
    )
except FileNotFoundError:
    logger.warning("Model not found — shap_explain will return empty results.")
except ImportError:
    logger.warning("shap package not installed — run: pip install shap")
except Exception as exc:
    logger.error("Failed to initialise SHAP explainer: %s", exc)


def _build_features(df: pd.DataFrame) -> pd.DataFrame:
    """Mirror the feature engineering from ml_risk_score.py exactly."""
    out_deg = df.groupby("sender_account_id")["receiver_account_id"].nunique()
    in_deg  = df.groupby("receiver_account_id")["sender_account_id"].nunique()
    df["sender_out_degree"]  = df["sender_account_id"].map(out_deg).fillna(0.0)
    df["receiver_in_degree"] = df["receiver_account_id"].map(in_deg).fillna(0.0)
    df["log_amount_paid"]    = np.log1p(df["amount"].astype("float64"))

    def _entropy(vals):
        if len(vals) == 0:
            return 0.0
        counts, _ = np.histogram(vals, bins=_ENTROPY_BINS)
        probs = counts / counts.sum()
        probs = probs[probs > 0]
        return float(-np.sum(probs * np.log2(probs)))

    acct_entropy = df.groupby("sender_account_id")["amount"].apply(
        lambda s: _entropy(s.values.astype(float))
    )
    df["amount_entropy"] = df["sender_account_id"].map(acct_entropy).fillna(0.0)

    hod_dummies = pd.get_dummies(df["timestamp"].dt.hour, prefix="hod", dtype=int)
    dow_dummies = pd.get_dummies(df["timestamp"].dt.dayofweek, prefix="dow", dtype=int)
    hod_dummies = hod_dummies.reindex(columns=_hod_cols, fill_value=0)
    dow_dummies = dow_dummies.reindex(columns=_dow_cols, fill_value=0)
    for col in _hod_cols:
        df[col] = hod_dummies[col].values
    for col in _dow_cols:
        df[col] = dow_dummies[col].values

    fmt_dummies = pd.get_dummies(df["channel"].fillna(""), prefix="fmt", dtype=int)
    fmt_dummies = fmt_dummies.reindex(columns=_fmt_cols, fill_value=0)
    for col in _fmt_cols:
        df[col] = fmt_dummies[col].values

    # Compat: old model may include is_currency_mismatch (always 0 at inference)
    if "is_currency_mismatch" in _feat_cols:
        df["is_currency_mismatch"] = 0

    return df


# ── Tool definition ──────────────────────────────────────────────────────────

class SHAPExplainArgs(BaseModel):
    account_ids: list[str] = Field(
        description="Account IDs to explain. Each gets the SHAP breakdown of its highest-risk transaction.",
    )
    window_days: int = Field(
        default=30, ge=1, le=365,
        description="Transaction window for feature computation.",
    )
    top_features: int = Field(
        default=8, ge=1, le=20,
        description="Maximum number of SHAP features to return per transaction (sorted by |SHAP|).",
    )


@tool(
    name="shap_explain",
    description=(
        "Returns per-transaction SHAP explanations for the highest-risk transaction of each "
        "requested account. Explains *why* the ML model scored a specific transaction high: "
        "which features pushed the score up or down, and by how much (log-odds). "
        "Use after ml_risk_score to give analysts an auditable decision trail."
    ),
    schema=SHAPExplainArgs,
)
def shap_explain(args: SHAPExplainArgs) -> dict:
    if not _READY:
        return {
            "ready": False,
            "message": "SHAP explainer not initialised. Check that shap is installed and the model exists.",
            "explanations": [],
        }

    con = get_connection()
    placeholders = ", ".join(f"'{aid}'" for aid in args.account_ids)
    df = con.execute(f"""
        SELECT
            transaction_id,
            timestamp,
            sender_account_id,
            receiver_account_id,
            amount,
            channel
        FROM transactions
        WHERE timestamp >= (SELECT MAX(timestamp) FROM transactions) - INTERVAL {args.window_days} DAY
          AND (sender_account_id IN ({placeholders}) OR receiver_account_id IN ({placeholders}))
        ORDER BY timestamp
    """).df()

    if df.empty:
        return {
            "ready": True,
            "explanations": [],
            "message": "No transactions found for the requested accounts in the window.",
        }

    df["timestamp"] = pd.to_datetime(df["timestamp"])
    df = _build_features(df)

    X = df[_feat_cols].fillna(0.0).values
    probs = _model.predict_proba(X)[:, 1]
    df["ml_prob"] = probs

    # Compute SHAP for all rows at once (faster than row-by-row)
    shap_values = _explainer.shap_values(X)  # shape (n, n_features)

    explanations = []
    for account_id in args.account_ids:
        acct_mask = df["sender_account_id"] == account_id
        acct_df = df[acct_mask]
        if acct_df.empty:
            continue

        best_idx = acct_df["ml_prob"].idxmax()
        row = df.loc[best_idx]
        sv   = shap_values[df.index.get_loc(best_idx)]  # (n_features,)
        prob = float(row["ml_prob"])

        # Build sorted attribution list (skip is_currency_mismatch and zero values)
        attrs = []
        for j, col in enumerate(_feat_cols):
            if col == "is_currency_mismatch":
                continue
            val = float(sv[j])
            if val == 0.0:
                continue
            attrs.append({
                "feature":     col,
                "label":       _label(col),
                "shap_value":  round(val, 4),
                "direction":   "increase" if val > 0 else "decrease",
            })

        attrs.sort(key=lambda a: -abs(a["shap_value"]))
        top_attrs = attrs[: args.top_features]

        # Human-readable narrative
        parts = [
            f"{a['label']} ({'+' if a['shap_value'] > 0 else ''}{a['shap_value']:.2f})"
            for a in top_attrs[:3]
        ]
        narrative = (
            f"Scored {prob:.3f} because: {'; '.join(parts)}. "
            f"Base rate: {_base_prob:.3f}."
        )

        explanations.append({
            "account_id":       account_id,
            "transaction_id":   str(row["transaction_id"]),
            "timestamp":        str(row["timestamp"]),
            "amount":           float(row["amount"]),
            "ml_probability":   round(prob, 4),
            "base_probability": _base_prob,
            "shap_values":      top_attrs,
            "narrative":        narrative,
        })

    return {
        "ready":        True,
        "window_days":  args.window_days,
        "explanations": explanations,
    }
