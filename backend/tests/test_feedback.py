"""
Tests for analyst feedback CRUD endpoints and stats.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest
from fastapi.testclient import TestClient

import data.db as db_module
import main as main_mod
from main import app


@pytest.fixture(autouse=True)
def _patch_db_for_api(mem_conn, monkeypatch):
    monkeypatch.setattr(db_module, "get_connection", lambda **_: mem_conn)
    monkeypatch.setattr(main_mod, "_get_conn", lambda: mem_conn)
    mem_conn.execute("DELETE FROM analyst_feedback")
    mem_conn.execute("DELETE FROM cases")


@pytest.fixture
def client():
    return TestClient(app)


# ---------------------------------------------------------------------------
# Feedback CRUD
# ---------------------------------------------------------------------------

class TestCreateFeedback:
    def test_create_tp(self, client):
        res = client.post("/feedback", json={
            "account_id": "ACC_A",
            "label": True,
            "risk_score": 0.75,
        })
        assert res.status_code == 201
        data = res.json()
        assert data["feedback_id"].startswith("FB-")
        assert data["account_id"] == "ACC_A"
        assert data["label"] is True
        assert data["risk_score"] == 0.75
        assert data["model_version"] == "v1"

    def test_create_fp(self, client):
        res = client.post("/feedback", json={
            "account_id": "ACC_B",
            "label": False,
            "risk_score": 0.32,
            "notes": "Not suspicious — legitimate business expense",
        })
        assert res.status_code == 201
        data = res.json()
        assert data["label"] is False
        assert data["notes"] == "Not suspicious — legitimate business expense"

    def test_create_with_case_link(self, client):
        # Create a case first
        case_res = client.post("/cases", json={"account_id": "ACC_A"})
        case_id = case_res.json()["case_id"]
        # Create feedback linked to that case
        res = client.post("/feedback", json={
            "account_id": "ACC_A",
            "case_id": case_id,
            "label": True,
        })
        assert res.status_code == 201
        assert res.json()["case_id"] == case_id
        # Verify the case was auto-resolved
        case = client.get(f"/cases/{case_id}").json()
        assert case["resolution"] == "true_positive"
        assert case["status"] == "closed"

    def test_create_fp_links_case(self, client):
        case_res = client.post("/cases", json={"account_id": "ACC_B"})
        case_id = case_res.json()["case_id"]
        res = client.post("/feedback", json={
            "account_id": "ACC_B",
            "case_id": case_id,
            "label": False,
        })
        assert res.status_code == 201
        case = client.get(f"/cases/{case_id}").json()
        assert case["resolution"] == "false_positive"
        assert case["status"] == "closed"

    def test_requires_account_id(self, client):
        res = client.post("/feedback", json={"label": True})
        assert res.status_code == 422


class TestListFeedback:
    def test_list_empty(self, client):
        res = client.get("/feedback")
        assert res.status_code == 200
        data = res.json()
        assert data["feedback"] == []
        assert data["total"] == 0

    def test_list_with_records(self, client):
        client.post("/feedback", json={"account_id": "ACC_A", "label": True})
        client.post("/feedback", json={"account_id": "ACC_B", "label": False})
        res = client.get("/feedback")
        data = res.json()
        assert data["total"] == 2

    def test_filter_by_account(self, client):
        client.post("/feedback", json={"account_id": "ACC_A", "label": True})
        client.post("/feedback", json={"account_id": "ACC_B", "label": False})
        res = client.get("/feedback?account_id=ACC_A")
        data = res.json()
        assert data["total"] == 1
        assert data["feedback"][0]["account_id"] == "ACC_A"

    def test_filter_by_label(self, client):
        client.post("/feedback", json={"account_id": "ACC_A", "label": True})
        client.post("/feedback", json={"account_id": "ACC_B", "label": False})
        res = client.get("/feedback?label=true")
        data = res.json()
        assert data["total"] == 1
        assert data["feedback"][0]["label"] is True


class TestFeedbackStats:
    def test_empty_stats(self, client):
        res = client.get("/feedback/stats")
        assert res.status_code == 200
        data = res.json()
        assert data["total"] == 0
        assert data["precision"] is None

    def test_stats_computed(self, client):
        client.post("/feedback", json={"account_id": "ACC_A", "label": True})
        client.post("/feedback", json={"account_id": "ACC_B", "label": True})
        client.post("/feedback", json={"account_id": "ACC_C", "label": False})
        res = client.get("/feedback/stats")
        data = res.json()
        assert data["total"] == 3
        assert data["true_positives"] == 2
        assert data["false_positives"] == 1
        assert abs(data["precision"] - 2 / 3) < 0.001
        assert data["model_version"] == "v1"
        assert data["latest_feedback"] is not None
