"""
Anomaly detection tools — registered in TOOL_REGISTRY.

Two tools:
  detect_structuring  — rule-based, returns actual flagged transaction records
  detect_anomalies    — hybrid ML (IsolationForest) over engineered feature vectors,
                        returns normalized anomaly score and top contributing features
"""

from __future__ import annotations

import logging
from typing import Optional

import numpy as np
import pandas as pd
from pydantic import BaseModel, Field
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler

from agent.registry import tool
from data.db import get_connection

logger = logging.getLogger(__name__)

# Regulatory reporting threshold and structuring detection band
_REPORTING_THRESHOLD: float = 10_000.0
_DEFAULT_BAND: float = 0.05   # 5 % below threshold → [$9 500, $10 000)

# Feature columns the IsolationForest is trained on (must match engineer_features output)
_FEATURE_COLS: list[str] = [
    "txn_count",
    "total_volume",
    "avg_amount",
    "std_amount",
    "velocity",
    "max_single_amount",
    "amount_deviation_pct",
    "near_threshold_count",
]

# Minimum samples needed for IsolationForest to be meaningful
_MIN_IF_SAMPLES: int = 3


# ---------------------------------------------------------------------------
# detect_structuring
# ---------------------------------------------------------------------------

class DetectStructuringArgs(BaseModel):
    account_ids: Optional[list[str]] = Field(
        default=None,
        description="Sender account IDs to check. None = all accounts in the window.",
    )
    window_days: int = Field(default=30, ge=1, le=365)
    threshold: float = Field(
        default=_REPORTING_THRESHOLD,
        description="Regulatory reporting threshold (USD). Transactions just below this are flagged.",
    )
    threshold_band: float = Field(
        default=_DEFAULT_BAND,
        description="Fraction below threshold defining the 'near-threshold' band (0.05 = 5%).",
    )
    date_to: Optional[str] = Field(
        default=None,
        description="ISO-8601 upper date bound. Defaults to latest timestamp in dataset.",
    )
    country: Optional[str] = Field(
        default=None,
        description="Country code or country name filter (e.g. 'US', 'UK').",
    )
    segment: Optional[str] = Field(
        default=None,
        description="Customer account segment filter (e.g. 'retail', 'corporate').",
    )


@tool(
    name="detect_structuring",
    description=(
        "Rule-based structuring detector. Finds transactions clustered just below the "
        "regulatory reporting threshold within a rolling window. Returns the actual "
        "flagged transaction IDs, amounts, and timestamps as evidence so downstream "
        "tools can cite real numbers."
    ),
    schema=DetectStructuringArgs,
)
def detect_structuring(args: DetectStructuringArgs) -> dict:
    conn = get_connection()

    near_lo = args.threshold * (1.0 - args.threshold_band)
    near_hi = args.threshold

    # Date window
    if args.date_to:
        as_of = pd.Timestamp(args.date_to)
    else:
        row = conn.execute("SELECT MAX(timestamp) FROM transactions").fetchone()
        as_of = pd.Timestamp(row[0]) if row[0] else pd.Timestamp.now()
    window_start = as_of - pd.Timedelta(days=args.window_days)

    # Optional account, country, segment filters
    account_filter = ""
    if args.account_ids:
        ids_sql = ", ".join(f"'{a}'" for a in args.account_ids)
        account_filter += f" AND sender_account_id IN ({ids_sql})"
    if args.country:
        account_filter += f" AND country = '{args.country}'"

    # Count distinct senders in window (for reporting)
    accounts_scanned: int = conn.execute(
        f"""
        SELECT COUNT(DISTINCT sender_account_id)
        FROM transactions
        WHERE timestamp >= TIMESTAMP '{window_start.isoformat()}'
          AND timestamp <= TIMESTAMP '{as_of.isoformat()}'
          {account_filter}
        """
    ).fetchone()[0]

    # Pull all near-threshold transactions with computed fields
    df: pd.DataFrame = conn.execute(
        f"""
        SELECT
            transaction_id,
            sender_account_id  AS account_id,
            timestamp,
            amount,
            {near_hi!r} - amount           AS distance_from_threshold,
            ({near_hi!r} - amount) / {near_hi!r} * 100  AS pct_below_threshold
        FROM transactions
        WHERE timestamp >= TIMESTAMP '{window_start.isoformat()}'
          AND timestamp <= TIMESTAMP '{as_of.isoformat()}'
          AND amount >= {near_lo!r}
          AND amount <  {near_hi!r}
          {account_filter}
        ORDER BY account_id, timestamp
        """
    ).df()

    flagged_accounts: list[dict] = []
    for acct_id, grp in df.groupby("account_id"):
        txns = [
            {
                "transaction_id":         str(row["transaction_id"]),
                "amount":                  round(float(row["amount"]), 2),
                "timestamp":               str(row["timestamp"]),
                "distance_from_threshold": round(float(row["distance_from_threshold"]), 2),
                "pct_below_threshold":     round(float(row["pct_below_threshold"]), 2),
            }
            for _, row in grp.iterrows()
        ]
        flagged_accounts.append({
            "account_id":             str(acct_id),
            "near_threshold_txn_count": len(txns),
            "transactions":            txns,
            "total_amount_structured": round(float(grp["amount"].sum()), 2),
            "date_range": {
                "first": str(grp["timestamp"].min()),
                "last":  str(grp["timestamp"].max()),
            },
        })

    return {
        "threshold":        args.threshold,
        "threshold_band":   args.threshold_band,
        "near_lo":          round(near_lo, 2),
        "window_days":      args.window_days,
        "as_of":            str(as_of),
        "accounts_scanned": accounts_scanned,
        "flagged_accounts": flagged_accounts,
        "total_flagged":    len(flagged_accounts),
    }


