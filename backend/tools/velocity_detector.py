"""
Velocity spike detection tool — registered in TOOL_REGISTRY.

Detects accounts that show a sudden, abnormal surge in transaction frequency
compared to their own historical baseline. This is one of the top FinCEN SAR
triggers and a required "velocity" feature in the PS.

Algorithm:
  1. Compute rolling 7-day transaction count per account (current window)
  2. Compute 90-day historical baseline (or max available history)
  3. Flag accounts where current velocity > SPIKE_RATIO_THRESHOLD × baseline
  4. Also flag accounts where absolute velocity > MIN_ABS_VELOCITY txns/day

Output per spiked account:
  - account_id
  - current_velocity_per_day: txns/day in the recent window
  - baseline_velocity_per_day: historical average
  - spike_ratio: current / baseline
  - spike_date: first day of the spike window
  - txn_count_recent: raw count in recent window
  - total_volume_recent: USD volume in recent window
  - risk_level: medium / high
  - escalation: review / report
"""

from __future__ import annotations

import logging
from typing import Optional

import pandas as pd
from pydantic import BaseModel, Field

from agent.registry import tool
from data.db import get_connection

logger = logging.getLogger(__name__)

# ─── Thresholds ───────────────────────────────────────────────────────────────
_SPIKE_RATIO_THRESHOLD:   float = 3.0   # current must be ≥ 3× baseline
_MIN_ABS_VELOCITY:        float = 5.0   # OR ≥ 5 txns/day absolute
_MIN_BASELINE_TXNS:       int   = 3     # skip accounts with < 3 hist txns (too noisy)
_RECENT_WINDOW_DAYS:      int   = 7     # "recent" window for current velocity
_HISTORICAL_WINDOW_DAYS:  int   = 90    # look-back for baseline


class DetectVelocitySpikesArgs(BaseModel):
    window_days: int = Field(
        default=7,
        description="Recent window (days) to compute current transaction velocity.",
    )
    baseline_days: int = Field(
        default=90,
        description="Historical baseline window (days) to compute expected velocity.",
    )
    spike_ratio: float = Field(
        default=3.0,
        description="Minimum ratio of current velocity to baseline to flag a spike.",
    )
    top_n: int = Field(
        default=20,
        description="Return at most this many spiked accounts.",
    )
    account_ids: Optional[list[str]] = Field(
        default=None,
        description="Restrict analysis to specific account IDs.",
    )
    date_to: Optional[str] = Field(
        default=None,
        description="End date for the analysis window (ISO 8601).",
    )


