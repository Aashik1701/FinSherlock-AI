"""
Regression tests for bugs found in the hackathon self-audit.

Each test here documents a specific defect that was discovered in production
and is named after the scenario that triggered it.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest
import tools  # noqa: F401 — fires @tool decorators so TOOL_REGISTRY is populated

from agent.orchestrator import execute_plan
from agent.planner import deterministic_fallback_plan


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _tool_names(plan: dict) -> list[str]:
    return [step["tool"] for step in plan["plan"]]


def _get_result(outcome: dict, tool_name: str) -> dict:
    """Retrieve a tool result from the execute_plan output dict."""
    return outcome["results"].get(tool_name, {})


def _first_classification(outcome: dict) -> dict:
    """Return the first classification entry from classify_risk output."""
    classifications = _get_result(outcome, "classify_risk").get("classifications", [])
    assert classifications, "classify_risk returned no classifications"
    return classifications[0]


def _first_explanation(outcome: dict) -> dict:
    """Return the first explanation entry from explain_flag output."""
    explanations = _get_result(outcome, "explain_flag").get("explanations", [])
    assert explanations, "explain_flag returned no explanations"
    return explanations[0]


# ---------------------------------------------------------------------------
# Regression: single_entity_lookup must include detect_structuring
#
# Bug: querying "Is account 100428660 suspicious?" returned LOW RISK / score 0.0
# for an account with 31 near-threshold deposits totalling $303,768.  Root
# cause: the single_entity_lookup plan omitted detect_structuring, so
# classify_risk never received the structuring signal.
# ---------------------------------------------------------------------------

class TestSingleEntityLookupCatchesStructuring:
    """
    ACC_A in the shared test fixture has 3 cash deposits in the near-threshold
    band ($9,700 / $9,850 / $9,900), which should trigger HIGH risk via the
    structuring signal.  Before the fix, single_entity_lookup only called
    detect_anomalies (which fails on n=1 population), so classify_risk saw
    zero contributing signals and returned LOW risk.
    """

    # --- Planner-level: plan must include detect_structuring ---

    def test_single_entity_plan_includes_detect_structuring(self):
        plan = deterministic_fallback_plan("Is account ACC_A suspicious?")
        assert plan["intent"] == "single_entity_lookup"
        assert "detect_structuring" in _tool_names(plan), (
            "single_entity_lookup plan must include detect_structuring; "
            "without it, near-threshold deposits are invisible to classify_risk"
        )

    def test_single_entity_plan_structuring_before_classify(self):
        """detect_structuring must appear before classify_risk so injection works."""
        plan = deterministic_fallback_plan("Is account ACC_A suspicious?")
        names = _tool_names(plan)
        assert "detect_structuring" in names
        assert "classify_risk" in names
        assert names.index("detect_structuring") < names.index("classify_risk")

    def test_single_entity_classify_risk_has_structuring_injection_placeholder(self):
        """classify_risk args must carry structuring_output=None for orchestrator injection."""
        plan = deterministic_fallback_plan("Is account ACC_A suspicious?")
        cr_step = next(s for s in plan["plan"] if s["tool"] == "classify_risk")
        assert "structuring_output" in cr_step["args"], (
            "classify_risk must declare structuring_output=None so the orchestrator "
            "injects the detect_structuring result at runtime"
        )
        assert cr_step["args"]["structuring_output"] is None

    # --- End-to-end: execution must produce HIGH risk for ACC_A ---

    def test_single_entity_lookup_catches_structuring(self):
        """
        Core regression guard: executing a single_entity_lookup plan for an
        account with clustered near-threshold deposits must produce HIGH risk
        with detect_structuring contributing signals present.

        Fixture account ACC_A has 3 near-threshold cash deposits:
          T0001  $9,700  2023-01-05
          T0002  $9,850  2023-01-06
          T0003  $9,900  2023-01-07
        Any plan that includes detect_structuring and routes its output into
        classify_risk should produce high risk / score >= 60.
        """
        plan = {
            "intent": "single_entity_lookup",
            "filters": {
                "date_from": None, "date_to": None,
                "account_ids": ["ACC_A"], "window_days": 30,
            },
            "target_pattern": None,
            "plan": [
                {
                    "tool": "engineer_features",
                    "args": {"account_ids": ["ACC_A"], "window_days": 30, "persist": False},
                },
                {
                    "tool": "detect_structuring",
                    "args": {"account_ids": ["ACC_A"], "window_days": 30},
                },
                {
                    "tool": "detect_anomalies",
                    "args": {"account_ids": ["ACC_A"], "window_days": 30},
                },
                {
                    "tool": "classify_risk",
                    "args": {
                        "structuring_output": None,
                        "anomaly_output": None,
                        "account_id": "ACC_A",
                    },
                },
                {
                    "tool": "explain_flag",
                    "args": {"classify_output": None, "account_id": "ACC_A"},
                },
            ],
            "planner_source": "test_regression",
        }

        outcome = execute_plan(plan)

        # detect_structuring must find ACC_A's 3 near-threshold transactions
        structuring = _get_result(outcome, "detect_structuring")
        flagged_ids = [fa["account_id"] for fa in structuring.get("flagged_accounts", [])]
        assert "ACC_A" in flagged_ids, (
            f"detect_structuring did not flag ACC_A; flagged_accounts={flagged_ids}"
        )
        acc_a_struct = next(fa for fa in structuring["flagged_accounts"] if fa["account_id"] == "ACC_A")
        assert acc_a_struct["near_threshold_txn_count"] >= 2

        # classify_risk must produce at least MEDIUM risk (not LOW).
        # ACC_A has 3 near-threshold deposits: count ≥ 2 → STRUCTURING_POINTS_MEDIUM (50),
        # which maps to risk_level="medium".  HIGH requires ≥ 4 deposits (STRUCTURING_COUNT_HIGH).
        # The regression is that the result is no longer LOW (score 0.0) as it was before the fix.
        classification = _first_classification(outcome)
        assert classification["account_id"] == "ACC_A"
        assert classification["risk_level"] in ("medium", "high"), (
            f"Expected at least MEDIUM risk for ACC_A (3 near-threshold deposits); "
            f"before the fix, single_entity_lookup returned LOW because detect_structuring "
            f"was not called and classify_risk saw zero signals. "
            f"Got {classification['risk_level']!r} (score={classification['risk_score']})"
        )
        assert classification["risk_score"] >= 50.0, (
            f"Risk score {classification['risk_score']} is below 50 despite ≥2 structuring deposits"
        )
        assert classification["escalation"] in ("review", "report")

        # At least one contributing signal must reference structuring
        signal_names = [s["signal"] for s in classification.get("contributing_signals", [])]
        assert any("structuring" in name for name in signal_names), (
            f"No structuring signal in contributing_signals: {signal_names}"
        )

        # explain_flag must propagate the non-LOW risk verdict
        explanation = _first_explanation(outcome)
        assert explanation["risk_level"] in ("medium", "high")
        assert explanation["escalation"] in ("review", "report")

    def test_detect_anomalies_insufficient_population_returns_neutral(self):
        """
        detect_anomalies on a single account must return is_anomalous=False with
        a descriptive note instead of running IsolationForest (which always scores
        a single sample as 0.5 and is meaningless).  classify_risk must not treat
        this neutral score as a real signal.
        """
        from tools.anomaly_detection import DetectAnomaliesArgs, detect_anomalies

        result = detect_anomalies(DetectAnomaliesArgs(
            account_ids=["ACC_A"],
            window_days=30,
        ))

        assert result["total_flagged"] == 0, (
            "Single-account detect_anomalies must flag nothing — "
            "IsolationForest is meaningless with n=1"
        )

        # The note must explain WHY rather than silently returning a neutral score
        assert "note" in result, "Missing 'note' field explaining insufficient population"
        assert "insufficient" in result["note"].lower() or "minimum" in result["note"].lower()

        # anomaly_score should be None (not 0.5) to prevent misinterpretation
        if result["all_scores"]:
            score_entry = result["all_scores"][0]
            assert score_entry["anomaly_score"] is None, (
                "anomaly_score must be None (not 0.5) for insufficient population — "
                "a non-None score could be misread as 'not anomalous' by classify_risk"
            )
            assert score_entry["is_anomalous"] is False
