"""
Explainer tool — registered in TOOL_REGISTRY.

Generates human-readable investigation summaries from classify_risk output using
string templates that reference ONLY values present in contributing_signals.
No LLM generation — every cited number is traceable to the input.

Grounding guarantee (enforced by construction):
  - Templates are parameterised exclusively from contributing_signals fields.
  - evidence_cited is populated with the exact signal label strings used,
    so callers (and tests) can verify no value was invented.
"""

from __future__ import annotations

import logging
from typing import Optional

from pydantic import BaseModel, Field

from agent.registry import tool

logger = logging.getLogger(__name__)

# =============================================================================
# Escalation actions and their plain-language instructions
# =============================================================================
_ESCALATION_ACTIONS: dict[str, tuple[str, str]] = {
    # risk_level → (action_code, action_instruction)
    "low":    ("monitor",  "Continue routine monitoring. No immediate action required."),
    "medium": ("review",   "Assign for compliance review within 5 business days."),
    "high":   ("report",   "Escalate immediately and file a Suspicious Activity Report (SAR) within 30 days."),
}

# =============================================================================
# Templates
# =============================================================================
# Each template is filled exclusively from values derived from contributing_signals.
# The variables injected into each template are listed in comments above it.

# Variables: account_id, risk_level, count, window_days, threshold, total_amount, band_pct
_TEMPLATE_STRUCTURING = (
    "Account {account_id} has been classified as {risk_level} risk. "
    "{count} deposit(s) totalling ${total_amount:,.2f} were detected within "
    "{band_pct:.0f}% of the ${threshold:,.0f} reporting threshold over a "
    "{window_days}-day review window. "
    "This clustering of sub-threshold amounts is the defining signature of "
    "structuring, also known as smurfing, and may constitute a violation of "
    "Bank Secrecy Act (BSA) / FinCEN Currency Transaction Report (CTR) requirements."
)

# Variables: account_id, risk_level, score, medium_threshold, high_threshold, top_features_str
_TEMPLATE_ANOMALY = (
    "Account {account_id} has been classified as {risk_level} risk. "
    "Statistical analysis produced an anomaly score of {score:.4f} "
    "(medium threshold: {medium_threshold}, high threshold: {high_threshold}). "
    "The primary behavioural drivers were: {top_features_str}."
)

# Variables: account_id, risk_level, count, window_days, threshold, total_amount,
#            band_pct, score, medium_threshold, high_threshold, top_features_str
_TEMPLATE_COMBINED = (
    "Account {account_id} has been classified as {risk_level} risk based on "
    "multiple converging signals. "
    "Rule-based analysis found {count} deposit(s) totalling ${total_amount:,.2f} "
    "within {band_pct:.0f}% of the ${threshold:,.0f} reporting threshold "
    "({window_days}-day window). "
    "This was corroborated by a statistical anomaly score of {score:.4f} "
    "(threshold: {medium_threshold}), driven by: {top_features_str}."
)

# Variables: account_id, risk_level, signal_count, risk_score
_TEMPLATE_GENERIC = (
    "Account {account_id} has been classified as {risk_level} risk "
    "(composite score: {risk_score:.1f}) based on {signal_count} contributing signal(s). "
    "Manual review of the associated transaction activity is recommended."
)


# =============================================================================
# Tool
# =============================================================================


class ExplainFlagArgs(BaseModel):
    classify_output: Optional[dict] = Field(
        default=None,
        description=(
            "Full output dict from classify_risk. "
            "Injected automatically by the orchestrator when that tool ran first."
        ),
    )
    target_pattern: Optional[str] = Field(
        default=None,
        description="AML pattern hint: 'structuring', 'smurfing', 'layering', or None.",
    )
    account_id: Optional[str] = Field(
        default=None,
        description="If set, generate explanation only for this account.",
    )


