"""
Advanced graph-based AML detection tools using networkx.

Four tools:
  detect_round_trips        — round-trip flows: A → ... → A via ≥2 hops
  detect_common_controllers — co-moving account pairs with shared counterparty network
  compute_pagerank          — PageRank centrality on the transaction graph
  detect_cycles             — closed directed cycles (loops) of configurable length
"""

from __future__ import annotations

import logging
from collections import defaultdict
from itertools import combinations
from typing import Optional

import networkx as nx
import numpy as np
import pandas as pd
from pydantic import BaseModel, Field

from agent.registry import tool
from data.db import get_connection

logger = logging.getLogger(__name__)


# =============================================================================
# Shared helper: build transaction graph for a window
# =============================================================================

def _build_graph(
    conn,
    window_days: int,
    date_to: Optional[str] = None,
) -> tuple[nx.MultiDiGraph, pd.Timestamp]:
    """Build networkx MultiDiGraph from transactions in the rolling window."""
    row = conn.execute("SELECT MAX(timestamp) FROM transactions").fetchone()
    if row[0] is None:
        return nx.MultiDiGraph(), None

    as_of = pd.Timestamp(date_to) if date_to else pd.Timestamp(row[0])
    window_start = as_of - pd.Timedelta(days=window_days)

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
        return nx.MultiDiGraph(), as_of

    G: nx.MultiDiGraph = nx.MultiDiGraph()
    for _, row_data in df.iterrows():
        G.add_edge(
            str(row_data["sender_account_id"]),
            str(row_data["receiver_account_id"]),
            key=str(row_data["transaction_id"]),
            amount=float(row_data["amount"]),
            timestamp=row_data["timestamp"],
        )

    return G, as_of


# =============================================================================
# 1. Round-trip detection
# =============================================================================

class DetectRoundTripsArgs(BaseModel):
    account_ids: Optional[list[str]] = Field(
        default=None,
        description="Restrict to paths starting/ending at these accounts. None = all accounts.",
    )
    window_days: int = Field(default=30, ge=1, le=365)
    min_hops: int = Field(default=2, ge=2, description="Minimum hops for a round trip (A→...→A).")
    max_hops: int = Field(default=6, ge=2, le=10, description="Maximum hops to search.")
    date_to: Optional[str] = Field(default=None)


@tool(
    name="detect_round_trips",
    description=(
        "Detects round-trip money flows where funds leave an account and return to it "
        "via ≥2 intermediate hops within the time window. Uses networkx simple_cycles "
        "with length filtering. Returns each cycle as an ordered path with amounts."
    ),
    schema=DetectRoundTripsArgs,
)
def detect_round_trips(args: DetectRoundTripsArgs) -> dict:
    conn = get_connection()
    G, as_of = _build_graph(conn, args.window_days, args.date_to)

    if G.number_of_nodes() == 0:
        return {
            "window_days":   args.window_days,
            "min_hops":      args.min_hops,
            "max_hops":      args.max_hops,
            "round_trips":   [],
            "total_cycles":  0,
        }

    nodes_to_check = set(args.account_ids) if args.account_ids else set(G.nodes())
    nodes_to_check = nodes_to_check & set(G.nodes())

    round_trips: list[dict] = []

    # Use simple_cycles on the underlying simple graph for cycle detection
    # Then filter by hop count and originating account
    simple_G = nx.DiGraph(G)
    try:
        cycles = nx.simple_cycles(simple_G, length_bound=args.max_hops + 1)
    except TypeError:
        # networkx < 2.6 doesn't have length_bound
        cycles = nx.simple_cycles(simple_G)

    for cycle in cycles:
        cycle_len = len(cycle)
        if cycle_len < args.min_hops or cycle_len > args.max_hops:
            continue
        origin = cycle[0]
        if origin not in nodes_to_check:
            continue

        # Reconstruct full path with edge data from MultiDiGraph
        path_nodes = list(cycle) + [cycle[0]]  # close the loop
        transaction_ids = []
        amounts = []
        timestamps = []

        for i in range(len(path_nodes) - 1):
            u, v = path_nodes[i], path_nodes[i + 1]
            edge_data = G.get_edge_data(u, v)
            if not edge_data:
                break
            # Pick the first available edge (most recent by insertion order)
            txn_key, edge_attrs = next(iter(edge_data.items()))
            transaction_ids.append(txn_key)
            amounts.append(edge_attrs.get("amount", 0.0))
            timestamps.append(edge_attrs.get("timestamp", None))

        if len(transaction_ids) != len(path_nodes) - 1:
            continue

        round_trips.append({
            "origin_account":    origin,
            "cycle":             path_nodes,
            "transaction_ids":   transaction_ids,
            "amounts":           [round(a, 2) for a in amounts],
            "total_amount":      round(sum(amounts), 2),
            "hop_count":         cycle_len,
            "time_span_hours":   round(
                (pd.Timestamp(timestamps[-1]) - pd.Timestamp(timestamps[0])).total_seconds() / 3600, 2
            ) if timestamps else 0.0,
        })

    round_trips.sort(key=lambda x: x["total_amount"], reverse=True)

    return {
        "window_days":   args.window_days,
        "min_hops":      args.min_hops,
        "max_hops":      args.max_hops,
        "round_trips":   round_trips,
        "total_cycles":  len(round_trips),
    }


