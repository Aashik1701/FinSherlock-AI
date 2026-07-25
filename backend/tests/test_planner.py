"""
Tests for deterministic_fallback_plan().

No LLM calls, no API keys, no database access required.
These tests verify that the keyword/regex routing produces sensible plans
for every query shape an analyst might enter.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

import tools  # noqa: F401 — fires @tool decorators so TOOL_REGISTRY is populated
from agent.planner import deterministic_fallback_plan
from agent.registry import TOOL_REGISTRY


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def _tool_names(plan: dict) -> list[str]:
    return [step["tool"] for step in plan["plan"]]


def _assert_all_tools_registered(plan: dict) -> None:
    """Every tool named in the plan must exist in TOOL_REGISTRY."""
    for name in _tool_names(plan):
        assert name in TOOL_REGISTRY, f"Plan references unregistered tool: '{name}'"


# ---------------------------------------------------------------------------
# Structuring queries
# ---------------------------------------------------------------------------

class TestStructuringDetection:
    def test_structuring_keyword(self):
        plan = deterministic_fallback_plan("Find structuring patterns in recent transactions")
        assert plan["intent"] == "pattern_scan"
        assert plan["target_pattern"] == "structuring"

    def test_threshold_keyword(self):
        plan = deterministic_fallback_plan("Show accounts with transactions just below the reporting threshold")
        assert plan["target_pattern"] == "structuring"

    def test_cash_deposit_keyword(self):
        plan = deterministic_fallback_plan("Suspicious cash deposits in the last 30 days")
        assert plan["target_pattern"] == "structuring"

    def test_structuring_includes_full_chain(self):
        plan = deterministic_fallback_plan("Detect structuring activity")
        names = _tool_names(plan)
        assert "run_eda"            in names
        assert "engineer_features"  in names
        assert "detect_structuring" in names
        assert "classify_risk"      in names
        assert "explain_flag"       in names

    def test_structuring_all_tools_registered(self):
        plan = deterministic_fallback_plan("Look for structuring")
        _assert_all_tools_registered(plan)

    def test_structuring_source_is_deterministic(self):
        plan = deterministic_fallback_plan("Structuring risk")
        assert plan["planner_source"] == "deterministic"


# ---------------------------------------------------------------------------
# Smurfing queries
# ---------------------------------------------------------------------------

class TestSmurfingDetection:
    def test_smurf_keyword(self):
        plan = deterministic_fallback_plan("Are there any smurfing patterns?")
        assert plan["target_pattern"] == "smurfing"

    def test_fan_out_keyword(self):
        plan = deterministic_fallback_plan("Identify fan-out behavior from a single account")
        assert plan["target_pattern"] == "smurfing"

    def test_fan_in_keyword(self):
        plan = deterministic_fallback_plan("Check for fan-in transactions converging to one account")
        assert plan["target_pattern"] == "smurfing"

    def test_smurfing_intent_is_pattern_scan(self):
        plan = deterministic_fallback_plan("smurf detection please")
        assert plan["intent"] == "pattern_scan"

    def test_smurfing_all_tools_registered(self):
        _assert_all_tools_registered(deterministic_fallback_plan("find smurf accounts"))


# ---------------------------------------------------------------------------
# Layering queries
# ---------------------------------------------------------------------------

class TestLayeringDetection:
    def test_layering_keyword(self):
        plan = deterministic_fallback_plan("Show me layering patterns through intermediary accounts")
        assert plan["target_pattern"] == "layering"

    def test_chain_keyword(self):
        plan = deterministic_fallback_plan("Multi-hop chain of transactions from Germany to France")
        assert plan["target_pattern"] == "layering"

    def test_hop_keyword(self):
        plan = deterministic_fallback_plan("Find transactions with multiple hops")
        assert plan["target_pattern"] == "layering"

    def test_layering_intent_is_pattern_scan(self):
        plan = deterministic_fallback_plan("layering detection")
        assert plan["intent"] == "pattern_scan"

    def test_layering_all_tools_registered(self):
        _assert_all_tools_registered(deterministic_fallback_plan("find layering"))


# ---------------------------------------------------------------------------
# Single-entity (customer / account) queries
# ---------------------------------------------------------------------------

class TestSingleEntityLookup:
    def test_customer_id_extracted(self):
        plan = deterministic_fallback_plan("Explain customer 1098")
        assert plan["intent"] == "single_entity_lookup"
        assert plan["filters"]["account_ids"] == ["1098"]

    def test_account_id_extracted(self):
        plan = deterministic_fallback_plan("Show account ACC_A transaction history")
        assert plan["intent"] == "single_entity_lookup"
        assert plan["filters"]["account_ids"] == ["ACC_A"]

    def test_investigate_verb(self):
        plan = deterministic_fallback_plan("Investigate account XYZ-99")
        assert plan["intent"] == "single_entity_lookup"
        assert plan["filters"]["account_ids"] == ["XYZ-99"]

    def test_single_entity_uses_full_chain(self):
        plan = deterministic_fallback_plan("Explain customer 42")
        names = _tool_names(plan)
        assert "engineer_features" in names
        assert "detect_anomalies"  in names
        assert "classify_risk"     in names
        assert "explain_flag"      in names

    def test_single_entity_skips_eda(self):
        # EDA is a dataset-wide scan — pointless for a single-entity query
        plan = deterministic_fallback_plan("Explain customer 42")
        assert "run_eda" not in _tool_names(plan)

    def test_account_ids_passed_into_tool_args(self):
        plan = deterministic_fallback_plan("account ACC_B")
        fe_step = next(s for s in plan["plan"] if s["tool"] == "engineer_features")
        assert "ACC_B" in fe_step["args"]["account_ids"]

    def test_injection_placeholders_present_in_classify_and_explain(self):
        # classify_risk and explain_flag must carry null placeholders for injection
        plan = deterministic_fallback_plan("account ACC_B")
        cr_step = next(s for s in plan["plan"] if s["tool"] == "classify_risk")
        ef_step = next(s for s in plan["plan"] if s["tool"] == "explain_flag")
        assert "anomaly_output"  in cr_step["args"]
        assert "classify_output" in ef_step["args"]

    def test_single_entity_all_tools_registered(self):
        _assert_all_tools_registered(deterministic_fallback_plan("customer 999"))


# ---------------------------------------------------------------------------
# Date window extraction
# ---------------------------------------------------------------------------

class TestDateWindowExtraction:
    def test_last_n_days_sets_window_days(self):
        plan = deterministic_fallback_plan("Find suspicious activity in the last 60 days")
        assert plan["filters"]["window_days"] == 60

    def test_since_date_extracted(self):
        plan = deterministic_fallback_plan("Show transactions since 2023-06-01")
        assert plan["filters"]["date_from"] == "2023-06-01"

    def test_until_date_extracted(self):
        plan = deterministic_fallback_plan("Transactions before 2023-12-31")
        assert plan["filters"]["date_to"] == "2023-12-31"

    def test_default_window_is_30_days(self):
        plan = deterministic_fallback_plan("Run a quick scan")
        assert plan["filters"]["window_days"] == 30


# ---------------------------------------------------------------------------
# Generic / broad-exploration catch-all
# ---------------------------------------------------------------------------

class TestBroadExploration:
    def test_vague_query_is_broad_exploration(self):
        plan = deterministic_fallback_plan("Give me an overview of the data")
        assert plan["intent"] == "broad_exploration"
        assert plan["target_pattern"] is None

    def test_empty_ish_query_falls_through(self):
        plan = deterministic_fallback_plan("what is going on")
        assert plan["intent"] == "broad_exploration"

    def test_broad_exploration_includes_full_chain(self):
        plan = deterministic_fallback_plan("run a full scan")
        names = _tool_names(plan)
        assert "run_eda"           in names
        assert "engineer_features" in names
        assert "detect_anomalies"  in names
        assert "classify_risk"     in names
        assert "explain_flag"      in names

    def test_broad_exploration_all_tools_registered(self):
        _assert_all_tools_registered(deterministic_fallback_plan("scan everything"))

    def test_source_is_deterministic(self):
        plan = deterministic_fallback_plan("show me everything")
        assert plan["planner_source"] == "deterministic"
