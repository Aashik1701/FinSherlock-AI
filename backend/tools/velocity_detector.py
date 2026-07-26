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

    # ── 1. Determine time window ──────────────────────────────────────────────
    row = conn.execute("SELECT MAX(timestamp) FROM transactions").fetchone()
    if row[0] is None:
        return {"flagged_accounts": [], "accounts_scanned": 0, "note": "No transaction data."}

    as_of = pd.Timestamp(args.date_to) if args.date_to else pd.Timestamp(row[0])
    baseline_days = max(args.baseline_days, args.window_days + 1)
    hist_start    = as_of - pd.Timedelta(days=baseline_days)
    recent_start  = as_of - pd.Timedelta(days=args.window_days)

    # ── 2. Account filter ─────────────────────────────────────────────────────
    account_filter = ""
    if args.account_ids:
        ids_sql = ", ".join(f"'{aid}'" for aid in args.account_ids)
        account_filter = f"AND sender_account_id IN ({ids_sql})"

    # ── 3. Load all transactions in baseline window ───────────────────────────
    df: pd.DataFrame = conn.execute(
        f"""
        SELECT
            sender_account_id AS account_id,
            timestamp,
            amount
        FROM transactions
        WHERE timestamp >= TIMESTAMP '{hist_start.isoformat()}'
          AND timestamp <= TIMESTAMP '{as_of.isoformat()}'
          {account_filter}
        ORDER BY timestamp
        """
    ).df()

    if df.empty:
        return {"flagged_accounts": [], "accounts_scanned": 0, "note": "No transactions in window."}

    df["timestamp"] = pd.to_datetime(df["timestamp"])
    df["date"]      = df["timestamp"].dt.date

    # ── 4. Compute per-account velocities ─────────────────────────────────────
    recent_cutoff = recent_start.date()
    hist_cutoff   = hist_start.date()

    recent_df = df[df["timestamp"] >= recent_start]
    hist_df   = df[df["timestamp"] <  recent_start]

    # Recent: txns/day in the recent window
    recent_stats = (
        recent_df.groupby("account_id")
        .agg(
            txn_count_recent=("amount", "count"),
            total_volume_recent=("amount", "sum"),
        )
        .reset_index()
    )
    recent_stats["current_velocity"] = recent_stats["txn_count_recent"] / max(args.window_days, 1)

    # Historical: txns/day in the baseline window (before recent)
    hist_baseline_days = baseline_days - args.window_days
    hist_stats = (
        hist_df.groupby("account_id")
        .agg(txn_count_hist=("amount", "count"))
        .reset_index()
    )
    hist_stats["baseline_velocity"] = hist_stats["txn_count_hist"] / max(hist_baseline_days, 1)

    # ── 5. Merge and compute spike ratio ──────────────────────────────────────
    merged = recent_stats.merge(hist_stats, on="account_id", how="left").fillna(0)
    merged["spike_ratio"] = merged.apply(
        lambda r: (
            r["current_velocity"] / r["baseline_velocity"]
            if r["baseline_velocity"] > 0
            else (r["current_velocity"] / 1.0)   # no history → treat as spike if high abs
        ),
        axis=1,
    )

    # Filter to spikes: must meet ratio OR absolute threshold
    threshold = args.spike_ratio
    spiked = merged[
        (merged["spike_ratio"] >= threshold) |
        (merged["current_velocity"] >= _MIN_ABS_VELOCITY)
    ].copy()

    if spiked.empty:
        return {
            "flagged_accounts": [],
            "accounts_scanned": int(df["account_id"].nunique()),
            "spike_ratio_threshold": threshold,
            "window_days": args.window_days,
            "baseline_days": baseline_days,
        }

    # ── 6. Determine spike start date ─────────────────────────────────────────
    # For each account: first date in recent window where daily count > baseline_velocity
    spike_dates: dict[str, str] = {}
    for account_id in spiked["account_id"]:
        acct_recent = recent_df[recent_df["account_id"] == account_id]
        daily = acct_recent.groupby("date")["amount"].count()
        if not daily.empty:
            spike_dates[account_id] = str(daily.index[0])
        else:
            spike_dates[account_id] = str(recent_start.date())

    spiked["spike_date"] = spiked["account_id"].map(spike_dates)

    # ── 7. Risk classification ────────────────────────────────────────────────
    def _classify(row) -> tuple[str, str]:
        if row["spike_ratio"] >= threshold * 2 or row["current_velocity"] >= _MIN_ABS_VELOCITY * 2:
            return "high", "report"
        return "medium", "review"

    spiked[["risk_level", "escalation"]] = spiked.apply(
        lambda r: pd.Series(_classify(r)), axis=1
    )

    # ── 8. Sort and truncate ──────────────────────────────────────────────────
    spiked = spiked.sort_values("spike_ratio", ascending=False).head(args.top_n)

    flagged = []
    for _, row in spiked.iterrows():
        flagged.append({
            "account_id":              str(row["account_id"]),
            "current_velocity_per_day": round(float(row["current_velocity"]), 3),
            "baseline_velocity_per_day": round(float(row["baseline_velocity"]), 3),
            "spike_ratio":             round(float(row["spike_ratio"]), 2),
            "spike_date":              str(row["spike_date"]),
            "txn_count_recent":        int(row["txn_count_recent"]),
            "total_volume_recent_usd": round(float(row["total_volume_recent"]), 2),
            "risk_level":              row["risk_level"],
            "escalation":              row["escalation"],
        })

    return {
        "flagged_accounts":        flagged,
        "accounts_scanned":        int(df["account_id"].nunique()),
        "spike_ratio_threshold":   threshold,
        "window_days":             args.window_days,
        "baseline_days":           baseline_days,
        "as_of":                   str(as_of),
    }
