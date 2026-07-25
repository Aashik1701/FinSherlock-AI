"""DuckDB connection helper and CSV loader for the IBM AML dataset."""

import logging
from pathlib import Path
from typing import Optional

import duckdb
import pandas as pd

logger = logging.getLogger(__name__)

# Paths
_ROOT = Path(__file__).parent          # backend/data/
_DB_PATH = _ROOT / "finsherlock.duckdb"
_SCHEMA_PATH = _ROOT / "schema.sql"
_RAW_DIR = _ROOT / "raw"

# ---------------------------------------------------------------------------
# Connection
# ---------------------------------------------------------------------------

def get_connection(db_path: Path = _DB_PATH) -> duckdb.DuckDBPyConnection:
    """Return a DuckDB connection, creating + initialising the DB if needed."""
    conn = duckdb.connect(str(db_path))
    _ensure_schema(conn)
    return conn


def _ensure_schema(conn: duckdb.DuckDBPyConnection) -> None:
    schema_sql = _SCHEMA_PATH.read_text()
    conn.execute(schema_sql)


# ---------------------------------------------------------------------------
# IBM AML column mapping
# ---------------------------------------------------------------------------

# Canonical column names we use internally → possible source-column names in
# the IBM AML Kaggle CSV (ealtman2019/ibm-transactions-for-anti-money-laundering-aml).
# The loader prints what it actually maps so you can verify against your file.
_IBM_AML_CANDIDATES: dict[str, list[str]] = {
    # HI-Small has no transaction_id column — synthesised below when absent
    "transaction_id":      ["TRANSACTION_ID", "transaction_id", "id", "Index"],
    "timestamp":           ["TIMESTAMP", "timestamp", "Date", "Timestamp"],
    # HI-Small: sender = first "Account" col (pandas keeps it as "Account")
    "sender_account_id":   ["FROM_ACCOUNT", "from_account", "From Account", "Sender", "Account"],
    # HI-Small: receiver = second "Account" col (pandas renames duplicate to "Account.1")
    "receiver_account_id": ["TO_ACCOUNT", "to_account", "To Account", "Receiver", "Account.1"],
    # HI-Small uses "Amount Received" or "Amount Paid"
    "amount":              ["AMOUNT", "amount", "Amount", "USD_AMOUNT", "Amount Received", "Amount Paid"],
    # HI-Small: "Receiving Currency" or "Payment Currency"
    "currency":            ["CURRENCY", "currency", "Currency", "Receiving Currency", "Payment Currency"],
    "transaction_type":    ["TRANSACTION_TYPE", "transaction_type", "Type", "Payment Type"],
    "country":             ["FROM_COUNTRY", "from_country", "Country", "From Bank Country"],
    # HI-Small: "Payment Format" maps to channel
    "channel":             ["CHANNEL", "channel", "Channel", "Payment Format"],
    # HI-Small: "Is Laundering" (with space) — matched via case-insensitive check
    "is_laundering":       ["IS_LAUNDERING", "is_laundering", "Laundering", "Label", "Is Laundering"],
}

# Columns we can tolerate being absent (will be filled with NULL / default).
# transaction_id is synthesised when absent, so it is also optional here.
_OPTIONAL_COLS = {"transaction_id", "currency", "transaction_type", "country", "channel", "is_laundering"}


def _resolve_column_mapping(df_cols: list[str]) -> dict[str, Optional[str]]:
    """
    For each canonical column, find the first matching source column.
    Returns {canonical_name: source_column_or_None}.
    """
    df_cols_lower = {c.lower().strip(): c for c in df_cols}
    mapping: dict[str, Optional[str]] = {}
    for canonical, candidates in _IBM_AML_CANDIDATES.items():
        matched = None
        for cand in candidates:
            if cand in df_cols:                         # exact match
                matched = cand
                break
            if cand.lower().strip() in df_cols_lower:   # case-insensitive
                matched = df_cols_lower[cand.lower().strip()]
                break
        mapping[canonical] = matched
    return mapping


def load_transactions_csv(
    csv_path: Path = _RAW_DIR / "transactions.csv",
    db_path: Path = _DB_PATH,
    chunksize: int = 200_000,
    limit: Optional[int] = None,
) -> dict:
    """
    Ingest a CSV into DuckDB transactions table.

    Returns a summary dict with:
      - column_mapping: what source col each canonical col resolved to
      - rows_loaded: total rows inserted
      - warnings: list of missing optional columns
    """
    if not csv_path.exists():
        raise FileNotFoundError(
            f"Dataset not found at {csv_path}. "
            "Place the IBM AML CSV at backend/data/raw/transactions.csv"
        )

    logger.info("Reading CSV headers from %s …", csv_path)
    header_df = pd.read_csv(csv_path, nrows=0)
    col_mapping = _resolve_column_mapping(list(header_df.columns))

    # Validate required columns are present
    missing_required = [
        c for c, src in col_mapping.items()
        if src is None and c not in _OPTIONAL_COLS
    ]
    if missing_required:
        raise ValueError(
            f"Required columns could not be mapped: {missing_required}\n"
            f"Source columns found: {list(header_df.columns)}"
        )

    warnings = [
        f"Optional column '{c}' not found — will default to NULL"
        for c, src in col_mapping.items()
        if src is None and c in _OPTIONAL_COLS
    ]

    # Pretty-print the mapping for the developer to sanity-check
    print("\n=== Column mapping (source CSV → internal schema) ===")
    for canonical, source in col_mapping.items():
        status = "✓" if source else ("? (optional)" if canonical in _OPTIONAL_COLS else "✗ MISSING")
        print(f"  {canonical:<30} ← {source or '—':30} {status}")
    print()

    conn = get_connection(db_path)
    rows_loaded = 0

    reader = pd.read_csv(csv_path, chunksize=chunksize, low_memory=False)
    for chunk in reader:
        if limit and rows_loaded >= limit:
            break
        if limit:
            chunk = chunk.iloc[: limit - rows_loaded]

        # Build a normalised DataFrame with canonical column names only
        normalised = pd.DataFrame()
        for canonical, source in col_mapping.items():
            if source and source in chunk.columns:
                normalised[canonical] = chunk[source]
            else:
                normalised[canonical] = None

        # Type coercions
        if normalised["timestamp"].notna().any():
            normalised["timestamp"] = pd.to_datetime(normalised["timestamp"], errors="coerce")
        normalised["amount"] = pd.to_numeric(normalised["amount"], errors="coerce")
        normalised["is_laundering"] = normalised["is_laundering"].astype("boolean")

        # Synthesise a transaction_id if the source didn't provide one
        if col_mapping["transaction_id"] is None:
            normalised["transaction_id"] = [
                f"TXN{rows_loaded + i:010d}" for i in range(len(normalised))
            ]

        conn.execute("INSERT OR IGNORE INTO transactions SELECT * FROM normalised")
        rows_loaded += len(normalised)
        logger.info("  Loaded %d rows (total so far: %d)", len(normalised), rows_loaded)

    conn.commit()
    logger.info("Load complete. Total rows: %d", rows_loaded)

    return {
        "column_mapping": col_mapping,
        "rows_loaded": rows_loaded,
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# Convenience helpers
# ---------------------------------------------------------------------------

def row_count(table: str = "transactions", db_path: Path = _DB_PATH) -> int:
    conn = get_connection(db_path)
    return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
