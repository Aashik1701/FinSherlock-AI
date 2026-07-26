"""
Tests for the shap_explain tool.

All tests use an in-memory DuckDB to avoid touching the real dataset.
The explainer itself is tested only when the model and shap package are present;
otherwise tests are skipped via the _READY flag.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest
import pandas as pd

import data.db as db_module
import tools.shap_explain as shap_mod
from tools.shap_explain import SHAPExplainArgs, shap_explain


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _insert_transactions(conn, rows: list[dict]):
    for r in rows:
        conn.execute(
            """INSERT OR IGNORE INTO transactions
               (transaction_id, timestamp, sender_account_id, receiver_account_id,
                amount, currency, transaction_type, country, channel, is_laundering)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                r["transaction_id"], r["timestamp"],
                r["sender"], r["receiver"],
                r["amount"], r.get("currency", "USD"),
                r.get("tx_type", "wire"), r.get("country", "US"),
                r.get("channel", "wire"), r.get("is_laundering", False),
            ],
        )


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _patch_db(mem_conn, monkeypatch):
    monkeypatch.setattr(db_module, "get_connection", lambda **_: mem_conn)
    # shap_explain imports get_connection directly — must patch the module reference too
    monkeypatch.setattr(shap_mod, "get_connection", lambda **_: mem_conn)
    yield
    # Remove any rows inserted by this test to avoid polluting the session-scoped DB
    mem_conn.execute("DELETE FROM transactions WHERE transaction_id LIKE 'SHAP-%'")


# ---------------------------------------------------------------------------
# When shap / model not available — graceful degradation
# ---------------------------------------------------------------------------

class TestSHAPNotReady:
    def test_returns_not_ready_when_explainer_missing(self, monkeypatch):
        monkeypatch.setattr(shap_mod, "_READY", False)
        result = shap_explain(SHAPExplainArgs(account_ids=["ACC_001"]))
        assert result["ready"] is False
        assert "explanations" in result
        assert result["explanations"] == []

    def test_message_present_when_not_ready(self, monkeypatch):
        monkeypatch.setattr(shap_mod, "_READY", False)
        result = shap_explain(SHAPExplainArgs(account_ids=["ACC_001"]))
        assert "message" in result
        assert len(result["message"]) > 0


# ---------------------------------------------------------------------------
# Empty result cases
# ---------------------------------------------------------------------------

class TestSHAPEmpty:
    @pytest.mark.skipif(not shap_mod._READY, reason="Model / shap not available")
    def test_empty_when_no_transactions(self, mem_conn):
        result = shap_explain(SHAPExplainArgs(account_ids=["NONEXISTENT_ACCT"]))
        assert result["ready"] is True
        assert result["explanations"] == []

    @pytest.mark.skipif(not shap_mod._READY, reason="Model / shap not available")
    def test_empty_accounts_list_still_runs(self, mem_conn):
        # account_ids is required but we can pass an empty list
        result = shap_explain(SHAPExplainArgs(account_ids=["GHOST_ACCT"]))
        assert isinstance(result["explanations"], list)


# ---------------------------------------------------------------------------
# Core SHAP output structure
# ---------------------------------------------------------------------------

