"""
Risk classifier tool — registered in TOOL_REGISTRY.

Accepts outputs from detect_structuring and/or detect_anomalies, maps them to
low / medium / high risk using named threshold constants, and returns the
contributing signals that drove the classification.

All thresholds live at the top of this file as named constants so they can be
tuned without reading through the logic.
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
# Number of near-threshold transactions in the window needed to trip each tier.
STRUCTURING_COUNT_MEDIUM: int = 2   # ≥2 near-threshold txns → medium signal
STRUCTURING_COUNT_HIGH:   int = 4   # ≥4 near-threshold txns → high signal

# Points awarded per structuring tier (contributes to composite score 0–100)
STRUCTURING_POINTS_NONE:   float = 0.0
STRUCTURING_POINTS_MEDIUM: float = 50.0
STRUCTURING_POINTS_HIGH:   float = 80.0

# ── Anomaly signal ────────────────────────────────────────────────────────────
# Normalised IsolationForest score (0–1, higher = more anomalous).
ANOMALY_SCORE_MEDIUM: float = 0.55
ANOMALY_SCORE_HIGH:   float = 0.75

ANOMALY_POINTS_NONE:   float = 0.0
ANOMALY_POINTS_MEDIUM: float = 40.0
ANOMALY_POINTS_HIGH:   float = 70.0

# ── Composite risk buckets ─────────────────────────────────────────────────────
# Composite score is the MAX of (structuring points, anomaly points).
# A dual-signal bonus (+10) is added when both signals are present.
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
    account_id: Optional[str] = Field(
        default=None,
        description="If set, return classification only for this account.",
    )


@tool(
    name="classify_risk",
    description=(
        "Maps structuring and/or anomaly detection outputs to low / medium / high risk "
        "using documented threshold constants. Returns one classification record per "
        "flagged account, including the contributing_signals list that drove the verdict."
    ),
    schema=ClassifyRiskArgs,
)
def classify_risk(args: ClassifyRiskArgs) -> dict:
    # ── Collect accounts from both upstream outputs ───────────────────────────
    # account_id → {"structuring": {...}, "anomaly": {...}}
    accounts: dict[str, dict] = {}

    if args.structuring_output:
        for fa in args.structuring_output.get("flagged_accounts", []):
            aid = fa["account_id"]
            accounts.setdefault(aid, {})["structuring"] = fa

    if args.anomaly_output:
        for fa in args.anomaly_output.get("flagged_accounts", []):
            aid = fa["account_id"]
            accounts.setdefault(aid, {})["anomaly"] = fa

    # ── Optional single-account filter ───────────────────────────────────────
    if args.account_id:
        accounts = {k: v for k, v in accounts.items() if k == args.account_id}
        # If the specific account had no flags, still return a low-risk record
        if not accounts:
            accounts[args.account_id] = {}

    # ── Classify each account ─────────────────────────────────────────────────
    classifications: list[dict] = []

    for account_id, signals_data in accounts.items():
        contributing_signals: list[dict] = []
        structuring_points = 0.0
        anomaly_points     = 0.0
        has_structuring    = False
        has_anomaly        = False

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

        # ── Composite score ───────────────────────────────────────────────────
        composite = max(structuring_points, anomaly_points)
        if has_structuring and has_anomaly:
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