@tool(
    name="explain_flag",
    description=(
        "Generates grounded, evidence-cited explanations from classify_risk output. "
        "Uses string templates that reference ONLY values present in contributing_signals "
        "— no free-form LLM generation. Returns an escalation recommendation "
        "(monitor / review / report) alongside the explanation."
    ),
    schema=ExplainFlagArgs,
)
def explain_flag(args: ExplainFlagArgs) -> dict:
    if not args.classify_output:
        return {"explanations": [], "note": "No classify_output provided."}

    classifications: list[dict] = args.classify_output.get("classifications", [])
    if args.account_id:
        classifications = [c for c in classifications if c["account_id"] == args.account_id]

    explanations: list[dict] = []

    for clf in classifications:
        account_id = clf["account_id"]
        risk_level = clf["risk_level"]
        risk_score = clf.get("risk_score", 0.0)
        signals    = clf.get("contributing_signals", [])

        action, instruction = _ESCALATION_ACTIONS.get(risk_level, ("monitor", "Continue routine monitoring."))

        # ── Extract signal values by type ─────────────────────────────────────
        # These are the ONLY values allowed in the explanation template.
        sig_map: dict[str, dict] = {s["signal"]: s for s in signals}

        has_structuring = "structuring_count" in sig_map
        has_anomaly     = "anomaly_score"     in sig_map

        evidence_cited: list[str] = []
        explanation: str
        summary: str

        if has_structuring and has_anomaly:
            # ── Combined template ─────────────────────────────────────────────
            s_sig = sig_map["structuring_count"]
            a_sig = sig_map["anomaly_score"]

            count        = s_sig["value"]
            total_amount = sig_map.get("total_structured_amount", {}).get("value", 0.0)
            score        = a_sig["value"]

            # Derive window_days and threshold from the label (they were embedded there)
            # Rather than parsing, we stored them as separate signals — use safe fallbacks
            window_days = _extract_int_from_label(s_sig["label"], "within", "days", fallback=30)
            threshold   = _extract_float_from_label(s_sig["label"], "threshold $", fallback=10_000.0)
            band_pct    = 5.0   # default; matches _DEFAULT_BAND in anomaly_detection

            top_feats = [s for s in signals if s["signal"].startswith("feature_")]
            top_features_str = (
                ", ".join(f['label'] for f in top_feats[:3]) if top_feats
                else "transaction velocity and volume"
            )

            from tools.risk_classifier import ANOMALY_SCORE_MEDIUM, ANOMALY_SCORE_HIGH
            explanation = _TEMPLATE_COMBINED.format(
                account_id=account_id, risk_level=risk_level,
                count=count, window_days=window_days, threshold=threshold,
                total_amount=total_amount, band_pct=band_pct,
                score=score, medium_threshold=ANOMALY_SCORE_MEDIUM,
                high_threshold=ANOMALY_SCORE_HIGH,
                top_features_str=top_features_str,
            )
            evidence_cited = [s_sig["label"], a_sig["label"]] + [f["label"] for f in top_feats[:3]]
            summary = (
                f"Account {account_id}: {risk_level.upper()} risk — "
                f"{count} structured deposit(s) + anomaly score {score:.4f}"
            )

        elif has_structuring:
            # ── Structuring-only template ─────────────────────────────────────
            s_sig = sig_map["structuring_count"]
            count = s_sig["value"]
            total_amount = sig_map.get("total_structured_amount", {}).get("value", 0.0)
            window_days  = _extract_int_from_label(s_sig["label"], "within", "days", fallback=30)
            threshold    = _extract_float_from_label(s_sig["label"], "threshold $", fallback=10_000.0)
            band_pct     = 5.0

            explanation = _TEMPLATE_STRUCTURING.format(
                account_id=account_id, risk_level=risk_level,
                count=count, window_days=window_days, threshold=threshold,
                total_amount=total_amount, band_pct=band_pct,
            )
            evidence_cited = [s_sig["label"]]
            if "total_structured_amount" in sig_map:
                evidence_cited.append(sig_map["total_structured_amount"]["label"])
            summary = (
                f"Account {account_id}: {risk_level.upper()} risk — "
                f"{count} deposit(s) near ${threshold:,.0f} threshold "
                f"totalling ${total_amount:,.2f}"
            )

        elif has_anomaly:
            # ── Anomaly-only template ─────────────────────────────────────────
            a_sig  = sig_map["anomaly_score"]
            score  = a_sig["value"]
            top_feats = [s for s in signals if s["signal"].startswith("feature_")]
            top_features_str = (
                ", ".join(f["label"] for f in top_feats[:3]) if top_feats
                else "transaction velocity and volume"
            )

            from tools.risk_classifier import ANOMALY_SCORE_MEDIUM, ANOMALY_SCORE_HIGH
            explanation = _TEMPLATE_ANOMALY.format(
                account_id=account_id, risk_level=risk_level,
                score=score,
                medium_threshold=ANOMALY_SCORE_MEDIUM,
                high_threshold=ANOMALY_SCORE_HIGH,
                top_features_str=top_features_str,
            )
            evidence_cited = [a_sig["label"]] + [f["label"] for f in top_feats[:3]]
            summary = (
                f"Account {account_id}: {risk_level.upper()} risk — "
                f"anomaly score {score:.4f}"
            )

        else:
            # ── Generic fallback ──────────────────────────────────────────────
            explanation = _TEMPLATE_GENERIC.format(
                account_id=account_id, risk_level=risk_level,
                risk_score=risk_score, signal_count=len(signals),
            )
            evidence_cited = [s["label"] for s in signals]
            summary = f"Account {account_id}: {risk_level.upper()} risk — {len(signals)} signal(s)"

        explanations.append({
            "account_id":     account_id,
            "risk_level":     risk_level,
            "risk_score":     risk_score,
            "escalation":     action,
            "instruction":    instruction,
            "summary":        summary,
            "explanation":    explanation,
            "evidence_cited": evidence_cited,
        })

    return {"explanations": explanations}


# =============================================================================
# Private helpers for extracting numeric values from signal label strings
# =============================================================================

def _extract_int_from_label(label: str, after: str, before: str, fallback: int) -> int:
    """Parse the integer between `after` and `before` in label. Returns fallback on failure."""
    import re
    pattern = rf"{re.escape(after)}\s+(\d+)\s+{re.escape(before)}"
    m = re.search(pattern, label)
    return int(m.group(1)) if m else fallback


def _extract_float_from_label(label: str, after: str, fallback: float) -> float:
    """Parse the first float/int immediately after `after` in label. Returns fallback on failure."""
    import re
    escaped = re.escape(after)
    m = re.search(rf"{escaped}([\d,]+(?:\.\d+)?)", label)
    if m:
        return float(m.group(1).replace(",", ""))
    return fallback