# ---------------------------------------------------------------------------
# detect_anomalies
# ---------------------------------------------------------------------------

class DetectAnomaliesArgs(BaseModel):
    account_ids: Optional[list[str]] = Field(
        default=None,
        description="Restrict to these sender account IDs. None = all accounts.",
    )
    window_days: int = Field(default=30, ge=1, le=365)
    date_to: Optional[str] = Field(default=None)
    contamination: float = Field(
        default=0.1,
        ge=0.01,
        le=0.5,
        description="Expected fraction of anomalies (IsolationForest contamination param).",
    )
    n_estimators: int = Field(default=100, ge=10, le=500)


def _build_feature_matrix(
    conn,
    account_ids: Optional[list[str]],
    window_days: int,
    as_of: pd.Timestamp,
) -> pd.DataFrame:
    """Recompute per-account feature vectors (same logic as engineer_features tool)."""
    window_start = as_of - pd.Timedelta(days=window_days)
    account_filter = ""
    if account_ids:
        ids_sql = ", ".join(f"'{a}'" for a in account_ids)
        account_filter = f"AND sender_account_id IN ({ids_sql})"

    txn_df: pd.DataFrame = conn.execute(
        f"""
        SELECT sender_account_id AS account_id, timestamp, amount
        FROM transactions
        WHERE timestamp >= TIMESTAMP '{window_start.isoformat()}'
          AND timestamp <= TIMESTAMP '{as_of.isoformat()}'
          {account_filter}
        ORDER BY account_id, timestamp
        """
    ).df()

    if txn_df.empty:
        return pd.DataFrame()

    hist_df: pd.DataFrame = conn.execute(
        f"""
        SELECT sender_account_id AS account_id, AVG(amount) AS historical_avg
        FROM transactions
        {('WHERE sender_account_id IN (' + ', '.join(f"'{a}'" for a in account_ids) + ')') if account_ids else ''}
        GROUP BY account_id
        """
    ).df()
    historical_avg = dict(zip(hist_df["account_id"], hist_df["historical_avg"]))

    near_lo = _REPORTING_THRESHOLD * (1 - _DEFAULT_BAND)
    near_hi = _REPORTING_THRESHOLD

    records = []
    for acct_id, grp in txn_df.groupby("account_id"):
        amounts = grp["amount"]
        txn_count  = len(grp)
        total_vol  = float(amounts.sum())
        avg_amt    = float(amounts.mean())
        std_amt    = float(amounts.std(ddof=1)) if txn_count > 1 else 0.0
        velocity   = txn_count / window_days
        max_single = float(amounts.max())
        hist_avg   = historical_avg.get(acct_id, avg_amt)
        deviation_pct = ((avg_amt - hist_avg) / hist_avg * 100) if hist_avg else 0.0
        near_count = int(((amounts >= near_lo) & (amounts < near_hi)).sum())

        records.append({
            "account_id":           str(acct_id),
            "txn_count":            txn_count,
            "total_volume":         round(total_vol, 2),
            "avg_amount":           round(avg_amt, 2),
            "std_amount":           round(std_amt, 2),
            "velocity":             round(velocity, 4),
            "max_single_amount":    round(max_single, 2),
            "amount_deviation_pct": round(deviation_pct, 2),
            "near_threshold_count": near_count,
        })

    return pd.DataFrame(records)


