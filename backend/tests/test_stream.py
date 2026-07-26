"""
Tests for the real-time stream simulation endpoints.

Tests cover status endpoint, guard checks, simulator state machine,
and event subscription. Lifecycle tests use direct simulator calls
to avoid asyncio event-loop mismatch with TestClient.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest
from fastapi.testclient import TestClient

import data.db as db_module
import main as main_mod
from stream_simulator import simulator, StreamSimulator, StreamStatus, StreamEvent
from main import app


@pytest.fixture(autouse=True)
def _patch_db_and_reset(mem_conn, monkeypatch):
    monkeypatch.setattr(db_module, "get_connection", lambda **_: mem_conn)
    monkeypatch.setattr(main_mod, "_get_conn", lambda: mem_conn)
    # Reset the simulator to idle (but do NOT delete from transactions —
    # the session-scoped mem_conn is shared by all test modules)
    simulator.status = StreamStatus()
    simulator._stop_event = asyncio.Event()
    simulator._pause_event = asyncio.Event()
    simulator._pause_event.set()
    simulator._subscribers.clear()
    simulator._task = None


@pytest.fixture
def client():
    return TestClient(app)


# ---------------------------------------------------------------------------
# Status endpoint
# ---------------------------------------------------------------------------

class TestStreamStatus:
    def test_status_returns_idle(self, client):
        res = client.get("/stream/status")
        assert res.status_code == 200
        data = res.json()
        assert data["running"] is False
        assert data["paused"] is False
        assert data["rows_inserted"] == 0

    def test_status_has_all_fields(self, client):
        data = client.get("/stream/status").json()
        for key in ["running", "paused", "speed", "rows_inserted", "total_rows",
                     "alerts_fired", "current_timestamp", "elapsed_real", "progress"]:
            assert key in data

    def test_default_speed_is_100(self, client):
        data = client.get("/stream/status").json()
        assert data["speed"] == 100.0


# ---------------------------------------------------------------------------
# Guard checks — endpoints return 409 when nothing is running
# ---------------------------------------------------------------------------

class TestStreamGuardChecks:
    def test_stop_when_not_running(self, client):
        assert client.post("/stream/stop").status_code == 409

    def test_pause_when_not_running(self, client):
        assert client.post("/stream/pause").status_code == 409

    def test_resume_when_not_running(self, client):
        assert client.post("/stream/resume").status_code == 409


# ---------------------------------------------------------------------------
# Simulator state machine (direct calls, no event-loop issues)
# ---------------------------------------------------------------------------

class TestSimulatorStateMachine:
    def test_speed_clamp_low(self):
        sim = StreamSimulator()
        sim.set_speed(0.01)
        assert sim.status.speed == 0.1

    def test_speed_clamp_high(self):
        sim = StreamSimulator()
        sim.set_speed(99999)
        assert sim.status.speed == 10000

    def test_speed_normal(self):
        sim = StreamSimulator()
        sim.set_speed(250)
        assert sim.status.speed == 250

    def test_status_to_dict(self):
        s = StreamStatus(running=True, speed=200, rows_inserted=50, total_rows=1000)
        d = s.to_dict()
        assert d["running"] is True
        assert d["speed"] == 200
        assert d["progress"] == 5.0
        assert d["rows_inserted"] == 50

    def test_status_progress_zero_total(self):
        s = StreamStatus(rows_inserted=0, total_rows=0)
        assert s.to_dict()["progress"] == 0.0


# ---------------------------------------------------------------------------
# Subscriber / broadcast
# ---------------------------------------------------------------------------

class TestSimulatorPubSub:
    def test_subscribe_creates_queue(self):
        sim = StreamSimulator()
        q = sim.subscribe()
        assert isinstance(q, asyncio.Queue)
        assert q in sim._subscribers
        sim.unsubscribe(q)
        assert q not in sim._subscribers

    def test_broadcast_sends_to_subscribers(self):
        sim = StreamSimulator()
        q = sim.subscribe()
        loop = asyncio.new_event_loop()
        loop.run_until_complete(sim._broadcast(StreamEvent("test", {"x": 1})))
        assert not q.empty()
        event = q.get_nowait()
        assert event.type == "test"
        assert event.data["x"] == 1
        sim.unsubscribe(q)
        loop.close()

    def test_broadcast_does_not_crash_on_full_queue(self):
        sim = StreamSimulator()
        q = sim.subscribe()
        q.put_nowait(StreamEvent("old", {}))
        q.put_nowait(StreamEvent("old", {}))
        q.put_nowait(StreamEvent("old", {}))
        # Queue is full-ish but broadcast should not raise
        loop = asyncio.new_event_loop()
        loop.run_until_complete(sim._broadcast(StreamEvent("new", {})))
        sim.unsubscribe(q)
        loop.close()


# ---------------------------------------------------------------------------
# SSE event stream format
# ---------------------------------------------------------------------------

class TestStreamEventsEndpoint:
    @pytest.mark.skip(reason="SSE heartbeat causes TestClient to hang — test in integration")
    def test_events_returns_200(self, client):
        pass

    @pytest.mark.skip(reason="SSE heartbeat causes TestClient to hang — test in integration")
    def test_events_content_type(self, client):
        pass

    @pytest.mark.skip(reason="SSE heartbeat causes TestClient to hang — test in integration")
    def test_events_first_line_is_data(self, client):
        pass


# ---------------------------------------------------------------------------
# Calc_sleep helper
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Alert deduplication
# ---------------------------------------------------------------------------

class TestAlertDeduplication:
    def test_no_duplicate_large_transaction_alert(self, mem_conn):
        sim = StreamSimulator()
        # Simulate account already having a $60k transaction in DB
        mem_conn.execute(
            "INSERT OR IGNORE INTO transactions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ["DEDUP-001", "2023-01-10 14:00:00", "ACC_X", "ACC_Y",
             60000.0, "USD", "wire", "US", "online", False],
        )
        # First check: alert should fire
        alerts1 = sim._check_alerts(mem_conn, {"ACC_X"})
        assert any(a["alert_type"] == "large_transaction" for a in alerts1)
        # Second check on same account: should NOT re-fire
        alerts2 = sim._check_alerts(mem_conn, {"ACC_X"})
        assert not any(a["alert_type"] == "large_transaction" for a in alerts2)
        mem_conn.execute("DELETE FROM transactions WHERE transaction_id = 'DEDUP-001'")

    def test_structuring_alert_fires_at_new_count(self, mem_conn):
        sim = StreamSimulator()
        # Insert 2 near-threshold transactions
        for i in range(2):
            mem_conn.execute(
                "INSERT OR IGNORE INTO transactions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [f"SDEDUP-00{i}", f"2023-01-0{i+1} 10:00:00", "ACC_Z", "ACC_W",
                 9800.0, "USD", "cash_deposit", "US", "branch", True],
            )
        alerts1 = sim._check_alerts(mem_conn, {"ACC_Z"})
        assert any(a["alert_type"] == "structuring" for a in alerts1)
        # Same count → no new alert
        alerts2 = sim._check_alerts(mem_conn, {"ACC_Z"})
        assert not any(a["alert_type"] == "structuring" for a in alerts2)
        mem_conn.execute("DELETE FROM transactions WHERE transaction_id LIKE 'SDEDUP-%'")


# ---------------------------------------------------------------------------
# Insert batch — unique txn_ids even for identical rows
# ---------------------------------------------------------------------------

class TestInsertBatch:
    def test_unique_txn_ids_for_identical_rows(self, mem_conn):
        sim = StreamSimulator()
        batch = [
            {"timestamp": "2023-01-01 00:00", "sender": "ACC_A", "receiver": "ACC_B",
             "amount": 100.0, "currency": "USD", "tx_type": "wire",
             "country": "US", "channel": "online", "is_laundering": False},
            {"timestamp": "2023-01-01 00:00", "sender": "ACC_A", "receiver": "ACC_B",
             "amount": 100.0, "currency": "USD", "tx_type": "wire",
             "country": "US", "channel": "online", "is_laundering": False},
        ]
        sim._insert_batch(mem_conn, batch)
        # Both rows should be inserted (unique IDs), not deduplicated
        rows = mem_conn.execute(
            "SELECT COUNT(*) FROM transactions WHERE transaction_id LIKE 'STR-%'"
        ).fetchone()[0]
        assert rows == 2
        mem_conn.execute("DELETE FROM transactions WHERE transaction_id LIKE 'STR-%'")


class TestCalcSleep:
    def test_same_timestamp(self):
        sim = StreamSimulator()
        row = {"timestamp": "2022/09/01 00:20"}
        assert sim._calc_sleep(row, row) == 0.05  # minimum

    def test_1_hour_gap_at_100x(self):
        sim = StreamSimulator()
        sim.status.speed = 100
        c = {"timestamp": "2022/09/01 00:00"}
        n = {"timestamp": "2022/09/01 01:00"}
        # 3600s / 100 = 36s → capped at 2.0
        assert sim._calc_sleep(c, n) == 2.0

    def test_1_minute_gap_at_100x(self):
        sim = StreamSimulator()
        sim.status.speed = 100
        c = {"timestamp": "2022/09/01 00:00"}
        n = {"timestamp": "2022/09/01 00:01"}
        # 60s / 100 = 0.6s
        assert abs(sim._calc_sleep(c, n) - 0.6) < 0.01

    def test_1_second_gap_at_1000x(self):
        sim = StreamSimulator()
        sim.status.speed = 1000
        c = {"timestamp": "2022/09/01 00:00:00"}
        n = {"timestamp": "2022/09/01 00:00:01"}
        # 1s / 1000 = 0.001 → clamped to 0.05
        assert sim._calc_sleep(c, n) == 0.05
