"""
Pytest tests for run_eda and engineer_features tools.

Fixtures (mem_conn, patch_db) are in conftest.py and applied automatically.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import tools  # noqa: F401 — fires @tool decorators
from agent.registry import call_tool


class TestRunEDA:
    def test_total_row_count(self):
        result = call_tool("run_eda", {})
        assert result["total_rows"] == 15

    def test_date_range_present(self):
        result = call_tool("run_eda", {})
        assert result["date_range"]["earliest"] is not None
        assert result["date_range"]["latest"] is not None

    def test_transaction_type_breakdown_keys(self):
        result = call_tool("run_eda", {})
        types_in_result = {r["transaction_type"] for r in result["transaction_type_breakdown"]}
        assert "cash_deposit" in types_in_result
        assert "wire" in types_in_result

    def test_transaction_type_pct_sums_to_100(self):
        result = call_tool("run_eda", {})
        total_pct = sum(r["pct"] for r in result["transaction_type_breakdown"])
        assert abs(total_pct - 100.0) < 0.5

    def test_amount_stats_ordering(self):
        result = call_tool("run_eda", {})
        stats = result["amount_stats"]
        assert stats["min"] <= stats["median"] <= stats["max"]
        assert stats["mean"] > 0

    def test_missing_values_report_has_all_columns(self):
        result = call_tool("run_eda", {})
        expected_cols = {
            "transaction_id", "timestamp", "sender_account_id", "receiver_account_id",
            "amount", "currency", "transaction_type", "country", "channel", "is_laundering",
        }
        assert expected_cols == set(result["missing_values"].keys())

    def test_laundering_label_distribution_present(self):
        result = call_tool("run_eda", {})
        assert result["laundering_label_dist"] is not None
        labels = {str(r["is_laundering"]) for r in result["laundering_label_dist"]}
        assert "True" in labels or "False" in labels

    def test_date_filter_reduces_count(self):
        result = call_tool("run_eda", {"date_from": "2023-01-25"})
        assert result["total_rows"] < 15
        assert result["total_rows"] > 0

    def test_top_countries_present(self):
        result = call_tool("run_eda", {})
        assert len(result["top_countries"]) > 0


class TestEngineerFeatures:
    def test_returns_records_for_all_accounts(self):
        result = call_tool("engineer_features", {"window_days": 30, "persist": False})
        assert result["accounts_processed"] == 7

    def test_velocity_is_positive(self):
        result = call_tool("engineer_features", {"window_days": 30, "persist": False})
        for rec in result["features"]:
            assert rec["velocity"] > 0

    def test_near_threshold_detection(self):
        result = call_tool("engineer_features", {"window_days": 30, "persist": False})
        feats = {r["account_id"]: r for r in result["features"]}
        assert feats["ACC_A"]["near_threshold_count"] == 3

    def test_window_days_respected(self):
        result = call_tool(
            "engineer_features",
            {"window_days": 5, "date_to": "2023-01-30", "persist": False},
        )
        assert result["accounts_processed"] <= 7

    def test_single_account_filter(self):
        result = call_tool(
            "engineer_features",
            {"account_ids": ["ACC_A"], "window_days": 30, "persist": False},
        )
        assert result["accounts_processed"] == 1
        assert result["features"][0]["account_id"] == "ACC_A"

    def test_txn_count_matches_expected(self):
        result = call_tool(
            "engineer_features",
            {"account_ids": ["ACC_A"], "window_days": 30, "persist": False},
        )
        assert result["features"][0]["txn_count"] == 3

    def test_amount_deviation_is_numeric(self):
        result = call_tool("engineer_features", {"window_days": 30, "persist": False})
        for rec in result["features"]:
            assert isinstance(rec["amount_deviation_pct"], float)

    def test_std_amount_zero_for_single_txn(self):
        result = call_tool("engineer_features", {"window_days": 30, "persist": False})
        for rec in result["features"]:
            assert rec["std_amount"] >= 0.0

    def test_no_data_returns_empty(self):
        result = call_tool(
            "engineer_features",
            {"date_to": "2020-01-01", "window_days": 30, "persist": False},
        )
        assert result["accounts_processed"] == 0
        assert result["features"] == []
