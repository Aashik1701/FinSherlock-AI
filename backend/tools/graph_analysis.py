"""
Graph-based AML detection tools.

Two tools:
  detect_smurfing  — directed account graph, flags fan-out / fan-in degree anomalies
  detect_layering  — time-constrained multi-hop path detection with networkx + DFS
"""

from __future__ import annotations

import logging
from collections import defaultdict
from typing import Optional

import networkx as nx
import pandas as pd
from pydantic import BaseModel, Field

from agent.registry import tool
from data.db import get_connection

logger = logging.getLogger(__name__)

_DEFAULT_FAN_THRESHOLD: int = 3
_DEFAULT_MIN_HOPS: int = 3
_DEFAULT_MAX_GAP_HOURS: float = 24.0


# =============================================================================
# detect_smurfing
# =============================================================================

class DetectSmurfingArgs(BaseModel):
    account_ids: Optional[list[str]] = Field(
        default=None,
        description="Accounts to check. None = all accounts in the window.",
    )
    window_days: int = Field(default=30, ge=1, le=365)
    fan_out_threshold: int = Field(
        default=_DEFAULT_FAN_THRESHOLD,
        ge=2,
        description="Minimum distinct receivers to flag an account for fan-out.",
    )
    fan_in_threshold: int = Field(
        default=_DEFAULT_FAN_THRESHOLD,
        ge=2,
        description="Minimum distinct senders to flag an account for fan-in.",
    )
    date_to: Optional[str] = Field(
        default=None,
        description="ISO-8601 upper date bound. Defaults to latest timestamp in dataset.",
    )


@tool(
    name="detect_smurfing",
    description=(
        "Graph-based smurfing detector. Builds a directed account-transfer graph over a "
        "rolling window using networkx and flags accounts whose fan-out degree (distinct "
        "counterparties sent to) or fan-in degree (distinct counterparties received from) "
        "exceeds a configurable threshold. Returns the flagged account, the full counterparty "
        "list, and total amount as evidence for downstream classification."
    ),
    schema=DetectSmurfingArgs,
)
def detect_smurfing(args: DetectSmurfingArgs) -> dict:
    conn = get_connection()

    row = conn.execute("SELECT MAX(timestamp) FROM transactions").fetchone()
    if row[0] is None:
        return {
            "window_days":       args.window_days,
            "fan_out_threshold": args.fan_out_threshold,
            "fan_in_threshold":  args.fan_in_threshold,
            "flagged_accounts":  [],
            "total_flagged":     0,
        }

    as_of        = pd.Timestamp(args.date_to) if args.date_to else pd.Timestamp(row[0])
    window_start = as_of - pd.Timedelta(days=args.window_days)

    account_filter = ""
    if args.account_ids:
        ids_sql = ", ".join(f"'{a}'" for a in args.account_ids)
        account_filter = (
            f"AND (sender_account_id IN ({ids_sql}) OR receiver_account_id IN ({ids_sql}))"
        )

    df: pd.DataFrame = conn.execute(
        f"""
        SELECT
            transaction_id,
            sender_account_id,
            receiver_account_id,
            amount,
            timestamp
        FROM transactions
        WHERE timestamp >= TIMESTAMP '{window_start.isoformat()}'
          AND timestamp <= TIMESTAMP '{as_of.isoformat()}'
          {account_filter}
        ORDER BY timestamp
        """
    ).df()

    if df.empty:
        return {
            "window_days":       args.window_days,
            "fan_out_threshold": args.fan_out_threshold,
            "fan_in_threshold":  args.fan_in_threshold,
            "flagged_accounts":  [],
            "total_flagged":     0,
        }

    # ── Build directed multigraph (multiple transfers between same pair are valid) ──
    G: nx.MultiDiGraph = nx.MultiDiGraph()
    for _, row_data in df.iterrows():
        G.add_edge(
            str(row_data["sender_account_id"]),
            str(row_data["receiver_account_id"]),
            key=str(row_data["transaction_id"]),
            amount=float(row_data["amount"]),
            timestamp=row_data["timestamp"],
        )

    candidates = set(G.nodes())
    if args.account_ids:
        candidates = candidates & set(args.account_ids)

    flagged_accounts: list[dict] = []
    for account_id in sorted(candidates):
        # networkx successors/predecessors return distinct adjacent nodes
        successors   = sorted(G.successors(account_id))
        predecessors = sorted(G.predecessors(account_id))
        fan_out_degree = len(successors)
        fan_in_degree  = len(predecessors)

        if fan_out_degree >= args.fan_out_threshold or fan_in_degree >= args.fan_in_threshold:
            total_sent = sum(
                data["amount"] for _, _, data in G.out_edges(account_id, data=True)
            )
            total_received = sum(
                data["amount"] for _, _, data in G.in_edges(account_id, data=True)
            )
            flagged_accounts.append({
                "account_id":                   account_id,
                "fan_out_degree":               fan_out_degree,
                "fan_in_degree":                fan_in_degree,
                "counterparties_sent_to":       successors,
                "counterparties_received_from": predecessors,
                "total_sent":                   round(total_sent, 2),
                "total_received":               round(total_received, 2),
            })

    flagged_accounts.sort(
        key=lambda x: max(x["fan_out_degree"], x["fan_in_degree"]), reverse=True
    )

    return {
        "window_days":       args.window_days,
        "fan_out_threshold": args.fan_out_threshold,
        "fan_in_threshold":  args.fan_in_threshold,
        "flagged_accounts":  flagged_accounts,
        "total_flagged":     len(flagged_accounts),
    }


