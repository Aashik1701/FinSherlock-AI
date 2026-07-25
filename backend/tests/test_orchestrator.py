"""
Tests for execute_plan().

Uses hand-built plan dicts (no LLM, no API keys) and the in-memory DuckDB
fixture from conftest.py (via the autouse patch_db fixture).
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import tools  # noqa: F401 — fires @tool decorators
from agent.orchestrator import execute_plan


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _eda_plan(extra_args: dict | None = None) -> dict:
    return {
        "intent": "broad_exploration",
        "filters": {"date_from": None, "date_to": None, "account_ids": None, "window_days": 30},
        "target_pattern": None,
        "plan": [{"tool": "run_eda", "args": extra_args or {}}],
        "planner_source": "test",
    }


def _fe_plan(account_ids: list[str] | None = None) -> dict:
    return {
        "intent": "single_entity_lookup",
        "filters": {"date_from": None, "date_to": None, "account_ids": account_ids, "window_days": 30},
        "target_pattern": None,
        "plan": [
            {
                "tool": "engineer_features",
                "args": {"account_ids": account_ids, "window_days": 30, "persist": False},
            }
        ],
        "planner_source": "test",
    }


def _two_step_plan() -> dict:
    return {
        "intent": "pattern_scan",
        "filters": {"date_from": None, "date_to": None, "account_ids": None, "window_days": 30},
        "target_pattern": "structuring",
        "plan": [
            {"tool": "run_eda", "args": {}},
            {"tool": "engineer_features", "args": {"window_days": 30, "persist": False}},
        ],
        "planner_source": "test",
    }


# ---------------------------------------------------------------------------
# Result structure
# ---------------------------------------------------------------------------

class TestExecutePlanStructure:
    def test_returns_plan_key(self):
        output = execute_plan(_eda_plan())
        assert "plan" in output

    def test_returns_results_key(self):
        output = execute_plan(_eda_plan())
        assert "results" in output

    def test_returns_timing_key(self):
        output = execute_plan(_eda_plan())
        assert "timing" in output

    def test_returns_errors_key(self):
        output = execute_plan(_eda_plan())
        assert "errors" in output

    def test_plan_echoed_unchanged(self):
        plan = _eda_plan()
        output = execute_plan(plan)
        assert output["plan"] is plan

    def test_empty_plan_returns_empty_results(self):
        empty = {"intent": "broad_exploration", "plan": [], "planner_source": "test"}
        output = execute_plan(empty)
        assert output["results"] == {}
        assert output["errors"] == []


# ---------------------------------------------------------------------------
# Single-tool execution — run_eda
# ---------------------------------------------------------------------------

class TestEdaToolExecution:
    def test_eda_result_present(self):
        output = execute_plan(_eda_plan())
        assert "run_eda" in output["results"]

    def test_eda_result_has_total_rows(self):
        output = execute_plan(_eda_plan())
        assert "total_rows" in output["results"]["run_eda"]

    def test_eda_rows_match_synthetic_fixture(self):
        output = execute_plan(_eda_plan())
        assert output["results"]["run_eda"]["total_rows"] == 15

    def test_eda_no_errors(self):
        output = execute_plan(_eda_plan())
        assert output["errors"] == []

    def test_eda_timing_recorded(self):
        output = execute_plan(_eda_plan())
        assert "run_eda" in output["timing"]
        assert output["timing"]["run_eda"] >= 0


# ---------------------------------------------------------------------------
# Single-tool execution — engineer_features
# ---------------------------------------------------------------------------

class TestFeatureEngineeringExecution:
    def test_feature_result_present(self):
        output = execute_plan(_fe_plan(["ACC_A"]))
        assert "engineer_features" in output["results"]

    def test_account_filter_passed_through(self):
        output = execute_plan(_fe_plan(["ACC_A"]))
        result = output["results"]["engineer_features"]
        assert result["accounts_processed"] == 1
        assert result["features"][0]["account_id"] == "ACC_A"

    def test_no_errors(self):
        output = execute_plan(_fe_plan(["ACC_A"]))
        assert output["errors"] == []

    def test_timing_recorded(self):
        output = execute_plan(_fe_plan(["ACC_A"]))
        assert output["timing"].get("engineer_features", -1) >= 0


# ---------------------------------------------------------------------------
# Two-step plan — sequential execution and result ordering
# ---------------------------------------------------------------------------

class TestTwoStepPlan:
    def test_both_tools_present_in_results(self):
        output = execute_plan(_two_step_plan())
        assert "run_eda" in output["results"]
        assert "engineer_features" in output["results"]

    def test_no_errors_in_two_step_plan(self):
        output = execute_plan(_two_step_plan())
        assert output["errors"] == []

    def test_timing_for_both_tools(self):
        output = execute_plan(_two_step_plan())
        assert "run_eda" in output["timing"]
        assert "engineer_features" in output["timing"]

    def test_eda_result_integrity(self):
        output = execute_plan(_two_step_plan())
        assert output["results"]["run_eda"]["total_rows"] == 15

    def test_feature_result_integrity(self):
        output = execute_plan(_two_step_plan())
        assert output["results"]["engineer_features"]["accounts_processed"] == 7


# ---------------------------------------------------------------------------
# Error isolation — a bad tool name must not crash the whole plan
# ---------------------------------------------------------------------------

class TestErrorIsolation:
    def test_unknown_tool_does_not_raise(self):
        bad_plan = {
            "intent": "broad_exploration",
            "plan": [
                {"tool": "nonexistent_tool", "args": {}},
                {"tool": "run_eda",          "args": {}},
            ],
            "planner_source": "test",
        }
        output = execute_plan(bad_plan)
        # The bad step should be recorded as an error
        assert "nonexistent_tool" in output["errors"]
        # The good step should still have run
        assert "run_eda" in output["results"]
        assert "error" not in output["results"].get("run_eda", {})

    def test_error_result_contains_error_key(self):
        bad_plan = {
            "intent": "broad_exploration",
            "plan": [{"tool": "no_such_tool", "args": {}}],
            "planner_source": "test",
        }
        output = execute_plan(bad_plan)
        assert "error" in output["results"]["no_such_tool"]

    def test_step_with_missing_tool_key_is_skipped(self):
        weird_plan = {
            "intent": "broad_exploration",
            "plan": [
                {},                              # no "tool" key at all
                {"tool": "run_eda", "args": {}},
            ],
            "planner_source": "test",
        }
        output = execute_plan(weird_plan)
        # The valid step should still run
        assert "run_eda" in output["results"]
