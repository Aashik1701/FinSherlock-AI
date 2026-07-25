"""
Shared pytest fixtures for all FinSherlock test modules.

Provides:
  mem_conn  — session-scoped in-memory DuckDB seeded with synthetic AML data
  patch_db  — autouse function-scoped fixture that redirects every
              get_connection() call in tool modules to mem_conn
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import duckdb
import pandas as pd
import pytest

import data.db as db_module

# ---------------------------------------------------------------------------
# Synthetic dataset (15 rows covering all three AML typologies)
# ---------------------------------------------------------------------------

_SYNTHETIC_TRANSACTIONS = [
    # (txn_id, timestamp, sender, receiver, amount, currency, type, country, channel, is_laundering)
    ("T0001", "2023-01-05 10:00:00", "ACC_A", "ACC_B",  9_700.00, "USD", "cash_deposit", "US", "branch",  True),
    ("T0002", "2023-01-06 11:00:00", "ACC_A", "ACC_C",  9_850.00, "USD", "cash_deposit", "US", "branch",  True),
    ("T0003", "2023-01-07 09:30:00", "ACC_A", "ACC_D",  9_900.00, "USD", "cash_deposit", "US", "branch",  True),
    ("T0004", "2023-01-10 14:00:00", "ACC_B", "ACC_E", 50_000.00, "USD", "wire",         "DE", "online", False),
    ("T0005", "2023-01-12 08:00:00", "ACC_B", "ACC_F",  1_500.00, "USD", "transfer",     "DE", "online", False),
    ("T0006", "2023-01-15 16:00:00", "ACC_C", "ACC_G",    750.00, "USD", "withdrawal",   "FR", "atm",    False),
    ("T0007", "2023-01-18 12:00:00", "ACC_C", "ACC_H",  9_500.00, "USD", "cash_deposit", "FR", "branch",  True),
    ("T0008", "2023-01-20 09:00:00", "ACC_D", "ACC_I", 25_000.00, "USD", "wire",         "GB", "online", False),
    ("T0009", "2023-01-22 15:00:00", "ACC_D", "ACC_J",  3_200.00, "EUR", "transfer",     "GB", "mobile", False),
    ("T0010", "2023-01-25 10:30:00", "ACC_E", "ACC_A",  9_600.00, "USD", "cash_deposit", "US", "branch",  True),
    ("T0011", "2023-01-26 11:00:00", "ACC_E", "ACC_B",  9_750.00, "USD", "cash_deposit", "US", "branch",  True),
    ("T0012", "2023-01-27 13:00:00", "ACC_F", "ACC_C",    400.00, "USD", "withdrawal",   "DE", "atm",    False),
    ("T0013", "2023-01-28 09:45:00", "ACC_F", "ACC_D",  9_800.00, "USD", "cash_deposit", "DE", "branch",  True),
    ("T0014", "2023-01-29 14:00:00", "ACC_G", "ACC_E",  5_000.00, "USD", "transfer",     "FR", "online", False),
    ("T0015", "2023-01-30 17:00:00", "ACC_G", "ACC_F", 15_000.00, "USD", "wire",         "FR", "online", False),
]

_COLUMNS = [
    "transaction_id", "timestamp", "sender_account_id", "receiver_account_id",
    "amount", "currency", "transaction_type", "country", "channel", "is_laundering",
]


@pytest.fixture(scope="session")
def mem_conn():
    """In-memory DuckDB seeded with 15 synthetic transactions, shared for the whole session."""
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
    conn.execute("""
        CREATE TABLE accounts (
            account_id VARCHAR PRIMARY KEY,
            customer_id VARCHAR,
            account_open_date DATE,
            segment VARCHAR,
            country VARCHAR,
            historical_avg_transaction_amount DOUBLE
        )
    """)
    conn.execute("""
        CREATE TABLE account_features (
            account_id VARCHAR,
            window_days INTEGER,
            computed_at TIMESTAMP,
            txn_count INTEGER,
            total_volume DOUBLE,
            avg_amount DOUBLE,
            std_amount DOUBLE,
            velocity DOUBLE,
            max_single_amount DOUBLE,
            amount_deviation_pct DOUBLE,
            near_threshold_count INTEGER,
            PRIMARY KEY (account_id, window_days, computed_at)
        )
    """)
    df = pd.DataFrame(_SYNTHETIC_TRANSACTIONS, columns=_COLUMNS)
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    conn.execute("INSERT INTO transactions SELECT * FROM df")
    return conn


@pytest.fixture(autouse=True)
def patch_db(mem_conn, monkeypatch):
    """Redirect every get_connection() call in tool modules to mem_conn."""
    monkeypatch.setattr(db_module, "get_connection", lambda **_: mem_conn)

    import tools.eda as eda_mod
    import tools.feature_engineering as fe_mod
    import tools.anomaly_detection as ad_mod
    import tools.graph_analysis as ga_mod

    monkeypatch.setattr(eda_mod, "get_connection", lambda: mem_conn)
    monkeypatch.setattr(fe_mod,  "get_connection", lambda: mem_conn)
    monkeypatch.setattr(ad_mod,  "get_connection", lambda: mem_conn)
    monkeypatch.setattr(ga_mod,  "get_connection", lambda: mem_conn)
