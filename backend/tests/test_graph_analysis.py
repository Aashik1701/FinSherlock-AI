"""
Tests for detect_smurfing and detect_layering.

Each test class uses its own in-memory DuckDB seeded with purpose-built data:
  - _SMURFING_TXNS  : SMURF fans out to 6 distinct receivers in a 30-min window.
                      No account has outgoing edges from those receivers, so the
                      maximum chain depth is 1 hop → detect_layering finds nothing.
  - _LAYERING_TXNS  : L1→L2→L3→L4 with 2-hour gaps (within the 24h default).
                      Each node has fan-out=1, so detect_smurfing finds nothing.

Cross-contamination invariants are asserted in each class.

No LLM, no API keys, no real dataset.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import duckdb
import pandas as pd
import pytest

import tools  # noqa: F401 — fires @tool decorators
from agent.registry import call_tool
from tools.risk_classifier import (
    SMURFING_DEGREE_HIGH,
    SMURFING_DEGREE_MEDIUM,
    SMURFING_POINTS_HIGH,
    LAYERING_HOPS_MEDIUM,
)


# =============================================================================
# Synthetic fixture data
# =============================================================================

_COLUMNS = [
    "transaction_id", "timestamp", "sender_account_id", "receiver_account_id",
    "amount", "currency", "transaction_type", "country", "channel", "is_laundering",
]

# One account fans out to 6 distinct receivers within 30 minutes.
# Receivers have NO outgoing edges → max layering depth = 1 hop < 3 (min_hops default).
_SMURFING_TXNS = [
    ("TS001", "2024-01-01 10:00:00", "SMURF", "SR1",   1_500, "USD", "transfer", "US", "online", True),
    ("TS002", "2024-01-01 10:05:00", "SMURF", "SR2",   1_500, "USD", "transfer", "US", "online", True),
    ("TS003", "2024-01-01 10:10:00", "SMURF", "SR3",   1_500, "USD", "transfer", "US", "online", True),
    ("TS004", "2024-01-01 10:15:00", "SMURF", "SR4",   1_500, "USD", "transfer", "US", "online", True),
    ("TS005", "2024-01-01 10:20:00", "SMURF", "SR5",   1_500, "USD", "transfer", "US", "online", True),
    ("TS006", "2024-01-01 10:25:00", "SMURF", "SR6",   1_500, "USD", "transfer", "US", "online", True),
    # CLEAN sends to only one receiver → fan-out = 1, below any threshold
    ("TS007", "2024-01-01 11:00:00", "CLEAN", "SR1",   5_000, "USD", "transfer", "US", "online", False),
]

# 3-edge chain with 2-hour time gaps (comfortably within the 24h default).
# Each node has fan-out = 1 → no account exceeds the smurfing threshold (default 3).
_LAYERING_TXNS = [
    ("TL001", "2024-01-01 08:00:00", "L1", "L2", 50_000, "USD", "wire", "DE", "online", True),
    ("TL002", "2024-01-01 10:00:00", "L2", "L3", 48_000, "USD", "wire", "FR", "online", True),
    ("TL003", "2024-01-01 12:00:00", "L3", "L4", 46_000, "USD", "wire", "CH", "online", True),
    # Unrelated transaction — no chain partner, no structuring pattern
    ("TL004", "2024-01-01 14:00:00", "NOISE", "OTHER", 5_000, "USD", "transfer", "US", "online", False),
]


# =============================================================================
# Helpers
# =============================================================================

def _make_conn(txns: list[tuple]) -> duckdb.DuckDBPyConnection:
    """Create an isolated in-memory DuckDB seeded with the provided rows."""
    conn = duckdb.connect(":memory:")
    conn.execute("""
        CREATE TABLE transactions (
            transaction_id      VARCHAR PRIMARY KEY,
            timestamp           TIMESTAMP,
            sender_account_id   VARCHAR,
            receiver_account_id VARCHAR,
            amount              DOUBLE,
            currency            VARCHAR,
            transaction_type    VARCHAR,
            country             VARCHAR,
            channel             VARCHAR,
            is_laundering       BOOLEAN
        )
    """)
    df = pd.DataFrame(txns, columns=_COLUMNS)
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    conn.execute("INSERT INTO transactions SELECT * FROM df")
    return conn


# =============================================================================
# detect_smurfing
# =============================================================================

class TestDetectSmurfing:
    """Smurfing DB: SMURF fans out to 6 accounts. CLEAN sends to 1."""

    @pytest.fixture(autouse=True)
    def _use_smurfing_db(self, monkeypatch):
        import tools.graph_analysis as ga_mod
        monkeypatch.setattr(ga_mod, "get_connection", lambda: _make_conn(_SMURFING_TXNS))

    # ── Detection ─────────────────────────────────────────────────────────────

    def test_flags_smurf_account(self):
        result = call_tool("detect_smurfing", {"fan_out_threshold": 3})
        ids = {fa["account_id"] for fa in result["flagged_accounts"]}
        assert "SMURF" in ids

    def test_smurf_fan_out_degree_is_six(self):
        result = call_tool("detect_smurfing", {"fan_out_threshold": 3})
        smurf = next(fa for fa in result["flagged_accounts"] if fa["account_id"] == "SMURF")
        assert smurf["fan_out_degree"] == 6

    def test_counterparties_list_contains_all_receivers(self):
        result = call_tool("detect_smurfing", {"fan_out_threshold": 3})
        smurf = next(fa for fa in result["flagged_accounts"] if fa["account_id"] == "SMURF")
        expected = {"SR1", "SR2", "SR3", "SR4", "SR5", "SR6"}
        assert set(smurf["counterparties_sent_to"]) == expected

    def test_total_sent_matches_six_transfers(self):
        result = call_tool("detect_smurfing", {"fan_out_threshold": 3})
        smurf = next(fa for fa in result["flagged_accounts"] if fa["account_id"] == "SMURF")
        assert abs(smurf["total_sent"] - 9_000.0) < 0.01

    def test_clean_account_not_flagged(self):
        result = call_tool("detect_smurfing", {"fan_out_threshold": 3})
        ids = {fa["account_id"] for fa in result["flagged_accounts"]}
        assert "CLEAN" not in ids

    def test_raising_threshold_suppresses_smurf(self):
        # Threshold above the fan-out degree → SMURF not flagged
        result = call_tool("detect_smurfing", {"fan_out_threshold": 7})
        assert result["total_flagged"] == 0

    def test_account_filter_restricts_to_smurf(self):
        result = call_tool("detect_smurfing", {"account_ids": ["SMURF"], "fan_out_threshold": 3})
        assert all(fa["account_id"] == "SMURF" for fa in result["flagged_accounts"])

    def test_total_flagged_matches_list_length(self):
        result = call_tool("detect_smurfing", {"fan_out_threshold": 3})
        assert result["total_flagged"] == len(result["flagged_accounts"])

    def test_output_has_threshold_fields(self):
        result = call_tool("detect_smurfing", {})
        assert "fan_out_threshold" in result
        assert "fan_in_threshold"  in result
        assert "window_days"       in result

    def test_empty_window_returns_no_flags(self):
        result = call_tool("detect_smurfing", {"date_to": "2020-01-01"})
        assert result["total_flagged"] == 0

    # ── Cross-contamination: smurfing fixture should NOT trigger detect_layering ──

    def test_smurfing_fixture_does_not_trigger_detect_layering(self):
        """
        SMURF fans out to dead-end nodes.  Max chain from any node is 1 hop,
        which is below the default min_hops=3.
        """
        result = call_tool("detect_layering", {"min_hops": 3})
        assert result["total_paths"] == 0, (
            f"Expected 0 layering paths on smurfing data, got {result['total_paths']}: "
            f"{result['detected_paths']}"
        )


# =============================================================================
# detect_layering
# =============================================================================

class TestDetectLayering:
    """Layering DB: L1→L2→L3→L4 with 2h gaps. No account has fan-out > 1."""

    @pytest.fixture(autouse=True)
    def _use_layering_db(self, monkeypatch):
        import tools.graph_analysis as ga_mod
        monkeypatch.setattr(ga_mod, "get_connection", lambda: _make_conn(_LAYERING_TXNS))

    # ── Detection ─────────────────────────────────────────────────────────────

    def test_detects_three_hop_chain(self):
        result = call_tool("detect_layering", {"min_hops": 3, "max_gap_hours": 24})
        assert result["total_paths"] >= 1

    def test_path_contains_all_four_accounts(self):
        result = call_tool("detect_layering", {"min_hops": 3, "max_gap_hours": 24})
        found_paths = [p["path"] for p in result["detected_paths"]]
        # The canonical path L1→L2→L3→L4 must appear
        assert ["L1", "L2", "L3", "L4"] in found_paths

    def test_path_contains_transaction_ids(self):
        result = call_tool("detect_layering", {"min_hops": 3, "max_gap_hours": 24})
        for path in result["detected_paths"]:
            assert len(path["transaction_ids"]) > 0
            assert len(path["transaction_ids"]) == path["hop_count"]

    def test_hop_count_is_three(self):
        result = call_tool("detect_layering", {"min_hops": 3, "max_gap_hours": 24})
        # The canonical chain has exactly 3 edges
        canonical = next(
            p for p in result["detected_paths"] if p["path"] == ["L1", "L2", "L3", "L4"]
        )
        assert canonical["hop_count"] == 3

    def test_total_amount_is_positive(self):
        result = call_tool("detect_layering", {"min_hops": 3, "max_gap_hours": 24})
        for path in result["detected_paths"]:
            assert path["total_amount"] > 0

    def test_noise_accounts_not_in_canonical_chain(self):
        result = call_tool("detect_layering", {"min_hops": 3, "max_gap_hours": 24})
        canonical_paths = [p["path"] for p in result["detected_paths"]]
        for path in canonical_paths:
            assert "NOISE" not in path
            assert "OTHER" not in path

    def test_min_hops_filter_suppresses_chain(self):
        # The chain has 3 edges; requiring 4 should find nothing
        result = call_tool("detect_layering", {"min_hops": 4, "max_gap_hours": 24})
        assert result["total_paths"] == 0, (
            f"Expected 0 paths with min_hops=4 on a 3-edge chain, got {result['total_paths']}"
        )

    def test_tight_gap_filter_suppresses_chain(self):
        # The chain has 2h gaps; requiring max_gap_hours=1 should find nothing
        result = call_tool("detect_layering", {"min_hops": 3, "max_gap_hours": 1.0})
        assert result["total_paths"] == 0, (
            f"Expected 0 paths with max_gap_hours=1 on a 2h-gap chain, got {result['total_paths']}"
        )

    def test_output_has_config_fields(self):
        result = call_tool("detect_layering", {})
        assert "min_hops"      in result
        assert "max_gap_hours" in result
        assert "window_days"   in result

    def test_empty_window_returns_no_paths(self):
        result = call_tool("detect_layering", {"date_to": "2020-01-01"})
        assert result["total_paths"] == 0

    def test_account_ids_filter_restricts_origin(self):
        # Starting from L2 with min_hops=2 should find L2→L3→L4 (2 edges ≥ 2)
        result = call_tool("detect_layering", {"account_ids": ["L2"], "min_hops": 2})
        for path in result["detected_paths"]:
            assert path["path"][0] == "L2", "Non-L2 origin returned despite account_ids filter"

    def test_origin_account_field_is_first_node(self):
        result = call_tool("detect_layering", {"min_hops": 3})
        for path in result["detected_paths"]:
            assert path["origin_account"] == path["path"][0]

    # ── Cross-contamination: layering fixture should NOT trigger detect_smurfing ──

    def test_layering_fixture_does_not_trigger_detect_smurfing(self):
        """
        Each account in the layering fixture sends to at most one distinct receiver.
        Default fan_out_threshold=3 → no account should be flagged.
        """
        result = call_tool("detect_smurfing", {"fan_out_threshold": 3})
        assert result["total_flagged"] == 0, (
            f"Expected 0 smurfing flags on layering data, got {result['total_flagged']}: "
            f"{result['flagged_accounts']}"
        )


# =============================================================================
# classify_risk integration with smurfing / layering outputs
# =============================================================================

class TestClassifyRiskWithGraphSignals:

    def test_smurfing_high_degree_gives_high_risk(self):
        smurfing_out = {
            "window_days": 30,
            "fan_out_threshold": 3,
            "fan_in_threshold": 3,
            "flagged_accounts": [
                {
                    "account_id":                   "SMURF",
                    "fan_out_degree":               SMURFING_DEGREE_HIGH,
                    "fan_in_degree":                0,
                    "counterparties_sent_to":       [f"R{i}" for i in range(SMURFING_DEGREE_HIGH)],
                    "counterparties_received_from": [],
                    "total_sent":                   9_000.0,
                    "total_received":               0.0,
                }
            ],
            "total_flagged": 1,
        }
        result = call_tool("classify_risk", {"smurfing_output": smurfing_out})
        clf = next(c for c in result["classifications"] if c["account_id"] == "SMURF")
        assert clf["risk_level"] == "high"
        assert clf["risk_score"] >= SMURFING_POINTS_HIGH

    def test_smurfing_medium_degree_gives_medium_risk(self):
        smurfing_out = {
            "window_days": 30,
            "fan_out_threshold": 3,
            "fan_in_threshold": 3,
            "flagged_accounts": [
                {
                    "account_id":                   "SMURF",
                    "fan_out_degree":               SMURFING_DEGREE_MEDIUM,
                    "fan_in_degree":                0,
                    "counterparties_sent_to":       [f"R{i}" for i in range(SMURFING_DEGREE_MEDIUM)],
                    "counterparties_received_from": [],
                    "total_sent":                   4_500.0,
                    "total_received":               0.0,
                }
            ],
            "total_flagged": 1,
        }
        result = call_tool("classify_risk", {"smurfing_output": smurfing_out})
        clf = next(c for c in result["classifications"] if c["account_id"] == "SMURF")
        assert clf["risk_level"] == "medium"

    def test_layering_medium_hops_gives_medium_risk(self):
        layering_out = {
            "window_days": 30,
            "min_hops": 3,
            "max_gap_hours": 24.0,
            "detected_paths": [
                {
                    "path":            ["L1", "L2", "L3", "L4"],
                    "transaction_ids": ["TL001", "TL002", "TL003"],
                    "hop_count":       LAYERING_HOPS_MEDIUM,
                    "total_amount":    50_000.0,
                    "time_span_hours": 4.0,
                    "origin_account":  "L1",
                }
            ],
            "total_paths": 1,
        }
        result = call_tool("classify_risk", {"layering_output": layering_out})
        clf = next(c for c in result["classifications"] if c["account_id"] == "L1")
        assert clf["risk_level"] == "medium"

    def test_layering_contributing_signals_contain_path_label(self):
        layering_out = {
            "window_days": 30,
            "min_hops": 3,
            "max_gap_hours": 24.0,
            "detected_paths": [
                {
                    "path":            ["L1", "L2", "L3", "L4"],
                    "transaction_ids": ["TL001", "TL002", "TL003"],
                    "hop_count":       3,
                    "total_amount":    50_000.0,
                    "time_span_hours": 4.0,
                    "origin_account":  "L1",
                }
            ],
            "total_paths": 1,
        }
        result = call_tool("classify_risk", {"layering_output": layering_out})
        clf = next(c for c in result["classifications"] if c["account_id"] == "L1")
        signal_names = {s["signal"] for s in clf["contributing_signals"]}
        assert "layering_path_length" in signal_names

    def test_smurfing_contributing_signals_contain_fan_signal(self):
        smurfing_out = {
            "window_days": 30,
            "fan_out_threshold": 3,
            "fan_in_threshold": 3,
            "flagged_accounts": [
                {
                    "account_id":                   "SMURF",
                    "fan_out_degree":               6,
                    "fan_in_degree":                0,
                    "counterparties_sent_to":       [f"R{i}" for i in range(6)],
                    "counterparties_received_from": [],
                    "total_sent":                   9_000.0,
                    "total_received":               0.0,
                }
            ],
            "total_flagged": 1,
        }
        result = call_tool("classify_risk", {"smurfing_output": smurfing_out})
        clf = next(c for c in result["classifications"] if c["account_id"] == "SMURF")
        signal_names = {s["signal"] for s in clf["contributing_signals"]}
        assert "smurfing_fan_out" in signal_names
