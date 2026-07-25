"""
Risk classifier tool — registered in TOOL_REGISTRY.

Accepts outputs from any combination of:
  detect_structuring, detect_anomalies, detect_smurfing, detect_layering

Maps signals to low / medium / high risk using named threshold constants and
returns the contributing_signals list that drove the classification.

All thresholds live at the top of this file as named constants.
"""

from __future__ import annotations

import logging
from typing import Optional

from pydantic import BaseModel, Field

from agent.registry import tool

logger = logging.getLogger(__name__)

# =============================================================================
# Named threshold constants — tune here, not buried in logic below
# =============================================================================

# ── Structuring signal ────────────────────────────────────────────────────────
STRUCTURING_COUNT_MEDIUM: int = 2   # ≥2 near-threshold txns → medium signal
STRUCTURING_COUNT_HIGH:   int = 4   # ≥4 near-threshold txns → high signal

STRUCTURING_POINTS_NONE:   float = 0.0
STRUCTURING_POINTS_MEDIUM: float = 50.0
STRUCTURING_POINTS_HIGH:   float = 80.0

# ── Anomaly signal ────────────────────────────────────────────────────────────
ANOMALY_SCORE_MEDIUM: float = 0.55
ANOMALY_SCORE_HIGH:   float = 0.75

ANOMALY_POINTS_NONE:   float = 0.0
ANOMALY_POINTS_MEDIUM: float = 40.0
ANOMALY_POINTS_HIGH:   float = 70.0

# ── Smurfing signal ───────────────────────────────────────────────────────────
# Number of distinct counterparties (fan-out or fan-in) that trips each tier.
SMURFING_DEGREE_MEDIUM: int = 3   # ≥3 distinct counterparties → medium
SMURFING_DEGREE_HIGH:   int = 6   # ≥6 distinct counterparties → high

SMURFING_POINTS_NONE:   float = 0.0
SMURFING_POINTS_MEDIUM: float = 45.0
SMURFING_POINTS_HIGH:   float = 75.0

# ── Layering signal ───────────────────────────────────────────────────────────
# Number of hops in the detected chain that trips each tier.
LAYERING_HOPS_MEDIUM: int = 3   # ≥3 hops → medium
LAYERING_HOPS_HIGH:   int = 5   # ≥5 hops → high

LAYERING_POINTS_NONE:   float = 0.0
LAYERING_POINTS_MEDIUM: float = 50.0
LAYERING_POINTS_HIGH:   float = 80.0

# ── Composite risk buckets ─────────────────────────────────────────────────────
# Composite score = max(individual signal points) + DUAL_SIGNAL_BONUS when
# two or more distinct signal types are present.
DUAL_SIGNAL_BONUS: float = 10.0

RISK_SCORE_MEDIUM_THRESHOLD: float = 40.0   # ≥40 → medium
RISK_SCORE_HIGH_THRESHOLD:   float = 65.0   # ≥65 → high

# ── Escalation mapping ─────────────────────────────────────────────────────────
_ESCALATION: dict[str, str] = {
    "low":    "monitor",
    "medium": "review",
    "high":   "report",
}


# =============================================================================
# Tool
# =============================================================================


class ClassifyRiskArgs(BaseModel):
    structuring_output: Optional[dict] = Field(
        default=None,
        description=(
            "Full output dict from detect_structuring. "
            "Injected automatically by the orchestrator when that tool ran first."
        ),
    )
    anomaly_output: Optional[dict] = Field(
        default=None,
        description=(
            "Full output dict from detect_anomalies. "
            "Injected automatically by the orchestrator when that tool ran first."
        ),
    )
    smurfing_output: Optional[dict] = Field(
        default=None,
        description=(
            "Full output dict from detect_smurfing. "
            "Injected automatically by the orchestrator when that tool ran first."
        ),
    )
    layering_output: Optional[dict] = Field(
        default=None,
        description=(
            "Full output dict from detect_layering. "
            "Injected automatically by the orchestrator when that tool ran first."
        ),
    )
    account_id: Optional[str] = Field(
        default=None,
        description="If set, return classification only for this account.",
    )


