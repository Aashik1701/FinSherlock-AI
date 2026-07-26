"""
Tests for case management CRUD endpoints.

Uses FastAPI TestClient with the in-memory DuckDB fixture from conftest.py.
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


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _patch_db_for_api(mem_conn, monkeypatch):
    """Redirect get_connection() in main.py to the in-memory test DB."""
    monkeypatch.setattr(db_module, "get_connection", lambda **_: mem_conn)
    monkeypatch.setattr(main_mod, "_get_conn", lambda: mem_conn)
    # Clear cases table before each test (mem_conn is session-scoped)
    mem_conn.execute("DELETE FROM cases")


@pytest.fixture
def client():
    return TestClient(app)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestCreateCase:
    def test_create_case_returns_201(self, client):
        res = client.post("/cases", json={
            "account_id": "ACC_A",
            "query_text": "Test investigation",
            "risk_score": 0.75,
        })
        assert res.status_code == 201
        data = res.json()
        assert data["case_id"].startswith("CASE-")
        assert data["account_id"] == "ACC_A"
        assert data["status"] == "open"
        assert data["risk_score"] == 0.75

    def test_create_case_requires_account_id(self, client):
        res = client.post("/cases", json={"query_text": "no account"})
        assert res.status_code == 422

    def test_create_case_minimal(self, client):
        res = client.post("/cases", json={"account_id": "ACC_B"})
        assert res.status_code == 201
        data = res.json()
        assert data["account_id"] == "ACC_B"


class TestListCases:
    def test_list_empty(self, client):
        res = client.get("/cases")
        assert res.status_code == 200
        data = res.json()
        assert data["cases"] == []
        assert data["total"] == 0

    def test_list_with_cases(self, client):
        client.post("/cases", json={"account_id": "ACC_A"})
        client.post("/cases", json={"account_id": "ACC_B"})
        res = client.get("/cases")
        data = res.json()
        assert data["total"] == 2
        assert len(data["cases"]) == 2

    def test_filter_by_status(self, client):
        client.post("/cases", json={"account_id": "ACC_A"})
        res = client.get("/cases?status=open")
        data = res.json()
        assert all(c["status"] == "open" for c in data["cases"])

    def test_filter_by_account(self, client):
        client.post("/cases", json={"account_id": "ACC_A"})
        client.post("/cases", json={"account_id": "ACC_B"})
        res = client.get("/cases?account_id=ACC_A")
        data = res.json()
        assert data["total"] == 1
        assert data["cases"][0]["account_id"] == "ACC_A"

    def test_limit_offset(self, client):
        for i in range(5):
            client.post("/cases", json={"account_id": f"ACC_{i}"})
        res = client.get("/cases?limit=2&offset=0")
        data = res.json()
        assert len(data["cases"]) == 2
        assert data["total"] == 5


class TestGetCase:
    def test_get_existing(self, client):
        create_res = client.post("/cases", json={"account_id": "ACC_A"})
        case_id = create_res.json()["case_id"]
        res = client.get(f"/cases/{case_id}")
        assert res.status_code == 200
        assert res.json()["case_id"] == case_id

    def test_get_not_found(self, client):
        res = client.get("/cases/CASE-NONEXISTENT")
        assert res.status_code == 404


class TestUpdateCase:
    def _create(self, client):
        res = client.post("/cases", json={"account_id": "ACC_A"})
        return res.json()["case_id"]

    def test_transition_open_to_under_review(self, client):
        case_id = self._create(client)
        res = client.patch(f"/cases/{case_id}", json={"status": "under_review"})
        assert res.status_code == 200
        assert res.json()["status"] == "under_review"

    def test_transition_open_to_closed(self, client):
        case_id = self._create(client)
        res = client.patch(f"/cases/{case_id}", json={"status": "closed"})
        assert res.status_code == 200
        assert res.json()["status"] == "closed"

    def test_invalid_transition_open_to_escalated(self, client):
        case_id = self._create(client)
        res = client.patch(f"/cases/{case_id}", json={"status": "escalated"})
        assert res.status_code == 400
        assert "Cannot transition" in res.json()["detail"]

    def test_transition_under_review_to_escalated(self, client):
        case_id = self._create(client)
        client.patch(f"/cases/{case_id}", json={"status": "under_review"})
        res = client.patch(f"/cases/{case_id}", json={"status": "escalated"})
        assert res.status_code == 200
        assert res.json()["status"] == "escalated"

    def test_update_notes(self, client):
        case_id = self._create(client)
        res = client.patch(f"/cases/{case_id}", json={"notes": "New findings"})
        assert res.status_code == 200
        assert res.json()["notes"] == "New findings"

    def test_update_resolution(self, client):
        case_id = self._create(client)
        client.patch(f"/cases/{case_id}", json={"status": "closed"})
        res = client.patch(f"/cases/{case_id}", json={"resolution": "true_positive"})
        assert res.status_code == 200
        assert res.json()["resolution"] == "true_positive"

    def test_invalid_resolution(self, client):
        case_id = self._create(client)
        client.patch(f"/cases/{case_id}", json={"status": "closed"})
        res = client.patch(f"/cases/{case_id}", json={"resolution": "maybe"})
        assert res.status_code == 400

    def test_resolution_requires_closed_status(self, client):
        case_id = self._create(client)
        # Case is still 'open' — resolution must be rejected
        res = client.patch(f"/cases/{case_id}", json={"resolution": "true_positive"})
        assert res.status_code == 400
        assert "closed" in res.json()["detail"].lower()

    def test_update_not_found(self, client):
        res = client.patch("/cases/CASE-NONEXISTENT", json={"notes": "x"})
        assert res.status_code == 404


class TestDeleteCase:
    def test_delete_existing(self, client):
        create_res = client.post("/cases", json={"account_id": "ACC_A"})
        case_id = create_res.json()["case_id"]
        res = client.delete(f"/cases/{case_id}")
        assert res.status_code == 200
        assert res.json()["deleted"] == case_id
        res = client.get(f"/cases/{case_id}")
        assert res.status_code == 404

    def test_delete_not_found(self, client):
        res = client.delete("/cases/CASE-NONEXISTENT")
        assert res.status_code == 404
