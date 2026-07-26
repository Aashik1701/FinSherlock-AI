#!/usr/bin/env python3
"""
Pre-compute per-account feature vectors using DuckDB SQL aggregations.

Run immediately after load_data.py to warm the account_features cache so that
engineer_features (and any downstream tool) can serve the all-accounts path in
milliseconds instead of the 60-80s pandas groupby path.

Usage (from backend/):
    .venv/bin/python scripts/precompute_features.py
    .venv/bin/python scripts/precompute_features.py --windows 7,30,90
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from data.db import get_connection

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
logger = logging.getLogger(__name__)

# BSA structuring thresholds — must match tools/feature_engineering.py
_REPORTING_THRESHOLD: float = 10_000.0
_NEAR_THRESHOLD_BAND: float = 0.05
_NEAR_LO: float = _REPORTING_THRESHOLD * (1 - _NEAR_THRESHOLD_BAND)  # 9 500.0
_NEAR_HI: float = _REPORTING_THRESHOLD                                 # 10 000.0


def _fmt_ts(ts) -> str:
    """Format a Python datetime/Timestamp to 'YYYY-MM-DD HH:MM:SS' for SQL literals."""
    return str(ts)[:19]


def precompute(window_days_list: list[int] = (7, 30, 60, 90)) -> dict:
    """
    Compute per-account feature vectors for every account in the DB for each
    window in window_days_list.  Uses a single DuckDB SQL query per window
    (no pandas) — runs in seconds even on 5M rows.

    Returns a summary dict: {window_days: {"accounts": N, "elapsed_s": T}}.
    """
    conn = get_connection()

    # ── Dataset stats ──────────────────────────────────────────────────────────
    total_txns = conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
    if total_txns == 0:
        print("No transactions found. Run load_data.py first.")
        return {}

    as_of_raw = conn.execute("SELECT MAX(timestamp) FROM transactions").fetchone()[0]
    as_of_str = _fmt_ts(as_of_raw)

    total_accounts = conn.execute(
        "SELECT COUNT(DISTINCT sender_account_id) FROM transactions"
    ).fetchone()[0]

    print(f"\nPre-computing features")
    print(f"  Transactions : {total_txns:>12,}")
    print(f"  Accounts     : {total_accounts:>12,}")
    print(f"  as_of        : {as_of_str}")
    print(f"  Windows      : {list(window_days_list)}")
    print()

    # ── Historical average — full dataset scan, computed once ──────────────────
    print("  Building historical averages (full dataset) ...", end="", flush=True)
    t0 = time.time()
    conn.execute("""
        CREATE OR REPLACE TEMP TABLE _hist_avg AS
        SELECT sender_account_id, AVG(amount) AS historical_avg
        FROM transactions
        GROUP BY sender_account_id
    """)
    print(f" {time.time() - t0:.1f}s")

    results: dict[int, dict] = {}

    for window_days in window_days_list:
        import pandas as pd
        window_start = pd.Timestamp(as_of_raw) - pd.Timedelta(days=window_days)
        window_start_str = _fmt_ts(window_start)

        print(f"  Window {window_days:>3}d  [{window_start_str} → {as_of_str}] ...", end="", flush=True)
        t0 = time.time()

        # Delete any existing pre-computed data for this window+as_of combination
        conn.execute(
            f"DELETE FROM account_features "
            f"WHERE window_days = {window_days} AND computed_at = TIMESTAMP '{as_of_str}'"
        )

        # Single SQL aggregation — no Python loop over accounts
        conn.execute(f"""
            INSERT INTO account_features
            SELECT
                w.sender_account_id                              AS account_id,
                {window_days}                                    AS window_days,
                TIMESTAMP '{as_of_str}'                          AS computed_at,
                w.txn_count,
                ROUND(w.total_volume,     2)                     AS total_volume,
                ROUND(w.avg_amount,       2)                     AS avg_amount,
                ROUND(COALESCE(w.std_amount, 0.0), 2)            AS std_amount,
                ROUND(CAST(w.txn_count AS DOUBLE) / {window_days}, 4) AS velocity,
                ROUND(w.max_single_amount, 2)                    AS max_single_amount,
                ROUND(
                    CASE
                        WHEN h.historical_avg IS NOT NULL
                         AND h.historical_avg <> 0
                        THEN (w.avg_amount - h.historical_avg)
                             / h.historical_avg * 100.0
                        ELSE 0.0
                    END, 2
                )                                                AS amount_deviation_pct,
                w.near_threshold_count
            FROM (
                SELECT
                    sender_account_id,
                    COUNT(*)                                     AS txn_count,
                    SUM(amount)                                  AS total_volume,
                    AVG(amount)                                  AS avg_amount,
                    STDDEV_SAMP(amount)                          AS std_amount,
                    MAX(amount)                                  AS max_single_amount,
                    SUM(CASE WHEN amount >= {_NEAR_LO!r}
                              AND amount <  {_NEAR_HI!r}
                         THEN 1 ELSE 0 END)                     AS near_threshold_count
                FROM transactions
                WHERE timestamp >= TIMESTAMP '{window_start_str}'
                  AND timestamp <= TIMESTAMP '{as_of_str}'
                GROUP BY sender_account_id
            ) w
            LEFT JOIN _hist_avg h
                   ON w.sender_account_id = h.sender_account_id
        """)

        n = conn.execute(
            f"SELECT COUNT(*) FROM account_features "
            f"WHERE window_days = {window_days} AND computed_at = TIMESTAMP '{as_of_str}'"
        ).fetchone()[0]

        elapsed = time.time() - t0
        results[window_days] = {"accounts": n, "elapsed_s": round(elapsed, 2)}
        print(f" {n:,} accounts in {elapsed:.1f}s")

    conn.commit()
    conn.execute("DROP TABLE IF EXISTS _hist_avg")

    print()
    total_rows = sum(r["accounts"] for r in results.values())
    print(f"  Done. {total_rows:,} rows written to account_features.")
    return results


def main():
    parser = argparse.ArgumentParser(description="Pre-compute account_features from DuckDB")
    parser.add_argument(
        "--windows",
        default="7,30,60,90",
        help="Comma-separated list of window_days to compute (default: 7,30,60,90)",
    )
    args = parser.parse_args()
    windows = [int(w.strip()) for w in args.windows.split(",")]
    precompute(windows)


if __name__ == "__main__":
    main()