@tool(
    name="classify_risk",
    description=(
        "Maps detection outputs (structuring, anomaly, smurfing, layering) to "
        "low / medium / high risk using documented threshold constants. Returns one "
        "classification record per flagged account, including the contributing_signals "
        "list that drove the verdict."
    ),
    schema=ClassifyRiskArgs,
)
def classify_risk(args: ClassifyRiskArgs) -> dict:
    # ── Collect accounts from all upstream outputs ────────────────────────────
    # account_id → {"structuring": {...}, "anomaly": {...}, "smurfing": {...}, "layering": {...}}
    accounts: dict[str, dict] = {}

    if args.structuring_output:
        for fa in args.structuring_output.get("flagged_accounts", []):
            aid = fa["account_id"]
            accounts.setdefault(aid, {})["structuring"] = fa

    if args.anomaly_output:
        for fa in args.anomaly_output.get("flagged_accounts", []):
            aid = fa["account_id"]
            accounts.setdefault(aid, {})["anomaly"] = fa

    if args.smurfing_output:
        for fa in args.smurfing_output.get("flagged_accounts", []):
            aid = fa["account_id"]
            accounts.setdefault(aid, {})["smurfing"] = fa

    if args.layering_output:
        # Layering paths are keyed by origin_account
        for path in args.layering_output.get("detected_paths", []):
            aid = path.get("origin_account") or (path["path"][0] if path.get("path") else None)
            if aid:
                # Keep the highest-hop path per origin account
                existing = accounts.setdefault(aid, {}).get("layering")
                if existing is None or path["hop_count"] > existing["hop_count"]:
                    accounts[aid]["layering"] = path

    # ── Optional single-account filter ───────────────────────────────────────
    if args.account_id:
        accounts = {k: v for k, v in accounts.items() if k == args.account_id}
        if not accounts:
            accounts[args.account_id] = {}

    # ── Classify each account ─────────────────────────────────────────────────
    classifications: list[dict] = []

    for account_id, signals_data in accounts.items():
        contributing_signals: list[dict] = []
        structuring_points = 0.0
        anomaly_points     = 0.0
        smurfing_points    = 0.0
        layering_points    = 0.0
        has_structuring    = False
        has_anomaly        = False
        has_smurfing       = False
        has_layering       = False

        # ── Structuring signal ────────────────────────────────────────────────
        struct = signals_data.get("structuring")
        if struct:
            has_structuring = True
            count           = struct["near_threshold_txn_count"]
            total_structured = struct["total_amount_structured"]
            window_days     = args.structuring_output.get("window_days", 30)  # type: ignore[union-attr]
            threshold       = args.structuring_output.get("threshold", 10_000.0)  # type: ignore[union-attr]

            if count >= STRUCTURING_COUNT_HIGH:
                structuring_points = STRUCTURING_POINTS_HIGH
            elif count >= STRUCTURING_COUNT_MEDIUM:
                structuring_points = STRUCTURING_POINTS_MEDIUM
            else:
                structuring_points = STRUCTURING_POINTS_NONE

            contributing_signals.append({
                "signal":  "structuring_count",
                "value":   count,
                "label":   (
                    f"{count} near-threshold transactions within {window_days} days "
                    f"(threshold ${threshold:,.0f})"
                ),
                "weight":  round(structuring_points / 100, 2),
            })
            if total_structured > 0:
                contributing_signals.append({
                    "signal":  "total_structured_amount",
                    "value":   total_structured,
                    "label":   f"total structured amount ${total_structured:,.2f}",
                    "weight":  0.3,
                })

        # ── Anomaly signal ────────────────────────────────────────────────────
        anom = signals_data.get("anomaly")
        if anom:
            has_anomaly = True
            score       = float(anom["anomaly_score"])

            if score >= ANOMALY_SCORE_HIGH:
                anomaly_points = ANOMALY_POINTS_HIGH
            elif score >= ANOMALY_SCORE_MEDIUM:
                anomaly_points = ANOMALY_POINTS_MEDIUM
            else:
                anomaly_points = ANOMALY_POINTS_NONE

            contributing_signals.append({
                "signal":  "anomaly_score",
                "value":   round(score, 4),
                "label":   (
                    f"anomaly score {score:.4f} "
                    f"(medium threshold: {ANOMALY_SCORE_MEDIUM}, high: {ANOMALY_SCORE_HIGH})"
                ),
                "weight":  round(anomaly_points / 100, 2),
            })
            for tf in anom.get("top_features", [])[:2]:
                contributing_signals.append({
                    "signal":  f"feature_{tf['feature']}",
                    "value":   tf["value"],
                    "label":   (
                        f"{tf['feature']} = {tf['value']:.4f} "
                        f"(z-score {tf['zscore']:.2f})"
                    ),
                    "weight":  0.1,
                })

        # ── Smurfing signal ───────────────────────────────────────────────────
        smurf = signals_data.get("smurfing")
        if smurf:
            has_smurfing = True
            fo = smurf["fan_out_degree"]
            fi = smurf["fan_in_degree"]
            dominant_degree = max(fo, fi)
            direction       = "out" if fo >= fi else "in"
            window_days_s   = args.smurfing_output.get("window_days", 30)  # type: ignore[union-attr]

            if dominant_degree >= SMURFING_DEGREE_HIGH:
                smurfing_points = SMURFING_POINTS_HIGH
            elif dominant_degree >= SMURFING_DEGREE_MEDIUM:
                smurfing_points = SMURFING_POINTS_MEDIUM
            else:
                smurfing_points = SMURFING_POINTS_NONE

            signal_name = f"smurfing_fan_{direction}"
            contributing_signals.append({
                "signal":  signal_name,
                "value":   dominant_degree,
                "label":   (
                    f"fan-{direction} to {dominant_degree} distinct "
                    f"counterparties within {window_days_s} days"
                ),
                "weight":  round(smurfing_points / 100, 2),
            })
            total_smurfed = (
                smurf.get("total_sent", 0.0) if direction == "out"
                else smurf.get("total_received", 0.0)
            ) or 0.0
            if total_smurfed > 0:
                contributing_signals.append({
                    "signal":  "smurfing_total_amount",
                    "value":   round(total_smurfed, 2),
                    "label":   (
                        f"total amount {'sent' if direction == 'out' else 'received'} "
                        f"${total_smurfed:,.2f}"
                    ),
                    "weight":  0.2,
                })

        # ── Layering signal ───────────────────────────────────────────────────
        layer = signals_data.get("layering")
        if layer:
            has_layering = True
            hop_count    = layer["hop_count"]
            total_amount = layer.get("total_amount", 0.0) or 0.0
            path         = layer.get("path", [])

            if hop_count >= LAYERING_HOPS_HIGH:
                layering_points = LAYERING_POINTS_HIGH
            elif hop_count >= LAYERING_HOPS_MEDIUM:
                layering_points = LAYERING_POINTS_MEDIUM
            else:
                layering_points = LAYERING_POINTS_NONE

            path_str = " → ".join(path[:6]) + ("..." if len(path) > 6 else "")
            contributing_signals.append({
                "signal":  "layering_path_length",
                "value":   hop_count,
                "label":   f"{hop_count}-hop chain detected ({path_str})",
                "weight":  round(layering_points / 100, 2),
            })
            if total_amount > 0:
                contributing_signals.append({
                    "signal":  "layering_total_amount",
                    "value":   total_amount,
                    "label":   f"total amount layered ${total_amount:,.2f}",
                    "weight":  0.3,
                })

        # ── Composite score ───────────────────────────────────────────────────
        composite = max(structuring_points, anomaly_points, smurfing_points, layering_points)
        signal_type_count = sum([has_structuring, has_anomaly, has_smurfing, has_layering])
        if signal_type_count >= 2:
            composite = min(100.0, composite + DUAL_SIGNAL_BONUS)

        # ── Risk tier ────────────────────────────────────────────────────────
        if composite >= RISK_SCORE_HIGH_THRESHOLD:
            risk_level = "high"
        elif composite >= RISK_SCORE_MEDIUM_THRESHOLD:
            risk_level = "medium"
        else:
            risk_level = "low"

        classifications.append({
            "account_id":           account_id,
            "risk_level":           risk_level,
            "risk_score":           round(composite, 2),
            "escalation":           _ESCALATION[risk_level],
            "contributing_signals": contributing_signals,
        })

    # Sort: high → medium → low
    _order = {"high": 0, "medium": 1, "low": 2}
    classifications.sort(key=lambda c: _order.get(c["risk_level"], 9))

    return {"classifications": classifications}