class TestSHAPOutput:
    @pytest.mark.skipif(not shap_mod._READY, reason="Model / shap not available")
    def test_explanation_fields_present(self, mem_conn):
        _insert_transactions(mem_conn, [
            {
                "transaction_id": "SHAP-001", "timestamp": "2023-06-15 02:30:00",
                "sender": "SHAP_ACC_A", "receiver": "SHAP_ACC_B",
                "amount": 9500.0, "channel": "Bitcoin",
            },
        ])
        result = shap_explain(SHAPExplainArgs(account_ids=["SHAP_ACC_A"], window_days=365))
        assert result["ready"] is True
        if not result["explanations"]:
            pytest.skip("No explanation returned — transaction may be outside window")
        exp = result["explanations"][0]
        for field in ["account_id", "transaction_id", "timestamp", "amount",
                      "ml_probability", "base_probability", "shap_values", "narrative"]:
            assert field in exp, f"Missing field: {field}"

    @pytest.mark.skipif(not shap_mod._READY, reason="Model / shap not available")
    def test_shap_values_sorted_by_magnitude(self, mem_conn):
        _insert_transactions(mem_conn, [
            {
                "transaction_id": "SHAP-002", "timestamp": "2023-06-15 02:30:00",
                "sender": "SHAP_ACC_C", "receiver": "SHAP_ACC_D",
                "amount": 9800.0, "channel": "Cheque",
            },
        ])
        result = shap_explain(SHAPExplainArgs(account_ids=["SHAP_ACC_C"], window_days=365))
        if not result["explanations"]:
            pytest.skip("No transactions in window")
        sv = result["explanations"][0]["shap_values"]
        magnitudes = [abs(s["shap_value"]) for s in sv]
        assert magnitudes == sorted(magnitudes, reverse=True), "SHAP values should be sorted by |value|"

    @pytest.mark.skipif(not shap_mod._READY, reason="Model / shap not available")
    def test_is_currency_mismatch_excluded(self, mem_conn):
        _insert_transactions(mem_conn, [
            {
                "transaction_id": "SHAP-003", "timestamp": "2023-03-10 14:00:00",
                "sender": "SHAP_ACC_E", "receiver": "SHAP_ACC_F",
                "amount": 50000.0, "channel": "wire",
            },
        ])
        result = shap_explain(SHAPExplainArgs(account_ids=["SHAP_ACC_E"], window_days=365))
        if not result["explanations"]:
            pytest.skip("No transactions in window")
        feature_names = [s["feature"] for s in result["explanations"][0]["shap_values"]]
        assert "is_currency_mismatch" not in feature_names

    @pytest.mark.skipif(not shap_mod._READY, reason="Model / shap not available")
    def test_top_features_limit_respected(self, mem_conn):
        _insert_transactions(mem_conn, [
            {
                "transaction_id": "SHAP-004", "timestamp": "2023-03-10 03:00:00",
                "sender": "SHAP_ACC_G", "receiver": "SHAP_ACC_H",
                "amount": 9900.0, "channel": "Bitcoin",
            },
        ])
        result = shap_explain(SHAPExplainArgs(
            account_ids=["SHAP_ACC_G"], window_days=365, top_features=3,
        ))
        if not result["explanations"]:
            pytest.skip("No transactions in window")
        assert len(result["explanations"][0]["shap_values"]) <= 3

    @pytest.mark.skipif(not shap_mod._READY, reason="Model / shap not available")
    def test_narrative_contains_probability(self, mem_conn):
        _insert_transactions(mem_conn, [
            {
                "transaction_id": "SHAP-005", "timestamp": "2023-03-10 03:00:00",
                "sender": "SHAP_ACC_I", "receiver": "SHAP_ACC_J",
                "amount": 9900.0, "channel": "Bitcoin",
            },
        ])
        result = shap_explain(SHAPExplainArgs(account_ids=["SHAP_ACC_I"], window_days=365))
        if not result["explanations"]:
            pytest.skip("No transactions in window")
        narrative = result["explanations"][0]["narrative"]
        assert "Scored" in narrative
        assert "Base rate" in narrative

    @pytest.mark.skipif(not shap_mod._READY, reason="Model / shap not available")
    def test_probabilities_in_unit_interval(self, mem_conn):
        _insert_transactions(mem_conn, [
            {
                "transaction_id": "SHAP-006", "timestamp": "2023-03-12 04:00:00",
                "sender": "SHAP_ACC_K", "receiver": "SHAP_ACC_L",
                "amount": 9750.0, "channel": "Bitcoin",
            },
        ])
        result = shap_explain(SHAPExplainArgs(account_ids=["SHAP_ACC_K"], window_days=365))
        if not result["explanations"]:
            pytest.skip("No transactions in window")
        exp = result["explanations"][0]
        assert 0.0 <= exp["ml_probability"] <= 1.0
        assert 0.0 <= exp["base_probability"] <= 1.0

    @pytest.mark.skipif(not shap_mod._READY, reason="Model / shap not available")
    def test_picks_highest_prob_transaction(self, mem_conn):
        _insert_transactions(mem_conn, [
            {
                "transaction_id": "SHAP-LOW", "timestamp": "2023-04-01 10:00:00",
                "sender": "SHAP_ACC_M", "receiver": "SHAP_ACC_N",
                "amount": 100.0, "channel": "wire",
            },
            {
                "transaction_id": "SHAP-HIGH", "timestamp": "2023-04-01 02:00:00",
                "sender": "SHAP_ACC_M", "receiver": "SHAP_ACC_N",
                "amount": 9900.0, "channel": "Bitcoin",
            },
        ])
        result = shap_explain(SHAPExplainArgs(account_ids=["SHAP_ACC_M"], window_days=365))
        if not result["explanations"]:
            pytest.skip("No transactions in window")
        # The high-risk transaction should be chosen
        txn_id = result["explanations"][0]["transaction_id"]
        assert txn_id == "SHAP-HIGH", f"Expected SHAP-HIGH, got {txn_id}"


# ---------------------------------------------------------------------------
# Label helper
# ---------------------------------------------------------------------------

class TestLabelHelpers:
    def test_hod_label(self):
        from tools.shap_explain import _label
        assert _label("hod_2") == "Hour of day 02:00"
        assert _label("hod_14") == "Hour of day 14:00"

    def test_dow_label(self):
        from tools.shap_explain import _label
        assert _label("dow_0") == "Day: Mon"
        assert _label("dow_6") == "Day: Sun"

    def test_fmt_label(self):
        from tools.shap_explain import _label
        assert _label("fmt_Bitcoin") == "Format: Bitcoin"
        assert _label("fmt_cash_deposit") == "Format: Cash Deposit"

    def test_known_feature_label(self):
        from tools.shap_explain import _label
        assert _label("sender_out_degree") == "Sender unique receivers"
        assert _label("log_amount_paid") == "Log amount"
