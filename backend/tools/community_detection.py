"""
Community detection tool — registered in TOOL_REGISTRY.

Uses the Louvain algorithm (python-louvain / networkx-community) to identify
clusters of accounts that form tightly-knit communities in the transaction graph.
Communities with high internal transaction density and elevated average ML risk
are flagged as potential "money mule rings".

Why this matters:
  Real money laundering is a GROUP effort. Individual account-level detection
  misses coordinated rings where each member's behaviour looks innocuous in
  isolation, but the whole group moves money in a circular, obfuscated pattern.

Output per suspicious ring:
  - community_id: sequential integer label
  - member_accounts: list of account IDs in the cluster
  - member_count: number of accounts
  - internal_txn_count: transactions that stay within the community
  - internal_volume_usd: total USD flowing inside the ring
  - internal_ratio: internal txns / total txns for these accounts (≥0.5 = tight ring)
  - avg_ml_risk: mean ML probability for members (if model is loaded)
  - risk_level: low / medium / high classification
  - suspicion_score: composite 0–100
  - escalation: monitor / review / report
"""

from __future__ import annotations

import logging
from typing import Optional

import networkx as nx
import numpy as np
import pandas as pd
from pydantic import BaseModel, Field

from agent.registry import tool
from data.db import get_connection
from tools.model_store import load_xgb_payload

logger = logging.getLogger(__name__)

# ─── Thresholds ───────────────────────────────────────────────────────────────
_MIN_COMMUNITY_SIZE: int   = 3       # ignore singleton/pair communities
_MIN_INTERNAL_RATIO: float = 0.35    # ≥35% of txns stay inside the community
_MIN_INTERNAL_TXNS:  int   = 2       # at least 2 internal transactions

_SUSPICION_HIGH:   float = 65.0
_SUSPICION_MEDIUM: float = 35.0

_ESCALATION = {"high": "report", "medium": "review", "low": "monitor"}

# ─── Optional ML model for per-account risk ────────────────────────────────────
_model = None
_feat_cols = None
_MODEL_READY = False
try:
    _payload = load_xgb_payload()
    _model = _payload["model"]
    _feat_cols = _payload["feature_cols"]
    _MODEL_READY = True
except Exception:
    pass


# =============================================================================
# Tool definition
# =============================================================================

class DetectMuleRingsArgs(BaseModel):
    window_days: int = Field(
        default=30,
        description="Rolling time window in days to build the transaction graph.",
    )
    min_community_size: int = Field(
        default=3,
        description="Minimum number of accounts for a community to be considered.",
    )
    top_n: int = Field(
        default=10,
        description="Return at most this many suspicious communities.",
    )
    date_to: Optional[str] = Field(
        default=None,
        description="End date for the window (ISO 8601). Defaults to latest timestamp.",
    )