# =============================================================================
# 2. Common controller detection (co-moving accounts)
# =============================================================================

class DetectCommonControllersArgs(BaseModel):
    account_ids: Optional[list[str]] = Field(
        default=None,
        description="Restrict analysis to these accounts. None = all accounts in window."
    )
    window_days: int = Field(default=30, ge=1, le=365)
    min_shared_counterparties: int = Field(
        default=2, ge=1,
        description="Minimum number of shared counterparties for co-moving pair."
    )
    min_correlated_txns: int = Field(
        default=3, ge=2,
        description="Minimum correlated transactions (same counterparty, similar time)."
    )
    time_window_hours: float = Field(
        default=4.0, gt=0,
        description="Time window for considering transactions as 'simultaneous'."
    )
    date_to: Optional[str] = Field(default=None)


def _jaccard_similarity(set_a: set, set_b: set) -> float:
    if not set_a or not set_b:
        return 0.0
    return len(set_a & set_b) / len(set_a | set_b)


@tool(
    name="detect_common_controllers",
    description=(
        "Detects pairs of accounts that appear to be under common control: they "
        "transact with the same counterparties, at similar times, and in correlated "
        "patterns. Uses Jaccard similarity of counterparty sets + temporal correlation "
        "of transaction timestamps. Returns ranked pairs with evidence."
    ),
    schema=DetectCommonControllersArgs,
)
def detect_common_controllers(args: DetectCommonControllersArgs) -> dict:
    conn = get_connection()
    G, as_of = _build_graph(conn, args.window_days, args.date_to)

    if G.number_of_nodes() == 0:
        return {
            "window_days":               args.window_days,
            "min_shared_counterparties": args.min_shared_counterparties,
            "controller_pairs":          [],
            "total_pairs":               0,
        }

    nodes = set(args.account_ids) if args.account_ids else set(G.nodes())
    nodes = nodes & set(G.nodes())
    if len(nodes) < 2:
        return {
            "window_days":               args.window_days,
            "min_shared_counterparties": args.min_shared_counterparties,
            "controller_pairs":          [],
            "total_pairs":               0,
        }

    # Build counterparty sets and temporal profiles
    successor_map = {n: set(G.successors(n)) for n in nodes}
    predecessor_map = {n: set(G.predecessors(n)) for n in nodes}

    # Temporal profiles: for each (account, counterparty), collect timestamps
    temporal_profiles: dict[str, dict[str, list]] = defaultdict(lambda: defaultdict(list))
    df = conn.execute(
        f"""
        SELECT sender_account_id, receiver_account_id, timestamp
        FROM transactions
        WHERE timestamp >= TIMESTAMP '{(as_of - pd.Timedelta(days=args.window_days)).isoformat()}'
          AND timestamp <= TIMESTAMP '{as_of.isoformat()}'
        """
    ).df()
    for _, row in df.iterrows():
        s, r = str(row["sender_account_id"]), str(row["receiver_account_id"])
        ts = row["timestamp"]
        if s in nodes:
            temporal_profiles[s][r].append(ts)
        if r in nodes:
            temporal_profiles[r][s].append(ts)

    pairs: list[dict] = []
    for a, b in combinations(sorted(nodes), 2):
        # Counterparty overlap
        shared_succ = successor_map[a] & successor_map[b]
        shared_pred = predecessor_map[a] & predecessor_map[b]
        shared_all = shared_succ | shared_pred

        if len(shared_all) < args.min_shared_counterparties:
            continue

        # Temporal correlation on shared counterparties
        correlated_txns = 0
        for cp in shared_all:
            ts_a = temporal_profiles[a].get(cp, [])
            ts_b = temporal_profiles[b].get(cp, [])
            if not ts_a or not ts_b:
                continue
            # Check if any transactions happened within time_window_hours
            for t1 in ts_a:
                for t2 in ts_b:
                    if abs((pd.Timestamp(t1) - pd.Timestamp(t2)).total_seconds()) <= args.time_window_hours * 3600:
                        correlated_txns += 1
                        break  # count one per counterparty pair

        if correlated_txns < args.min_correlated_txns:
            continue

        # Jaccard on full counterparty sets
        succ_jac = _jaccard_similarity(successor_map[a], successor_map[b])
        pred_jac = _jaccard_similarity(predecessor_map[a], predecessor_map[b])
        overall_jac = _jaccard_similarity(successor_map[a] | predecessor_map[a], successor_map[b] | predecessor_map[b])

        # Get transaction details for evidence
        cp_details = []
        for cp in sorted(shared_all):
            sent_a = sum(data["amount"] for _, _, data in G.out_edges(a, data=True) if _ == cp)
            sent_b = sum(data["amount"] for _, _, data in G.out_edges(b, data=True) if _ == cp)
            recv_a = sum(data["amount"] for _, _, data in G.in_edges(a, data=True) if _ == cp)
            recv_b = sum(data["amount"] for _, _, data in G.in_edges(b, data=True) if _ == cp)
            if sent_a + sent_b + recv_a + recv_b > 0:
                cp_details.append({
                    "counterparty": cp,
                    "a_sent": round(sent_a, 2),
                    "a_received": round(recv_a, 2),
                    "b_sent": round(sent_b, 2),
                    "b_received": round(recv_b, 2),
                })

        pairs.append({
            "account_a":              a,
            "account_b":              b,
            "shared_counterparties":  len(shared_all),
            "correlated_transactions": correlated_txns,
            "jaccard_successors":     round(succ_jac, 4),
            "jaccard_predecessors":   round(pred_jac, 4),
            "jaccard_overall":        round(overall_jac, 4),
            "counterparty_evidence":  cp_details,
        })

    # Sort by combined score
    pairs.sort(key=lambda x: (x["shared_counterparties"], x["correlated_transactions"], x["jaccard_overall"]), reverse=True)

    return {
        "window_days":               args.window_days,
        "min_shared_counterparties": args.min_shared_counterparties,
        "controller_pairs":          pairs,
        "total_pairs":               len(pairs),
    }