# =============================================================================
# detect_layering
# =============================================================================

class DetectLayeringArgs(BaseModel):
    account_ids: Optional[list[str]] = Field(
        default=None,
        description=(
            "Restrict path search to paths originating from these accounts. "
            "None = explore all accounts in the window as potential origins."
        ),
    )
    window_days: int = Field(default=30, ge=1, le=365)
    min_hops: int = Field(
        default=_DEFAULT_MIN_HOPS,
        ge=2,
        description="Minimum number of transfer edges required to constitute a layering chain.",
    )
    max_gap_hours: float = Field(
        default=_DEFAULT_MAX_GAP_HOURS,
        gt=0,
        description=(
            "Maximum elapsed hours allowed between consecutive hops. "
            "Enforces rapid sequential movement characteristic of layering."
        ),
    )
    date_to: Optional[str] = Field(
        default=None,
        description="ISO-8601 upper date bound. Defaults to latest timestamp in dataset.",
    )


@tool(
    name="detect_layering",
    description=(
        "Graph-based layering detector. Builds a directed account-transfer graph using "
        "networkx, then performs time-constrained DFS to find multi-hop paths where each "
        "consecutive transfer happens within max_gap_hours of the previous one. Returns "
        "each detected chain as an ordered list of account IDs and transaction IDs — "
        "real evidence, not just a score."
    ),
    schema=DetectLayeringArgs,
)
def detect_layering(args: DetectLayeringArgs) -> dict:
    conn = get_connection()

    row = conn.execute("SELECT MAX(timestamp) FROM transactions").fetchone()
    if row[0] is None:
        return {
            "window_days":    args.window_days,
            "min_hops":       args.min_hops,
            "max_gap_hours":  args.max_gap_hours,
            "detected_paths": [],
            "total_paths":    0,
        }

    as_of        = pd.Timestamp(args.date_to) if args.date_to else pd.Timestamp(row[0])
    window_start = as_of - pd.Timedelta(days=args.window_days)

    df: pd.DataFrame = conn.execute(
        f"""
        SELECT
            transaction_id,
            sender_account_id,
            receiver_account_id,
            amount,
            timestamp
        FROM transactions
        WHERE timestamp >= TIMESTAMP '{window_start.isoformat()}'
          AND timestamp <= TIMESTAMP '{as_of.isoformat()}'
        ORDER BY timestamp
        """
    ).df()

    if df.empty:
        return {
            "window_days":    args.window_days,
            "min_hops":       args.min_hops,
            "max_gap_hours":  args.max_gap_hours,
            "detected_paths": [],
            "total_paths":    0,
        }

    # ── Build networkx graph for structural analysis ───────────────────────────
    G: nx.MultiDiGraph = nx.MultiDiGraph()
    adjacency: dict[str, list[tuple]] = defaultdict(list)

    for _, row_data in df.iterrows():
        sender   = str(row_data["sender_account_id"])
        receiver = str(row_data["receiver_account_id"])
        amount   = float(row_data["amount"])
        ts       = row_data["timestamp"]
        txn_id   = str(row_data["transaction_id"])

        G.add_edge(sender, receiver, key=txn_id, amount=amount, timestamp=ts)
        adjacency[sender].append((receiver, amount, ts, txn_id))

    # Edges within each sender are already ordered by timestamp (df ORDER BY timestamp)
    # Secondary sort within each sender for safety
    for sender in adjacency:
        adjacency[sender].sort(key=lambda e: e[2])

    max_gap_seconds = args.max_gap_hours * 3600.0

    # ── Time-constrained DFS ──────────────────────────────────────────────────
    found_paths: list[dict] = []

    def dfs(
        current: str,
        path_nodes: list[str],
        path_txns: list[str],
        path_times: list,
        path_amounts: list[float],
        visited: set[str],
    ) -> None:
        # Record any path that already meets the min-hop requirement
        if len(path_nodes) - 1 >= args.min_hops:
            found_paths.append({
                "path":            list(path_nodes),
                "transaction_ids": list(path_txns),
                "hop_count":       len(path_nodes) - 1,
                "total_amount":    round(sum(path_amounts), 2),
                "time_span_hours": round(
                    (path_times[-1] - path_times[0]).total_seconds() / 3600, 2
                ),
                "origin_account":  path_nodes[0],
            })

        last_ts = path_times[-1]
        for (receiver, amount, ts, txn_id) in adjacency.get(current, []):
            if receiver in visited:
                continue
            gap_sec = (ts - last_ts).total_seconds()
            if 0 <= gap_sec <= max_gap_seconds:
                visited.add(receiver)
                path_nodes.append(receiver)
                path_txns.append(txn_id)
                path_times.append(ts)
                path_amounts.append(amount)
                dfs(receiver, path_nodes, path_txns, path_times, path_amounts, visited)
                path_nodes.pop()
                path_txns.pop()
                path_times.pop()
                path_amounts.pop()
                visited.discard(receiver)

    start_nodes = list(set(args.account_ids or adjacency.keys()))

    for start_node in sorted(start_nodes):
        for (receiver, amount, ts, txn_id) in adjacency.get(start_node, []):
            if receiver == start_node:
                continue
            visited: set[str] = {start_node, receiver}
            dfs(
                receiver,
                [start_node, receiver],
                [txn_id],
                [ts],
                [amount],
                visited,
            )

    # ── Deduplicate by exact path sequence ───────────────────────────────────
    seen: set[tuple] = set()
    unique_paths: list[dict] = []
    for p in found_paths:
        key = tuple(p["path"])
        if key not in seen:
            seen.add(key)
            unique_paths.append(p)

    unique_paths.sort(key=lambda x: x["hop_count"], reverse=True)

    logger.info(
        "detect_layering: %d path(s) found (min_hops=%d, max_gap_hours=%.1f, window=%d days)",
        len(unique_paths), args.min_hops, args.max_gap_hours, args.window_days,
    )

    return {
        "window_days":    args.window_days,
        "min_hops":       args.min_hops,
        "max_gap_hours":  args.max_gap_hours,
        "detected_paths": unique_paths,
        "total_paths":    len(unique_paths),
    }
