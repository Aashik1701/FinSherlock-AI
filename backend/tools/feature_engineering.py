"""Feature engineering tool — registered in TOOL_REGISTRY."""

from __future__ import annotations

from typing import Optional

import pandas as pd
from pydantic import BaseModel, Field

from agent.registry import tool
from data.db import get_connection

# AML regulatory reporting threshold (USD). Structuring is defined as
# keeping transactions just below this amount to avoid a Currency Transaction Report.
_REPORTING_THRESHOLD = 10_000.0
_NEAR_THRESHOLD_BAND = 0.05   # 5 % below → txns ≥ 9 500 and < 10 000


class FeatureEngineeringArgs(BaseModel):
    account_ids: Optional[list[str]] = Field(
        default=None,
        description="Restrict computation to these sender_account_ids. None = all accounts.",
    )
    window_days: int = Field(
        default=30,
        ge=1,
        le=365,
        description="Rolling look-back window in days for velocity/sum features.",
    )
    date_to: Optional[str] = Field(
        default=None,
        description=(
            "Compute features as-of this ISO-8601 date. "
            "Defaults to the latest timestamp in the dataset."
        ),
    )
    persist: bool = Field(
        default=True,
        description="If True, write results into the account_features table in DuckDB.",
    )


@tool(
    name="engineer_features",
    description=(
        "Compute per-account features: rolling transaction count, total volume, "
        "average and std-dev of amount, velocity (txns/day), maximum single amount, "
        "amount deviation from historical average, and near-threshold transaction count. "
        "Results can be persisted to DuckDB for downstream anomaly detection."
    ),
    schema=FeatureEngineeringArgs,
)
def engineer_features(args: FeatureEngineeringArgs) -> dict:
    conn = get_connection()

    # --- Determine the reference date ceiling ---
    if args.date_to:
        as_of = pd.Timestamp(args.date_to)
    else:
        row = conn.execute("SELECT MAX(timestamp) FROM transactions").fetchone()
        as_of = pd.Timestamp(row[0]) if row[0] else pd.Timestamp.now()

    window_start = as_of - pd.Timedelta(days=args.window_days)

    # ── Cache read — all-accounts path ────────────────────────────────────────
    # When no account_ids filter and no custom date_to are set, serve from the
    # pre-computed account_features table (written by scripts/precompute_features.py
    # at load time).  This avoids the 60-80s pandas groupby on millions of rows.
    # Single-account queries and custom date_to queries still recompute live.
    if args.account_ids is None and not args.date_to:
        as_of_str = str(as_of)[:19]
        cached_count = conn.execute(
            f"SELECT COUNT(*) FROM account_features "
            f"WHERE window_days = {args.window_days} AND computed_at = TIMESTAMP '{as_of_str}'",
        ).fetchone()[0]

        if cached_count > 0:
            cached_df = conn.execute(
                f"""
                SELECT account_id, window_days, computed_at,
                       txn_count, total_volume, avg_amount, std_amount,
                       velocity, max_single_amount, amount_deviation_pct,
                       near_threshold_count
                FROM account_features
                WHERE window_days = {args.window_days}
                  AND computed_at = TIMESTAMP '{as_of_str}'
                ORDER BY near_threshold_count DESC, ABS(amount_deviation_pct) DESC
                """
            ).df()
            records = cached_df.to_dict("records")
            # Normalise types that DuckDB returns as non-JSON-serialisable objects
            for r in records:
                r["computed_at"] = str(r["computed_at"])
                for k in ("txn_count", "near_threshold_count"):
                    if r[k] is not None:
                        r[k] = int(r[k])
                for k in ("total_volume", "avg_amount", "std_amount", "velocity",
                          "max_single_amount", "amount_deviation_pct"):
                    if r[k] is not None:
                        r[k] = round(float(r[k]), 4)
            return {
                "as_of":              str(as_of),
                "window_days":        args.window_days,
                "window_start":       str(window_start),
                "accounts_processed": len(records),
                "persisted":          True,
                "from_cache":         True,
                "features":           records,
            }

    # --- Pull raw transactions within the window ---
    account_filter = ""
    if args.account_ids:
        ids_sql = ", ".join(f"'{a}'" for a in args.account_ids)
        account_filter = f"AND sender_account_id IN ({ids_sql})"

    txn_df: pd.DataFrame = conn.execute(
        f"""
        SELECT
            sender_account_id AS account_id,
            timestamp,
            amount
        FROM transactions
        WHERE timestamp >= TIMESTAMP '{window_start.isoformat()}'
          AND timestamp <= TIMESTAMP '{as_of.isoformat()}'
          {account_filter}
        ORDER BY sender_account_id, timestamp
        """
    ).df()

    if txn_df.empty:
        return {
            "as_of": str(as_of),
            "window_days": args.window_days,
            "accounts_processed": 0,
            "features": [],
        }

    # --- Historical average per account (full history, not just the window) ---
    hist_df: pd.DataFrame = conn.execute(
        f"""
        SELECT sender_account_id AS account_id, AVG(amount) AS historical_avg
        FROM transactions
        {('WHERE sender_account_id IN (' + ', '.join(f"'{a}'" for a in args.account_ids) + ')') if args.account_ids else ''}
        GROUP BY sender_account_id
        """
    ).df()
    historical_avg = dict(zip(hist_df["account_id"], hist_df["historical_avg"]))

    # --- Compute features per account using pandas groupby ---
    near_lo = _REPORTING_THRESHOLD * (1 - _NEAR_THRESHOLD_BAND)
    near_hi = _REPORTING_THRESHOLD

    records: list[dict] = []
    for account_id, grp in txn_df.groupby("account_id"):
        amounts = grp["amount"]
        txn_count  = len(grp)
        total_vol  = float(amounts.sum())
        avg_amt    = float(amounts.mean())
        std_amt    = float(amounts.std(ddof=1)) if txn_count > 1 else 0.0
        velocity   = round(txn_count / args.window_days, 4)
        max_single = float(amounts.max())
        hist_avg   = historical_avg.get(account_id, avg_amt)

        # Deviation from long-run average (guard against div-by-zero)
        if hist_avg and hist_avg != 0:
            deviation_pct = round((avg_amt - hist_avg) / hist_avg * 100, 2)
        else:
            deviation_pct = 0.0

        near_thresh_count = int(((amounts >= near_lo) & (amounts < near_hi)).sum())

        records.append({
            "account_id":           account_id,
            "window_days":          args.window_days,
            "computed_at":          str(as_of),
            "txn_count":            txn_count,
            "total_volume":         round(total_vol, 2),
            "avg_amount":           round(avg_amt, 2),
            "std_amount":           round(std_amt, 2),
            "velocity":             velocity,
            "max_single_amount":    round(max_single, 2),
            "amount_deviation_pct": deviation_pct,
            "near_threshold_count": near_thresh_count,
        })

    # --- Optionally persist to DuckDB ---
    if args.persist and records:
        feat_df = pd.DataFrame(records)
        conn.execute(
            """
            INSERT OR REPLACE INTO account_features
            SELECT * FROM feat_df
            """
        )
        conn.commit()

    # Sort by risk signal descending for readability (near-threshold + deviation)
    records.sort(
        key=lambda r: (r["near_threshold_count"], abs(r["amount_deviation_pct"])),
        reverse=True,
    )

    return {
        "as_of":               str(as_of),
        "window_days":         args.window_days,
        "window_start":        str(window_start),
        "accounts_processed":  len(records),
        "persisted":           args.persist,
        "features":            records,
    }