@tool(
    name="detect_anomalies",
    description=(
        "Hybrid ML anomaly detection using IsolationForest over per-account feature "
        "vectors (velocity, rolling volume, amount deviation, near-threshold count). "
        "Returns a normalized anomaly score (0–1, higher = more anomalous) and the "
        "top contributing features per flagged account."
    ),
    schema=DetectAnomaliesArgs,
)
def detect_anomalies(args: DetectAnomaliesArgs) -> dict:
    conn = get_connection()

    if args.date_to:
        as_of = pd.Timestamp(args.date_to)
    else:
        row = conn.execute("SELECT MAX(timestamp) FROM transactions").fetchone()
        as_of = pd.Timestamp(row[0]) if row[0] else pd.Timestamp.now()

    feat_df = _build_feature_matrix(conn, args.account_ids, args.window_days, as_of)

    if feat_df.empty:
        return {
            "accounts_analyzed": 0,
            "window_days":       args.window_days,
            "contamination":     args.contamination,
            "flagged_accounts":  [],
            "all_scores":        [],
            "total_flagged":     0,
            "note":              "No data in the specified window.",
        }

    n_samples = len(feat_df)
    if n_samples < _MIN_IF_SAMPLES:
        logger.warning(
            "detect_anomalies: only %d samples — IsolationForest results unreliable", n_samples
        )

    X = feat_df[_FEATURE_COLS].fillna(0.0).values.astype(float)

    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    clf = IsolationForest(
        n_estimators=args.n_estimators,
        contamination=args.contamination,
        random_state=42,
    )
    clf.fit(X_scaled)

    # score_samples: lower = more anomalous; invert and normalise to [0, 1]
    raw_scores: np.ndarray = clf.score_samples(X_scaled)
    inverted = -raw_scores
    s_min, s_max = inverted.min(), inverted.max()
    if s_max > s_min:
        normalized = (inverted - s_min) / (s_max - s_min)
    else:
        normalized = np.full_like(inverted, 0.5)

    is_anomalous: np.ndarray = clf.predict(X_scaled) == -1  # -1 = anomaly in sklearn

    all_scores: list[dict] = []
    flagged_accounts: list[dict] = []

    for i in range(n_samples):
        score = round(float(normalized[i]), 4)
        anom  = bool(is_anomalous[i])
        acct  = str(feat_df.iloc[i]["account_id"])

        top_features = sorted(
            [
                {
                    "feature": col,
                    "value":   round(float(feat_df.iloc[i][col]), 4),
                    "zscore":  round(float(X_scaled[i, j]), 4),
                }
                for j, col in enumerate(_FEATURE_COLS)
            ],
            key=lambda x: abs(x["zscore"]),
            reverse=True,
        )[:3]

        record: dict = {"account_id": acct, "anomaly_score": score, "is_anomalous": anom}
        all_scores.append(record)
        if anom:
            flagged_accounts.append({**record, "top_features": top_features})

    return {
        "accounts_analyzed": n_samples,
        "window_days":       args.window_days,
        "contamination":     args.contamination,
        "flagged_accounts":  flagged_accounts,
        "all_scores":        all_scores,
        "total_flagged":     len(flagged_accounts),
    }
