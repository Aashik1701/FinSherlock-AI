"""EDA tool — registered in TOOL_REGISTRY."""

from __future__ import annotations

from typing import Optional

import pandas as pd
from pydantic import BaseModel, Field

from agent.registry import tool
from data.db import get_connection


class EDAArgs(BaseModel):
    date_from: Optional[str] = Field(
        default=None,
        description="ISO-8601 start date filter, e.g. '2022-01-01' (inclusive)",
    )
    date_to: Optional[str] = Field(
        default=None,
        description="ISO-8601 end date filter, e.g. '2022-03-31' (inclusive)",
    )
    sample_limit: int = Field(
        default=0,
        description="Cap the rows read (0 = no limit). Useful for quick checks.",
    )


@tool(
    name="run_eda",
    description=(
        "Exploratory data analysis: row counts, date range, transaction-type "
        "breakdown, top countries, missing-value report, and amount statistics. "
        "Run this first when the analyst asks for a broad overview."
    ),
    schema=EDAArgs,
)
def run_eda(args: EDAArgs) -> dict:
    conn = get_connection()

    # Build WHERE clause from optional date filters
    where_parts: list[str] = []
    if args.date_from:
        where_parts.append(f"timestamp >= TIMESTAMP '{args.date_from}'")
    if args.date_to:
        where_parts.append(f"timestamp <= TIMESTAMP '{args.date_to} 23:59:59'")
    limit_clause = f"LIMIT {args.sample_limit}" if args.sample_limit > 0 else ""
    where_clause = "WHERE " + " AND ".join(where_parts) if where_parts else ""

    base_query = f"FROM transactions {where_clause} {limit_clause}"

    # --- Row count ---
    total_rows: int = conn.execute(f"SELECT COUNT(*) {base_query}").fetchone()[0]

    if total_rows == 0:
        return {"total_rows": 0, "warning": "No rows match the applied filters."}

    # --- Date range ---
    date_row = conn.execute(
        f"SELECT MIN(timestamp), MAX(timestamp) {base_query}"
    ).fetchone()
    date_range = {
        "earliest": str(date_row[0]) if date_row[0] else None,
        "latest":   str(date_row[1]) if date_row[1] else None,
    }

    # --- Transaction-type breakdown ---
    txn_type_df: pd.DataFrame = conn.execute(
        f"""
        SELECT
            COALESCE(transaction_type, 'UNKNOWN') AS transaction_type,
            COUNT(*) AS count,
            ROUND(COUNT(*) * 100.0 / {total_rows}, 2) AS pct
        {base_query}
        GROUP BY transaction_type
        ORDER BY count DESC
        """
    ).df()
    txn_type_breakdown = txn_type_df.to_dict(orient="records")

    # --- Top 10 countries ---
    country_df: pd.DataFrame = conn.execute(
        f"""
        SELECT
            COALESCE(country, 'UNKNOWN') AS country,
            COUNT(*) AS count
        {base_query}
        GROUP BY country
        ORDER BY count DESC
        LIMIT 10
        """
    ).df()
    top_countries = country_df.to_dict(orient="records")

    # --- Amount statistics ---
    amt_row = conn.execute(
        f"""
        SELECT
            MIN(amount), MAX(amount), AVG(amount),
            MEDIAN(amount), STDDEV(amount)
        {base_query}
        """
    ).fetchone()
    amount_stats = {
        "min":    round(amt_row[0] or 0, 2),
        "max":    round(amt_row[1] or 0, 2),
        "mean":   round(amt_row[2] or 0, 2),
        "median": round(amt_row[3] or 0, 2),
        "stddev": round(amt_row[4] or 0, 2),
    }

    # --- Missing values (NULL counts per column) ---
    columns = [
        "transaction_id", "timestamp", "sender_account_id", "receiver_account_id",
        "amount", "currency", "transaction_type", "country", "channel", "is_laundering",
    ]
    null_exprs = ", ".join(
        f"SUM(CASE WHEN {c} IS NULL THEN 1 ELSE 0 END) AS {c}" for c in columns
    )
    null_row = conn.execute(f"SELECT {null_exprs} {base_query}").fetchone()
    missing_values = {
        col: {"null_count": null_row[i], "null_pct": round(null_row[i] * 100 / total_rows, 2)}
        for i, col in enumerate(columns)
    }

    # --- Laundering label distribution (if column is populated) ---
    label_dist = None
    labeled_count: int = conn.execute(
        f"SELECT COUNT(*) {base_query} AND is_laundering IS NOT NULL"
        if where_clause
        else f"SELECT COUNT(*) FROM transactions WHERE is_laundering IS NOT NULL {limit_clause}"
    ).fetchone()[0]

    if labeled_count > 0:
        label_df = conn.execute(
            f"""
            SELECT is_laundering, COUNT(*) AS count
            {base_query}
            {"AND" if where_clause else "WHERE"} is_laundering IS NOT NULL
            GROUP BY is_laundering
            """
        ).df()
        label_dist = label_df.to_dict(orient="records")

    return {
        "total_rows":           total_rows,
        "date_range":           date_range,
        "filters_applied":      {"date_from": args.date_from, "date_to": args.date_to},
        "transaction_type_breakdown": txn_type_breakdown,
        "top_countries":        top_countries,
        "amount_stats":         amount_stats,
        "missing_values":       missing_values,
        "laundering_label_dist": label_dist,
    }
