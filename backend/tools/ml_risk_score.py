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

Returns per-account max probability across all their transactions, plus SHAP
explanations for the top risky transaction per account.
"""

from __future__ import annotations

import logging
from typing import Optional

import joblib
import numpy as np
import pandas as pd
from pydantic import BaseModel, Field

from agent.registry import tool
from data.db import get_connection
from tools.model_store import MODEL_PATH, load_xgb_payload

logger = logging.getLogger(__name__)

_model          = None
_feat_cols      = None
_fmt_cols       = None
_hod_cols       = None
_dow_cols       = None
_threshold      = 0.5
_MODEL_READY    = False
_ENTROPY_BINS   = 10

# SHAP explainer (lazy-loaded on first use)
_shap_explainer = None

try:
    _payload        = load_xgb_payload()
    _model          = _payload["model"]
    _feat_cols      = _payload["feature_cols"]
    _fmt_cols       = _payload["fmt_cols"]
    _hod_cols       = _payload.get("hod_cols", [])
    _dow_cols       = _payload.get("dow_cols", [])
    _threshold      = _payload["threshold"]
    _MODEL_READY    = True
    logger.info("XGBoost baseline ready (threshold=%.4f)", _threshold)
except FileNotFoundError:
    logger.warning(
        "XGBoost model not found at %s — run scripts/train_xgboost_baseline.py first. "
        "ml_risk_score will return empty results until the model is available.",
        MODEL_PATH,
    )
except Exception as exc:
    logger.error("Failed to load XGBoost model: %s", exc)


def _get_shap_explainer():
    """Lazy-load SHAP TreeExplainer for the XGBoost model."""
    global _shap_explainer
    if _shap_explainer is None and _MODEL_READY:
        try:
            import shap
            _shap_explainer = shap.TreeExplainer(_model)
            logger.info("SHAP TreeExplainer initialized")
        except Exception as exc:
            logger.warning("Failed to initialize SHAP explainer: %s", exc)
    return _shap_explainer


def reload_model():
    """Hot-reload the XGBoost model from disk (called after retrain)."""
    global _model, _feat_cols, _fmt_cols, _hod_cols, _dow_cols, _threshold, _MODEL_READY, _shap_explainer
    try:
        payload     = load_xgb_payload()
        _model      = payload["model"]
        _feat_cols  = payload["feature_cols"]
        _fmt_cols   = payload["fmt_cols"]
        _hod_cols   = payload.get("hod_cols", [])
        _dow_cols   = payload.get("dow_cols", [])
        _threshold  = payload["threshold"]
        _MODEL_READY = True
        _shap_explainer = None  # reset SHAP explainer
        logger.info("Model hot-reloaded (threshold=%.4f)", _threshold)
    except Exception as exc:
        logger.error("Failed to hot-reload model: %s", exc)
        _MODEL_READY = False


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
    include_shap: bool = Field(
        default=False,
        description=(
            "Include SHAP explanations for the top risky transaction per account. "
            "Expensive — only enable for single-entity queries. Use the shap_explain "
            "tool for dedicated per-account SHAP analysis."
        ),
    )


def _compute_shap_explanation(account_id: str, acct_df: pd.DataFrame, explainer) -> Optional[dict]:
    """Compute SHAP explanation for the highest-risk transaction of an account.

    acct_df must be pre-filtered to rows for this account only.
    """
    try:
        if acct_df.empty:
            return None

        # Get the highest-risk transaction
        top_idx = acct_df["ml_prob"].idxmax()
        top_row = acct_df.loc[[top_idx], _feat_cols].values
        
        # Compute SHAP values
        shap_values = explainer.shap_values(top_row)
        # For binary classification, shap_values is a list [class0, class1] or just class1
        if isinstance(shap_values, list):
            shap_vals = shap_values[1][0]  # class 1 (positive)
        else:
            shap_vals = shap_values[0]  # already class 1
        
        # Get feature names and values for the top transaction
        feat_vals = top_row[0]
        
        # Build contribution list (feature -> shap value)
        contributions = []
        for feat_name, feat_val, shap_val in zip(_feat_cols, feat_vals, shap_vals):
            if feat_val != 0:  # only show active features
                contributions.append({
                    "feature": feat_name,
                    "value": round(float(feat_val), 4),
                    "shap_value": round(float(shap_val), 4),
                    "direction": "increases_risk" if shap_val > 0 else "decreases_risk",
                })
        
        # Sort by absolute SHAP value
        contributions.sort(key=lambda x: abs(x["shap_value"]), reverse=True)
        
        return {
            "transaction_id": acct_df.loc[top_idx, "transaction_id"],
            "base_value": round(float(explainer.expected_value[1] if isinstance(explainer.expected_value, list) else explainer.expected_value), 4),
            "prediction": round(float(acct_df.loc[top_idx, "ml_prob"]), 4),
            "top_contributions": contributions[:10],  # top 10 contributors
        }
    except Exception as exc:
        logger.warning("SHAP computation failed for account %s: %s", account_id, exc)
        return None


@tool(
    name="ml_risk_score",
    description=(
        "Scores accounts with a supervised XGBoost model trained on labeled IBM HI-Small "
        "transactions. Returns per-account ML probability (0-1), binary label at the "
        "F1-tuned threshold, and SHAP explanations for the top risky transaction. "
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

    # ── Pull raw transactions from the window, with degree features from DuckDB ──
    if args.account_ids:
        placeholders = ", ".join(f"'{aid}'" for aid in args.account_ids)
        where = f"AND (sender_account_id IN ({placeholders}) OR receiver_account_id IN ({placeholders}))"
    else:
        where = ""

    # Degrees computed in SQL via CTEs — avoids loading all rows into pandas
    # just to call groupby().nunique() in Python.
    query = f"""
        WITH window_txns AS (
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
        ),
        out_degrees AS (
            SELECT sender_account_id,
                   COUNT(DISTINCT receiver_account_id) AS sender_out_degree
            FROM window_txns
            GROUP BY sender_account_id
        ),
        in_degrees AS (
            SELECT receiver_account_id,
                   COUNT(DISTINCT sender_account_id) AS receiver_in_degree
            FROM window_txns
            GROUP BY receiver_account_id
        )
        SELECT
            t.transaction_id,
            t.timestamp,
            t.sender_account_id,
            t.receiver_account_id,
            t.amount,
            t.channel,
            COALESCE(od.sender_out_degree, 0) AS sender_out_degree,
            COALESCE(id.receiver_in_degree, 0) AS receiver_in_degree
        FROM window_txns t
        LEFT JOIN out_degrees od ON t.sender_account_id = od.sender_account_id
        LEFT JOIN in_degrees  id ON t.receiver_account_id = id.receiver_account_id
        ORDER BY t.timestamp
    """
    df = con.execute(query).df()

    if df.empty:
        return {
            "model_ready":     True,
            "scored_accounts": [],
            "message":         "No transactions found in the specified window.",
        }

    df["log_amount_paid"] = np.log1p(df["amount"].astype("float64"))

    # ── Amount entropy per sender account ─────────────────────────────────────
    def _shannon_entropy(values: np.ndarray) -> float:
        counts, _ = np.histogram(values, bins=_ENTROPY_BINS)
        probs = counts / counts.sum()
        probs = probs[probs > 0]
        return float(-np.sum(probs * np.log2(probs)))

    # Dict comprehension is faster than groupby().apply(lambda) for custom functions
    acct_entropy = {
        acct: _shannon_entropy(grp["amount"].values.astype(float))
        for acct, grp in df.groupby("sender_account_id", sort=False)
    }
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

    # ── Old-model compat: is_currency_mismatch was removed from training but
    # may still appear in feat_cols if the model has not been retrained yet ─────
    if "is_currency_mismatch" in _feat_cols:
        df["is_currency_mismatch"] = 0

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

    # ── Global feature importance (model-level) ────────────────────────────────
    imp_map = dict(zip(_feat_cols, _model.feature_importances_))
    top_feats = [
        {"feature": f, "importance": round(float(v), 4)}
        for f, v in sorted(imp_map.items(), key=lambda x: -x[1])[:5]
    ]

    # ── SHAP explainer (lazy init) ─────────────────────────────────────────────
    explainer = _get_shap_explainer() if args.include_shap else None

    # Pre-index by account_id so the results loop is O(1) per account
    # instead of O(N) linear scan through df for each of the top_n accounts.
    df_by_acct: dict[str, pd.DataFrame] = {
        acct: grp for acct, grp in df.groupby("sender_account_id", sort=False)
    }

    results = []
    for row in agg.itertuples(index=False):
        acct_df = df_by_acct.get(row.account_id, pd.DataFrame())
        top_txn = acct_df.nlargest(1, "ml_prob") if not acct_df.empty else acct_df

        result = {
            "account_id":      row.account_id,
            "ml_probability":  round(float(row.max_prob), 4),
            "ml_mean_prob":    round(float(row.mean_prob), 4),
            "ml_flagged":      bool(row.ml_flagged),
            "txn_count":       int(row.txn_count),
            "top_transaction": {
                "transaction_id": top_txn["transaction_id"].iloc[0],
                "amount":         float(top_txn["amount"].iloc[0]),
                "ml_prob":        round(float(top_txn["ml_prob"].iloc[0]), 4),
            } if not top_txn.empty else None,
        }

        if explainer and not top_txn.empty:
            shap_exp = _compute_shap_explanation(row.account_id, acct_df, explainer)
            if shap_exp:
                result["shap_explanation"] = shap_exp

        results.append(result)

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