# =============================================================================
# 3. PageRank centrality (flow centrality)
# =============================================================================

class ComputePageRankArgs(BaseModel):
    window_days: int = Field(default=30, ge=1, le=365)
    alpha: float = Field(default=0.85, ge=0.5, le=0.99, description="PageRank damping factor.")
    weight: str = Field(default="amount", description="Edge weight: 'amount' or 'count'.")
    top_n: int = Field(default=20, ge=1, le=200, description="Return top-N accounts by PageRank.")
    date_to: Optional[str] = Field(default=None)


@tool(
    name="compute_pagerank",
    description=(
        "Computes PageRank on the transaction graph to identify accounts with "
        "disproportionate flow centrality — accounts that act as hubs or bridges "
        "in the money movement network. High PageRank = funds flow through this account. "
        "Edge weights can be transaction amount (default) or count."
    ),
    schema=ComputePageRankArgs,
)
def compute_pagerank(args: ComputePageRankArgs) -> dict:
    conn = get_connection()
    G, as_of = _build_graph(conn, args.window_days, args.date_to)

    if G.number_of_nodes() == 0:
        return {
            "window_days": args.window_days,
            "alpha":       args.alpha,
            "weight":      args.weight,
            "pagerank":    [],
            "total_nodes": 0,
        }

    # Convert to simple weighted graph for PageRank
    if args.weight == "amount":
        # Sum amounts per edge pair
        edge_weights: dict[tuple[str, str], float] = defaultdict(float)
        for u, v, data in G.edges(data=True):
            edge_weights[(u, v)] += data.get("amount", 0.0)
        WG = nx.DiGraph()
        for (u, v), w in edge_weights.items():
            WG.add_edge(u, v, weight=w)
    else:
        # Count edges
        WG = nx.DiGraph()
        for u, v, data in G.edges(data=True):
            if WG.has_edge(u, v):
                WG[u][v]["weight"] = WG[u][v].get("weight", 0) + 1
            else:
                WG.add_edge(u, v, weight=1.0)

    # Compute PageRank
    try:
        pr = nx.pagerank(WG, alpha=args.alpha, weight="weight", max_iter=100, tol=1e-6)
    except nx.PowerIterationFailedConvergence:
        # Fallback: uniform
        pr = {n: 1.0 / WG.number_of_nodes() for n in WG.nodes()}

    # Normalize to percentile
    pr_values = list(pr.values())
    p90 = np.percentile(pr_values, 90) if pr_values else 0
    p99 = np.percentile(pr_values, 99) if pr_values else 0

    # Sort and take top N
    sorted_pr = sorted(pr.items(), key=lambda x: -x[1])[:args.top_n]

    pagerank_results = []
    for account_id, score in sorted_pr:
        tier = "critical" if score >= p99 else "high" if score >= p90 else "elevated" if score > np.median(pr_values) else "normal"
        in_deg = WG.in_degree(account_id)
        out_deg = WG.out_degree(account_id)
        pagerank_results.append({
            "account_id":      account_id,
            "pagerank_score":  round(score, 6),
            "tier":            tier,
            "in_degree":       in_deg,
            "out_degree":      out_deg,
            "total_degree":    in_deg + out_deg,
        })

    return {
        "window_days": args.window_days,
        "alpha":       args.alpha,
        "weight":      args.weight,
        "pagerank":    pagerank_results,
        "total_nodes": WG.number_of_nodes(),
        "p90_score":   round(float(p90), 6),
        "p99_score":   round(float(p99), 6),
    }


