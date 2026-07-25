"""
Tests for detect_structuring, detect_anomalies, classify_risk, and explain_flag.

All tests use the in-memory DuckDB fixture from conftest.py (no real dataset).
The synthetic fixture already contains ACC_A with three obvious near-threshold
transactions (9700, 9850, 9900) — the ideal structuring test account.

No API calls, no LLM, no API keys needed.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import tools  # noqa: F401 — fires @tool decorators
from agent.registry import call_tool
from tools.risk_classifier import (
    STRUCTURING_COUNT_MEDIUM,
    STRUCTURING_COUNT_HIGH,
    STRUCTURING_POINTS_MEDIUM,
    STRUCTURING_POINTS_HIGH,
    ANOMALY_SCORE_MEDIUM,
    ANOMALY_SCORE_HIGH,
    RISK_SCORE_MEDIUM_THRESHOLD,
    RISK_SCORE_HIGH_THRESHOLD,
)


# =============================================================================
# detect_structuring
# =============================================================================

class TestDetectStructuring:

    def test_flags_acc_a_obvious_structuring(self):
        # ACC_A has T0001=9700, T0002=9850, T0003=9900 — all within 5 % of 10 000
        result = call_tool("detect_structuring", {"window_days": 30})
        flagged_ids = {fa["account_id"] for fa in result["flagged_accounts"]}
        assert "ACC_A" in flagged_ids

    def test_acc_a_txn_count_matches_fixture(self):
        result = call_tool("detect_structuring", {"window_days": 30})
        acc_a = next(fa for fa in result["flagged_accounts"] if fa["account_id"] == "ACC_A")
        # T0001, T0002, T0003 are all in range; T0007=9500 also qualifies
        # (9500 >= 9500 and 9500 < 10000); total = 4 matching rows for ACC_A sender
        # Actually: ACC_A sends T0001(9700), T0002(9850), T0003(9900) = 3 near-threshold
        assert acc_a["near_threshold_txn_count"] == 3

    def test_returns_transaction_ids_and_amounts(self):
        result = call_tool("detect_structuring", {"window_days": 30})
        acc_a = next(fa for fa in result["flagged_accounts"] if fa["account_id"] == "ACC_A")
        for txn in acc_a["transactions"]:
            assert "transaction_id" in txn
            assert "amount" in txn
            assert "timestamp" in txn

    def test_flagged_amounts_are_within_band(self):
        result = call_tool("detect_structuring", {"window_days": 30})
        threshold = result["threshold"]
        near_lo   = result["near_lo"]
        for fa in result["flagged_accounts"]:
            for txn in fa["transactions"]:
                assert near_lo <= txn["amount"] < threshold, (
                    f"Amount {txn['amount']} outside band [{near_lo}, {threshold})"
                )

    def test_total_amount_structured_is_sum_of_txn_amounts(self):
        result = call_tool("detect_structuring", {"window_days": 30})
        for fa in result["flagged_accounts"]:
            expected = round(sum(t["amount"] for t in fa["transactions"]), 2)
            assert abs(fa["total_amount_structured"] - expected) < 0.01

    def test_account_filter_restricts_output(self):
        result = call_tool("detect_structuring", {"account_ids": ["ACC_A"], "window_days": 30})
        assert all(fa["account_id"] == "ACC_A" for fa in result["flagged_accounts"])

    def test_non_structuring_account_not_in_flagged(self):
        # ACC_B sends a 50 000 wire — well above threshold, should not be flagged
        result = call_tool("detect_structuring", {"account_ids": ["ACC_B"], "window_days": 30})
        flagged_ids = {fa["account_id"] for fa in result["flagged_accounts"]}
        assert "ACC_B" not in flagged_ids

    def test_output_has_threshold_fields(self):
        result = call_tool("detect_structuring", {})
        assert "threshold"      in result
        assert "threshold_band" in result
        assert "near_lo"        in result

    def test_empty_window_returns_no_flags(self):
        # date_to before all synthetic data (earliest is 2023-01-05)
        result = call_tool("detect_structuring", {"date_to": "2020-01-01"})
        assert result["total_flagged"] == 0
        assert result["flagged_accounts"] == []

    def test_distance_from_threshold_is_positive(self):
        result = call_tool("detect_structuring", {"window_days": 30})
        for fa in result["flagged_accounts"]:
            for txn in fa["transactions"]:
                assert txn["distance_from_threshold"] > 0
                assert txn["pct_below_threshold"] > 0


# =============================================================================
# detect_anomalies
# =============================================================================

class TestDetectAnomalies:

    def test_returns_all_seven_senders(self):
        result = call_tool("detect_anomalies", {"window_days": 30})
        assert result["accounts_analyzed"] == 7

    def test_all_anomaly_scores_in_0_1_range(self):
        result = call_tool("detect_anomalies", {"window_days": 30})
        for rec in result["all_scores"]:
            assert 0.0 <= rec["anomaly_score"] <= 1.0, (
                f"Score {rec['anomaly_score']} out of [0, 1] for {rec['account_id']}"
            )

    def test_flagged_accounts_have_top_features(self):
        result = call_tool("detect_anomalies", {"window_days": 30})
        for fa in result["flagged_accounts"]:
            assert "top_features" in fa
            assert len(fa["top_features"]) > 0
            for feat in fa["top_features"]:
                assert "feature" in feat
                assert "value"   in feat
                assert "zscore"  in feat

    def test_account_filter_restricts_to_one(self):
        result = call_tool("detect_anomalies", {"account_ids": ["ACC_A"], "window_days": 30})
        assert result["accounts_analyzed"] == 1

    def test_no_data_returns_empty(self):
        result = call_tool("detect_anomalies", {"date_to": "2020-01-01", "window_days": 30})
        assert result["accounts_analyzed"] == 0
        assert result["flagged_accounts"] == []

    def test_is_anomalous_flag_is_boolean(self):
        result = call_tool("detect_anomalies", {"window_days": 30})
        for rec in result["all_scores"]:
            assert isinstance(rec["is_anomalous"], bool)

    def test_total_flagged_matches_flagged_accounts_list(self):
        result = call_tool("detect_anomalies", {"window_days": 30})
        assert result["total_flagged"] == len(result["flagged_accounts"])


# =============================================================================
# classify_risk
# =============================================================================

def _make_structuring_output(count: int, total: float = 9000.0) -> dict:
    """Build a minimal detect_structuring-shaped output with given txn count."""
    txns = [{"transaction_id": f"T{i}", "amount": 9700.0, "timestamp": "2023-01-05", "distance_from_threshold": 300.0, "pct_below_threshold": 3.0} for i in range(count)]
    return {
        "threshold": 10_000.0,
        "threshold_band": 0.05,
        "near_lo": 9_500.0,
        "window_days": 30,
        "accounts_scanned": 10,
        "flagged_accounts": [
            {
                "account_id": "TEST_ACC",
                "near_threshold_txn_count": count,
                "transactions": txns,
                "total_amount_structured": total,
                "date_range": {"first": "2023-01-05", "last": "2023-01-07"},
            }
        ],
        "total_flagged": 1,
    }


def _make_anomaly_output(score: float) -> dict:
    """Build a minimal detect_anomalies-shaped output with given anomaly score."""
    is_anom = score >= ANOMALY_SCORE_MEDIUM
    return {
        "accounts_analyzed": 5,
        "window_days": 30,
        "contamination": 0.1,
        "total_flagged": 1 if is_anom else 0,
        "all_scores": [{"account_id": "TEST_ACC", "anomaly_score": score, "is_anomalous": is_anom}],
        "flagged_accounts": (
            [{"account_id": "TEST_ACC", "anomaly_score": score, "is_anomalous": True,
              "top_features": [{"feature": "velocity", "value": 0.5, "zscore": 2.1}]}]
            if is_anom else []
        ),
    }


class TestClassifyRisk:

    def test_zero_signals_returns_low_risk(self):
        # No flagged accounts → low risk
        result = call_tool("classify_risk", {
            "structuring_output": {"flagged_accounts": [], "threshold": 10000, "threshold_band": 0.05, "window_days": 30},
            "anomaly_output":     {"flagged_accounts": []},
            "account_id":         "GHOST",
        })
        clf = result["classifications"][0]
        assert clf["risk_level"] == "low"

    def test_medium_structuring_count_gives_medium_risk(self):
        # Exactly STRUCTURING_COUNT_MEDIUM near-threshold txns → STRUCTURING_POINTS_MEDIUM
        result = call_tool("classify_risk", {
            "structuring_output": _make_structuring_output(STRUCTURING_COUNT_MEDIUM),
        })
        clf = next(c for c in result["classifications"] if c["account_id"] == "TEST_ACC")
        assert clf["risk_level"] == "medium"
        assert clf["risk_score"] == STRUCTURING_POINTS_MEDIUM

    def test_high_structuring_count_gives_high_risk(self):
        result = call_tool("classify_risk", {
            "structuring_output": _make_structuring_output(STRUCTURING_COUNT_HIGH),
        })
        clf = next(c for c in result["classifications"] if c["account_id"] == "TEST_ACC")
        assert clf["risk_level"] == "high"
        assert clf["risk_score"] >= RISK_SCORE_HIGH_THRESHOLD

    def test_one_near_threshold_txn_is_low_risk(self):
        # 1 near-threshold txn → below STRUCTURING_COUNT_MEDIUM → low
        result = call_tool("classify_risk", {
            "structuring_output": _make_structuring_output(1),
        })
        clf = next(c for c in result["classifications"] if c["account_id"] == "TEST_ACC")
        assert clf["risk_level"] == "low"

    def test_high_anomaly_score_gives_high_risk(self):
        result = call_tool("classify_risk", {
            "anomaly_output": _make_anomaly_output(ANOMALY_SCORE_HIGH + 0.01),
        })
        clf = next(c for c in result["classifications"] if c["account_id"] == "TEST_ACC")
        assert clf["risk_level"] == "high"

    def test_medium_anomaly_score_gives_medium_risk(self):
        result = call_tool("classify_risk", {
            "anomaly_output": _make_anomaly_output(ANOMALY_SCORE_MEDIUM + 0.01),
        })
        clf = next(c for c in result["classifications"] if c["account_id"] == "TEST_ACC")
        assert clf["risk_level"] == "medium"

    def test_contributing_signals_list_is_populated(self):
        result = call_tool("classify_risk", {
            "structuring_output": _make_structuring_output(STRUCTURING_COUNT_MEDIUM),
        })
        clf = next(c for c in result["classifications"] if c["account_id"] == "TEST_ACC")
        assert len(clf["contributing_signals"]) > 0

    def test_escalation_monitor_for_low(self):
        result = call_tool("classify_risk", {
            "structuring_output": _make_structuring_output(0),
            "account_id": "GHOST",
        })
        # GHOST had no flagged accounts; it gets added as a low-risk entry
        clf = result["classifications"][0]
        assert clf["escalation"] == "monitor"

    def test_escalation_review_for_medium(self):
        result = call_tool("classify_risk", {
            "structuring_output": _make_structuring_output(STRUCTURING_COUNT_MEDIUM),
        })
        clf = next(c for c in result["classifications"] if c["account_id"] == "TEST_ACC")
        assert clf["escalation"] == "review"

    def test_escalation_report_for_high(self):
        result = call_tool("classify_risk", {
            "structuring_output": _make_structuring_output(STRUCTURING_COUNT_HIGH),
        })
        clf = next(c for c in result["classifications"] if c["account_id"] == "TEST_ACC")
        assert clf["escalation"] == "report"

    def test_risk_score_in_0_100_range(self):
        result = call_tool("classify_risk", {
            "structuring_output": _make_structuring_output(STRUCTURING_COUNT_HIGH),
        })
        for clf in result["classifications"]:
            assert 0.0 <= clf["risk_score"] <= 100.0

    def test_dual_signal_bonus_applied(self):
        # Both structuring and anomaly → composite should include bonus
        high_struct = _make_structuring_output(STRUCTURING_COUNT_MEDIUM)
        high_anom   = _make_anomaly_output(ANOMALY_SCORE_MEDIUM + 0.01)
        result = call_tool("classify_risk", {
            "structuring_output": high_struct,
            "anomaly_output":     high_anom,
        })
        clf = next(c for c in result["classifications"] if c["account_id"] == "TEST_ACC")
        # Without bonus: STRUCTURING_POINTS_MEDIUM = 50; with bonus ≥ 50 + 10 = 60
        from tools.risk_classifier import DUAL_SIGNAL_BONUS
        assert clf["risk_score"] >= STRUCTURING_POINTS_MEDIUM + DUAL_SIGNAL_BONUS - 0.01


# =============================================================================
# explain_flag
# =============================================================================

def _make_classify_output(
    account_id: str = "TEST_ACC",
    risk_level: str = "high",
    risk_score: float = 80.0,
    signals: list[dict] | None = None,
) -> dict:
    if signals is None:
        signals = [
            {
                "signal": "structuring_count",
                "value":  4,
                "label":  "4 near-threshold transactions within 30 days (threshold $10,000)",
                "weight": 0.8,
            },
            {
                "signal": "total_structured_amount",
                "value":  39050.0,
                "label":  "total structured amount $39,050.00",
                "weight": 0.3,
            },
        ]
    return {
        "classifications": [
            {
                "account_id":           account_id,
                "risk_level":           risk_level,
                "risk_score":           risk_score,
                "escalation":           {"low": "monitor", "medium": "review", "high": "report"}[risk_level],
                "contributing_signals": signals,
            }
        ]
    }


class TestExplainFlag:

    def test_grounding_evidence_cited_subset_of_signal_labels(self):
        """Critical: every string in evidence_cited must appear in the input signal labels."""
        classify_out = _make_classify_output()
        result = call_tool("explain_flag", {"classify_output": classify_out})
        exp = result["explanations"][0]

        signal_labels = {s["label"] for s in classify_out["classifications"][0]["contributing_signals"]}
        for cited in exp["evidence_cited"]:
            assert cited in signal_labels, (
                f"Cited evidence '{cited}' was not in contributing_signals labels. "
                f"Signal labels: {signal_labels}"
            )

    def test_explanation_contains_account_id(self):
        classify_out = _make_classify_output(account_id="STRUCT_99")
        result = call_tool("explain_flag", {"classify_output": classify_out})
        assert "STRUCT_99" in result["explanations"][0]["explanation"]

    def test_summary_contains_account_id(self):
        classify_out = _make_classify_output(account_id="STRUCT_99")
        result = call_tool("explain_flag", {"classify_output": classify_out})
        assert "STRUCT_99" in result["explanations"][0]["summary"]

    def test_escalation_report_for_high_risk(self):
        classify_out = _make_classify_output(risk_level="high")
        result = call_tool("explain_flag", {"classify_output": classify_out})
        assert result["explanations"][0]["escalation"] == "report"

    def test_escalation_review_for_medium_risk(self):
        classify_out = _make_classify_output(risk_level="medium", risk_score=50.0)
        result = call_tool("explain_flag", {"classify_output": classify_out})
        assert result["explanations"][0]["escalation"] == "review"

    def test_escalation_monitor_for_low_risk(self):
        classify_out = _make_classify_output(risk_level="low", risk_score=10.0, signals=[])
        result = call_tool("explain_flag", {"classify_output": classify_out})
        assert result["explanations"][0]["escalation"] == "monitor"

    def test_empty_classify_output_returns_empty(self):
        result = call_tool("explain_flag", {})
        assert result["explanations"] == []

    def test_account_id_filter(self):
        # Two accounts in classify_output; filter to one
        classify_out = {
            "classifications": [
                _make_classify_output("ACC_1", "high")["classifications"][0],
                _make_classify_output("ACC_2", "low",  10.0, [])["classifications"][0],
            ]
        }
        result = call_tool("explain_flag", {
            "classify_output": classify_out,
            "account_id": "ACC_1",
        })
        assert len(result["explanations"]) == 1
        assert result["explanations"][0]["account_id"] == "ACC_1"

    def test_anomaly_only_explanation_uses_anomaly_template(self):
        signals = [
            {
                "signal": "anomaly_score",
                "value":  0.82,
                "label":  "anomaly score 0.8200 (medium threshold: 0.55, high: 0.75)",
                "weight": 0.7,
            },
            {
                "signal": "feature_velocity",
                "value":  0.15,
                "label":  "velocity = 0.1500 (z-score 2.40)",
                "weight": 0.1,
            },
        ]
        classify_out = _make_classify_output(risk_level="high", risk_score=70.0, signals=signals)
        result = call_tool("explain_flag", {"classify_output": classify_out})
        exp = result["explanations"][0]
        # Anomaly score value must appear in explanation
        assert "0.8200" in exp["explanation"]
        # Grounding still holds
        signal_labels = {s["label"] for s in signals}
        for cited in exp["evidence_cited"]:
            assert cited in signal_labels

    def test_explanation_is_nonempty_string(self):
        result = call_tool("explain_flag", {"classify_output": _make_classify_output()})
        assert isinstance(result["explanations"][0]["explanation"], str)
        assert len(result["explanations"][0]["explanation"]) > 20