@tool(
    name="detect_mule_rings",
    description=(
        "Applies Louvain community detection to the transaction graph to identify "
        "tightly-knit clusters of accounts ('mule rings') that move money primarily "
        "within the cluster. Returns the top-N most suspicious communities ranked by "
        "a composite score of internal density, transaction volume, and ML risk. "
        "Designed to catch coordinated multi-account laundering schemes that evade "
        "single-account detectors."
    ),
    schema=DetectMuleRingsArgs,
)
def detect_mule_rings(args: DetectMuleRingsArgs) -> dict:
    conn = get_connection()

    # ── 1. Determine time window ──────────────────────────────────────────────
    row = conn.execute("SELECT MAX(timestamp) FROM transactions").fetchone()
    if row[0] is None:
        return {"rings": [], "communities_scanned": 0, "note": "No transaction data found."}

    as_of = pd.Timestamp(args.date_to) if args.date_to else pd.Timestamp(row[0])
    window_start = as_of - pd.Timedelta(days=args.window_days)

    # ── 2. Load transactions ──────────────────────────────────────────────────
    df: pd.DataFrame = conn.execute(
        f"""
        SELECT
            transaction_id,
            sender_account_id   AS src,
            receiver_account_id AS dst,
            amount,
            timestamp
        FROM transactions
        WHERE timestamp >= TIMESTAMP '{window_start.isoformat()}'
          AND timestamp <= TIMESTAMP '{as_of.isoformat()}'
        """
    ).df()

    if df.empty:
        return {"rings": [], "communities_scanned": 0, "note": "No transactions in window."}

    # ── 3. Build undirected graph (Louvain requires undirected) ───────────────
    G_undirected = nx.Graph()
    for _, row_data in df.iterrows():
        src = str(row_data["src"])
        dst = str(row_data["dst"])
        if src == dst:
            continue
        if G_undirected.has_edge(src, dst):
            G_undirected[src][dst]["weight"] += float(row_data["amount"])
            G_undirected[src][dst]["txn_count"] += 1
        else:
            G_undirected.add_edge(
                src, dst,
                weight=float(row_data["amount"]),
                txn_count=1,
            )

    if G_undirected.number_of_nodes() < args.min_community_size:
        return {"rings": [], "communities_scanned": 0, "note": "Graph too small for community detection."}

    # ── 4. Run Louvain community detection ────────────────────────────────────
    try:
        import community as community_louvain  # python-louvain
        partition: dict[str, int] = community_louvain.best_partition(
            G_undirected, weight="weight", random_state=42
        )
    except Exception as exc:
        logger.warning("Louvain failed, falling back to connected components: %s", exc)
        # Graceful fallback: use connected components as communities
        partition = {}
        for cid, component in enumerate(nx.connected_components(G_undirected)):
            for node in component:
                partition[node] = cid

    # ── 5. Group accounts by community ────────────────────────────────────────
    from collections import defaultdict
    communities: dict[int, list[str]] = defaultdict(list)
    for account, cid in partition.items():
        communities[cid].append(account)

    # ── 6. Score each community ───────────────────────────────────────────────
    # Build a directed edge lookup for fast internal-txn counting
    edge_set = set(zip(df["src"].astype(str), df["dst"].astype(str)))
    account_txn_count = df.groupby("src")["transaction_id"].count().to_dict()
    account_vol = df.groupby("src")["amount"].sum().to_dict()

    suspicious_rings: list[dict] = []

    for cid, members in communities.items():
        if len(members) < max(args.min_community_size, _MIN_COMMUNITY_SIZE):
            continue

        member_set = set(members)

        # Count internal vs external txns
        internal_txns = df[
            df["src"].astype(str).isin(member_set) &
            df["dst"].astype(str).isin(member_set)
        ]
        external_txns_df = df[df["src"].astype(str).isin(member_set)]

        internal_count  = len(internal_txns)
        total_count     = len(external_txns_df)
        internal_volume = float(internal_txns["amount"].sum()) if not internal_txns.empty else 0.0
        total_volume    = float(external_txns_df["amount"].sum()) if not external_txns_df.empty else 0.0
        internal_ratio  = internal_count / total_count if total_count > 0 else 0.0

        if internal_count < _MIN_INTERNAL_TXNS:
            continue
        if internal_ratio < _MIN_INTERNAL_RATIO:
            continue

        # Subgraph density (internal edges / possible edges)
        subgraph = G_undirected.subgraph(member_set)
        density  = nx.density(subgraph) if len(member_set) > 1 else 0.0

        # Avg ML probability if model is ready
        avg_ml_risk = 0.0
        if _MODEL_READY:
            try:
                avg_ml_risk = _get_avg_ml_risk(members, df, member_set)
            except Exception:
                avg_ml_risk = 0.0

        # Composite suspicion score (0–100)
        # Components: density (0–30) + internal_ratio (0–30) + ml_risk (0–25) + size bonus (0–15)
        score_density  = min(density * 30, 30.0)
        score_ratio    = internal_ratio * 30.0
        score_ml       = avg_ml_risk * 25.0
        score_size     = min((len(members) - _MIN_COMMUNITY_SIZE) * 2.0, 15.0)
        suspicion_score = score_density + score_ratio + score_ml + score_size

        # Risk tier
        if suspicion_score >= _SUSPICION_HIGH:
            risk_level = "high"
        elif suspicion_score >= _SUSPICION_MEDIUM:
            risk_level = "medium"
        else:
            risk_level = "low"

        # Representative transactions inside the ring
        sample_txns = internal_txns.head(6)[
            ["transaction_id", "src", "dst", "amount", "timestamp"]
        ].rename(columns={"src": "sender", "dst": "receiver"}).to_dict(orient="records")
        for t in sample_txns:
            t["amount"]    = round(float(t["amount"]), 2)
            t["timestamp"] = str(t["timestamp"])

        suspicious_rings.append({
            "community_id":       cid,
            "member_accounts":    sorted(members),
            "member_count":       len(members),
            "internal_txn_count": internal_count,
            "total_txn_count":    total_count,
            "internal_volume_usd": round(internal_volume, 2),
            "total_volume_usd":    round(total_volume, 2),
            "internal_ratio":     round(internal_ratio, 4),
            "graph_density":      round(density, 4),
            "avg_ml_risk":        round(avg_ml_risk, 4),
            "suspicion_score":    round(suspicion_score, 2),
            "risk_level":         risk_level,
            "escalation":         _ESCALATION[risk_level],
            "sample_transactions": sample_txns,
        })

    # Sort by suspicion score descending
    suspicious_rings.sort(key=lambda r: r["suspicion_score"], reverse=True)
    top_rings = suspicious_rings[: args.top_n]

    return {
        "rings":               top_rings,
        "communities_scanned": len(communities),
        "suspicious_count":    len(suspicious_rings),
        "window_days":         args.window_days,
        "as_of":               str(as_of),
        "total_accounts":      G_undirected.number_of_nodes(),
        "total_edges":         G_undirected.number_of_edges(),
        "min_internal_ratio":  _MIN_INTERNAL_RATIO,
    }


# =============================================================================
# Private helpers
# =============================================================================

def _get_avg_ml_risk(
    members: list[str],
    df: pd.DataFrame,
    member_set: set,
) -> float:
    """Estimate avg ML risk for community members using simple heuristic features."""
    if _model is None or _feat_cols is None:
        return 0.0

    member_df = df[df["src"].astype(str).isin(member_set)]
    if member_df.empty:
        return 0.0

    try:
        features = (
            member_df.groupby("src")
            .agg(
                txn_count=("amount", "count"),
                total_amount=("amount", "sum"),
                avg_amount=("amount", "mean"),
                std_amount=("amount", "std"),
            )
            .fillna(0)
        )
        # Add zero-padding for any missing feature columns expected by model
        for col in _feat_cols:
            if col not in features.columns:
                features[col] = 0.0
        X = features[_feat_cols].values
        probs = _model.predict_proba(X)[:, 1]
        return float(np.mean(probs))
    except Exception:
        return 0.0