# =============================================================================
# 4. Cycle detection (all closed loops)
# =============================================================================

class DetectCyclesArgs(BaseModel):
    account_ids: Optional[list[str]] = Field(
        default=None,
        description="Restrict cycle search to these accounts. None = all accounts."
    )
    window_days: int = Field(default=30, ge=1, le=365)
    min_length: int = Field(default=2, ge=2, description="Minimum cycle length (number of nodes).")
    max_length: int = Field(default=8, ge=2, le=15, description="Maximum cycle length.")
    date_to: Optional[str] = Field(default=None)


@tool(
    name="detect_cycles",
    description=(
        "Finds ALL closed directed cycles (loops) in the transaction graph within "
        "the specified length range. Unlike detect_round_trips which requires "
        "the cycle to start/end at the same account, this finds cycles of any origin. "
        "Returns each unique cycle with transaction evidence and total flow."
    ),
    schema=DetectCyclesArgs,
)
def detect_cycles(args: DetectCyclesArgs) -> dict:
    conn = get_connection()
    G, as_of = _build_graph(conn, args.window_days, args.date_to)

    if G.number_of_nodes() == 0:
        return {
            "window_days": args.window_days,
            "min_length":  args.min_length,
            "max_length":  args.max_length,
            "cycles":      [],
            "total_cycles": 0,
        }

    simple_G = nx.DiGraph(G)
    try:
        cycles_gen = nx.simple_cycles(simple_G, length_bound=args.max_length + 1)
    except TypeError:
        cycles_gen = nx.simple_cycles(simple_G)

    seen: set[tuple] = set()
    cycles: list[dict] = []

    for cycle in cycles_gen:
        cycle_len = len(cycle)
        if cycle_len < args.min_length or cycle_len > args.max_length:
            continue

        # Canonicalize: rotate to smallest node ID to deduplicate same cycle found at different starts
        min_idx = min(range(cycle_len), key=lambda i: cycle[i])
        canonical = tuple(cycle[min_idx:] + cycle[:min_idx])
        if canonical in seen:
            continue
        seen.add(canonical)

        # Check account filter
        if args.account_ids:
            if not any(n in args.account_ids for n in cycle):
                continue

        # Reconstruct with edge data
        path_nodes = list(cycle) + [cycle[0]]
        transaction_ids = []
        amounts = []
        timestamps = []

        for i in range(len(path_nodes) - 1):
            u, v = path_nodes[i], path_nodes[i + 1]
            edge_data = G.get_edge_data(u, v)
            if not edge_data:
                break
            txn_key, edge_attrs = next(iter(edge_data.items()))
            transaction_ids.append(txn_key)
            amounts.append(edge_attrs.get("amount", 0.0))
            timestamps.append(edge_attrs.get("timestamp", None))

        if len(transaction_ids) != len(path_nodes) - 1:
            continue

        cycles.append({
            "cycle":             path_nodes,
            "length":            cycle_len,
            "transaction_ids":   transaction_ids,
            "amounts":           [round(a, 2) for a in amounts],
            "total_amount":      round(sum(amounts), 2),
            "time_span_hours":   round(
                (pd.Timestamp(timestamps[-1]) - pd.Timestamp(timestamps[0])).total_seconds() / 3600, 2
            ) if timestamps else 0.0,
        })

    cycles.sort(key=lambda x: x["total_amount"], reverse=True)

    return {
        "window_days":  args.window_days,
        "min_length":   args.min_length,
        "max_length":   args.max_length,
        "cycles":       cycles,
        "total_cycles": len(cycles),
    }