@tool(
    name="detect_velocity_spikes",
    description=(
        "Detects accounts with sudden abnormal surges in transaction frequency "
        "('velocity spikes') relative to their own 90-day historical baseline. "
        "Flags accounts where current 7-day velocity exceeds the baseline by "
        "≥3× — one of the top FinCEN SAR trigger patterns. Returns spike_ratio, "
        "baseline_velocity, current_velocity, spike_date, and risk level per account."
    ),
    schema=DetectVelocitySpikesArgs,
)
def detect_velocity_spikes(args: DetectVelocitySpikesArgs) -> dict:
    conn = get_connection()

    # ── 1. Determine as_of date ───────────────────────────────────────────────
    # Use the last date that had ≥ 1000 transactions (dense IBM data) rather
    # than MAX(timestamp), which is skewed by sparse outlier/mystery rows.
    if args.date_to:
        as_of = pd.Timestamp(args.date_to)
    else:
        bulk_row = conn.execute("""
            SELECT MAX(ts_date) FROM (
                SELECT CAST(timestamp AS DATE) AS ts_date, COUNT(*) AS n
                FROM transactions
                GROUP BY ts_date
                HAVING COUNT(*) >= 1000
            ) t
        """).fetchone()
        if bulk_row[0] is None:
            return {"flagged_accounts": [], "accounts_scanned": 0, "note": "No transaction data."}
        as_of = pd.Timestamp(bulk_row[0])

    baseline_days     = max(args.baseline_days, args.window_days + 1)
    hist_baseline_days = baseline_days - args.window_days
    hist_start        = as_of - pd.Timedelta(days=baseline_days)
    recent_start      = as_of - pd.Timedelta(days=args.window_days)
    threshold         = args.spike_ratio

    # ── 2. Account filter ─────────────────────────────────────────────────────
    account_filter = ""
    if args.account_ids:
        ids_sql = ", ".join(f"'{aid}'" for aid in args.account_ids)
        account_filter = f"AND sender_account_id IN ({ids_sql})"

    # ── 3. All aggregation in DuckDB — no raw rows loaded into Python ─────────
    # accounts_scanned is folded into the recent CTE to avoid a second table scan.
    result_df: pd.DataFrame = conn.execute(f"""
        WITH recent AS (
            SELECT
                sender_account_id                            AS account_id,
                COUNT(*)                                     AS txn_count_recent,
                SUM(amount)                                  AS total_volume_recent,
                CAST(MIN(timestamp) AS DATE)                 AS spike_date,
                COUNT(*)::DOUBLE / {max(args.window_days, 1)} AS current_velocity
            FROM transactions
            WHERE timestamp >= TIMESTAMP '{recent_start.isoformat()}'
              AND timestamp <= TIMESTAMP '{as_of.isoformat()}'
              {account_filter}
            GROUP BY sender_account_id
        ),
        hist AS (
            SELECT
                sender_account_id                                AS account_id,
                COUNT(*)::DOUBLE / {max(hist_baseline_days, 1)}  AS baseline_velocity
            FROM transactions
            WHERE timestamp >= TIMESTAMP '{hist_start.isoformat()}'
              AND timestamp <  TIMESTAMP '{recent_start.isoformat()}'
              {account_filter}
            GROUP BY sender_account_id
        ),
        combined AS (
            SELECT
                r.account_id,
                r.txn_count_recent,
                r.total_volume_recent,
                r.spike_date,
                r.current_velocity,
                COALESCE(h.baseline_velocity, 0.0) AS baseline_velocity,
                CASE
                    WHEN COALESCE(h.baseline_velocity, 0) > 0
                    THEN r.current_velocity / h.baseline_velocity
                    ELSE r.current_velocity
                END AS spike_ratio
            FROM recent r
            LEFT JOIN hist h ON r.account_id = h.account_id
        )
        SELECT *, (SELECT COUNT(*) FROM recent) AS accounts_scanned
        FROM combined
        WHERE spike_ratio      >= {threshold}
           OR current_velocity >= {_MIN_ABS_VELOCITY}
        ORDER BY spike_ratio DESC
        LIMIT {args.top_n}
    """).df()

    accounts_scanned: int = int(result_df["accounts_scanned"].iloc[0]) if not result_df.empty else conn.execute(f"""
        SELECT COUNT(DISTINCT sender_account_id) FROM transactions
        WHERE timestamp >= TIMESTAMP '{recent_start.isoformat()}'
          AND timestamp <= TIMESTAMP '{as_of.isoformat()}'
          {account_filter}
    """).fetchone()[0]

    if result_df.empty:
        return {
            "flagged_accounts":      [],
            "accounts_scanned":      accounts_scanned,
            "spike_ratio_threshold": threshold,
            "window_days":           args.window_days,
            "baseline_days":         baseline_days,
            "as_of":                 str(as_of.date()),
        }

    # ── 4. Risk classification ────────────────────────────────────────────────
    flagged = []
    for _, row in result_df.iterrows():
        is_high = (row["spike_ratio"] >= threshold * 2) or (row["current_velocity"] >= _MIN_ABS_VELOCITY * 2)
        flagged.append({
            "account_id":               str(row["account_id"]),
            "current_velocity_per_day": round(float(row["current_velocity"]), 3),
            "baseline_velocity_per_day": round(float(row["baseline_velocity"]), 3),
            "spike_ratio":              round(float(row["spike_ratio"]), 2),
            "spike_date":               str(row["spike_date"]),
            "txn_count_recent":         int(row["txn_count_recent"]),
            "total_volume_recent_usd":  round(float(row["total_volume_recent"]), 2),
            "risk_level":               "high" if is_high else "medium",
            "escalation":               "report" if is_high else "review",
        })

    return {
        "flagged_accounts":      flagged,
        "accounts_scanned":      accounts_scanned,
        "spike_ratio_threshold": threshold,
        "window_days":           args.window_days,
        "baseline_days":         baseline_days,
        "as_of":                 str(as_of.date()),
    }
