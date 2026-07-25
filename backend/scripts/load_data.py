#!/usr/bin/env python3
"""
One-shot CSV → DuckDB loader.

Run from the backend/ directory:
    python scripts/load_data.py
    python scripts/load_data.py --limit 50000   # quick load for testing
    python scripts/load_data.py --csv path/to/other.csv
"""

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from data.db import load_transactions_csv, row_count

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")


def main():
    parser = argparse.ArgumentParser(description="Load IBM AML CSV into DuckDB")
    parser.add_argument("--csv",   default="data/raw/transactions.csv")
    parser.add_argument("--limit", type=int, default=0,
                        help="Max rows to load (0 = all)")
    args = parser.parse_args()

    csv_path = Path(args.csv)
    if not csv_path.is_absolute():
        csv_path = Path(__file__).parent.parent / csv_path

    result = load_transactions_csv(csv_path=csv_path, limit=args.limit or None)

    print(f"\nLoad complete.")
    print(f"  Rows loaded this run : {result['rows_loaded']:,}")
    print(f"  Total in DB          : {row_count():,}")
    if result["warnings"]:
        print("\nWarnings:")
        for w in result["warnings"]:
            print(f"  ⚠  {w}")


if __name__ == "__main__":
    main()
