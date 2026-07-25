"""
Evaluate rule-based detection tools against IBM HI-Small ground-truth labels.

Run from backend/ directory:
    python scripts/evaluate_detection.py [--patterns PATH] [--limit N]

The IBM HI-Small dataset ships a HI-Small_Patterns.txt that records every
labeled laundering transaction grouped by typology block:

    BEGIN LAUNDERING ATTEMPT - FAN-OUT
    2022/09/01 00:15,WELLS FARGO,C123,...,Reinvestment
    ...
    END LAUNDERING ATTEMPT

This script:
  1. Loads the raw CSV (all rows or up to --limit)
  2. Parses Patterns.txt to build a (ts_str, sender, receiver, fmt) → typology map
  3. Attaches ground-truth typology labels to each row
  4. Evaluates our detect_structuring / detect_smurfing / detect_layering signals
     by comparing flagged accounts against ground-truth laundering accounts

Patterns.txt key: (timestamp_str, sender_account, receiver_account, payment_format)
  — NOT amount (float formatting diverges between CSV and Patterns file)
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).parent.parent


def parse_patterns(path: Path) -> dict[tuple, str]:
    """Return {(ts_str, sender, receiver, fmt): TYPOLOGY_UPPER} from Patterns.txt."""
    key_to_typ: dict[tuple, str] = {}
    current: str | None = None

    with open(path, "r", errors="ignore") as fh:
        for raw in fh:
            line = raw.strip()
            up   = line.upper()

            if up.startswith("BEGIN LAUNDERING ATTEMPT"):
                current = line.split("-", 1)[1].strip().upper() if "-" in line else "UNKNOWN"
                continue
            if up.startswith("END LAUNDERING ATTEMPT"):
                current = None
                continue
            if current is None:
                continue

            # CSV cols inside the block:
            # 0=Timestamp  1=From Bank  2=Account(sender)  3=To Bank  4=Account.1(receiver)
            # 5=AmtRecv    6=RecvCur    7=AmtPaid           8=PayCur   9=PayFmt  10=IsLaunder
            parts = line.split(",")
            if len(parts) < 10:
                continue
            key = (
                parts[0].strip(),   # timestamp string exactly as written
                parts[2].strip(),   # sender account
                parts[4].strip(),   # receiver account
                parts[9].strip(),   # Payment Format
            )
            key_to_typ[key] = current

    return key_to_typ


def attach_typology(df: pd.DataFrame, key_to_typ: dict[tuple, str]) -> pd.Series:
    keys = list(zip(
        df["_ts_str"].astype(str),
        df["Account"].astype(str),
        df["Account.1"].astype(str),
        df["Payment Format"].astype(str),
    ))
    return pd.Series([key_to_typ.get(k) for k in keys], index=df.index, name="typology")


def structuring_precision_recall(
    df: pd.DataFrame,
    threshold: float = 10_000.0,
    band: float = 0.05,
) -> dict:
    """Simple rule: flag accounts with ≥2 near-threshold transactions."""
    near_lo = threshold * (1 - band)
    df = df.copy()
    df["near_threshold"] = (df["Amount Paid"] >= near_lo) & (df["Amount Paid"] < threshold)

    flagged_accts = (
        df[df["near_threshold"]]
        .groupby("Account")["near_threshold"]
        .sum()
        .loc[lambda s: s >= 2]
        .index.tolist()
    )

    true_launder_accts = set(
        df[df["Is Laundering"] == 1]["Account"].unique()
    )

    tp = len(set(flagged_accts) & true_launder_accts)
    fp = len(set(flagged_accts) - true_launder_accts)
    fn = len(true_launder_accts - set(flagged_accts))

    prec = tp / (tp + fp) if (tp + fp) else 0.0
    rec  = tp / (tp + fn) if (tp + fn) else 0.0
    f1   = 2 * prec * rec / (prec + rec) if (prec + rec) else 0.0

    return {
        "rule":      "structuring (≥2 near-threshold txns)",
        "flagged":   len(flagged_accts),
        "true_launder_accounts": len(true_launder_accts),
        "tp": tp, "fp": fp, "fn": fn,
        "precision": round(prec, 4),
        "recall":    round(rec, 4),
        "f1":        round(f1, 4),
    }


def smurfing_precision_recall(
    df: pd.DataFrame,
    fan_threshold: int = 3,
) -> dict:
    """Flag accounts with fan-out (distinct receivers) ≥ fan_threshold."""
    fan_out = df.groupby("Account")["Account.1"].nunique()
    flagged_accts = set(fan_out[fan_out >= fan_threshold].index)

    true_launder_accts = set(df[df["Is Laundering"] == 1]["Account"].unique())

    tp = len(flagged_accts & true_launder_accts)
    fp = len(flagged_accts - true_launder_accts)
    fn = len(true_launder_accts - flagged_accts)

    prec = tp / (tp + fp) if (tp + fp) else 0.0
    rec  = tp / (tp + fn) if (tp + fn) else 0.0
    f1   = 2 * prec * rec / (prec + rec) if (prec + rec) else 0.0

    return {
        "rule":      f"smurfing (fan-out ≥ {fan_threshold})",
        "flagged":   len(flagged_accts),
        "true_launder_accounts": len(true_launder_accts),
        "tp": tp, "fp": fp, "fn": fn,
        "precision": round(prec, 4),
        "recall":    round(rec, 4),
        "f1":        round(f1, 4),
    }


def typology_breakdown(df: pd.DataFrame, key_to_typ: dict[tuple, str]) -> None:
    df = df.copy()
    df["typology"] = attach_typology(df, key_to_typ)
    labeled = df[df["typology"].notna()]
    print(f"\n  Patterns.txt matched {len(labeled):,} / {len(df):,} rows  "
          f"({len(labeled)/len(df)*100:.3f}%)")
    if labeled.empty:
        return
    counts = labeled["typology"].value_counts()
    print("  Typology distribution:")
    for typ, cnt in counts.items():
        print(f"    {typ:<40} {cnt:>8,}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Evaluate detection tools against IBM AML labels.")
    ap.add_argument("--patterns", default=str(ROOT / "data/raw/HI-Small_Patterns.txt"),
                    help="Path to the Patterns.txt file")
    ap.add_argument("--csv",      default=str(ROOT / "data/raw/HI-Small_Trans.csv"),
                    help="Path to the transactions CSV")
    ap.add_argument("--limit",    type=int, default=None,
                    help="Row limit (None = all rows)")
    args = ap.parse_args()

    csv_path      = Path(args.csv)
    patterns_path = Path(args.patterns)

    if not csv_path.exists():
        print(f"ERROR: CSV not found at {csv_path}")
        sys.exit(1)

    print(f"Loading {csv_path} ...")
    df = pd.read_csv(csv_path, parse_dates=["Timestamp"], nrows=args.limit)
    print(f"  {len(df):,} rows  |  {int(df['Is Laundering'].sum()):,} labeled laundering")

    df["_ts_str"] = df["Timestamp"].dt.strftime("%Y/%m/%d %H:%M")

    sep = "=" * 60

    # ── Patterns.txt analysis ──────────────────────────────────────────────────
    if patterns_path.exists():
        print(f"\nParsing {patterns_path} ...")
        key_to_typ = parse_patterns(patterns_path)
        print(f"  {len(key_to_typ):,} labeled transaction keys")
        typology_breakdown(df, key_to_typ)
    else:
        print(f"\nPatterns.txt not found at {patterns_path} — skipping typology breakdown.")
        key_to_typ = {}

    # ── Rule-based detection evaluation ────────────────────────────────────────
    print(f"\n{sep}")
    print("  RULE-BASED DETECTION vs. IS_LAUNDERING LABEL")
    print(sep)

    for result in [
        structuring_precision_recall(df),
        smurfing_precision_recall(df, fan_threshold=3),
        smurfing_precision_recall(df, fan_threshold=5),
    ]:
        print(f"\n  Rule:      {result['rule']}")
        print(f"  Flagged:   {result['flagged']:,}  "
              f"(true launder accounts: {result['true_launder_accounts']:,})")
        print(f"  TP={result['tp']}  FP={result['fp']}  FN={result['fn']}")
        print(f"  Precision: {result['precision']:.4f}  "
              f"Recall: {result['recall']:.4f}  F1: {result['f1']:.4f}")

    print(f"\n{sep}")

    # ── XGBoost model evaluation (if available) ────────────────────────────────
    model_path = ROOT / "data/models/xgb_baseline.joblib"
    if model_path.exists():
        import joblib
        from sklearn.metrics import average_precision_score, classification_report

        print("\n  XGBOOST MODEL (full CSV — informational, not hold-out)")
        print(sep)
        payload = joblib.load(model_path)
        xgb    = payload["model"]
        fcols  = payload["feature_cols"]
        fmt_c  = payload["fmt_cols"]
        thr    = payload["threshold"]

        train_out_deg = pd.Series(payload.get("train_out_deg", {}))
        train_in_deg  = pd.Series(payload.get("train_in_deg", {}))

        df["sender_out_degree"]    = df["Account"].map(train_out_deg).fillna(0.0)
        df["receiver_in_degree"]   = df["Account.1"].map(train_in_deg).fillna(0.0)
        df["is_currency_mismatch"] = (
            df["Payment Currency"].astype(str) != df["Receiving Currency"].astype(str)
        ).astype(int)
        df["log_amount_paid"] = np.log1p(df["Amount Paid"].astype("float64"))

        fmt_d = pd.get_dummies(df["Payment Format"], prefix="fmt", dtype=int)
        fmt_d = fmt_d.reindex(columns=fmt_c, fill_value=0)
        for col in fmt_c:
            df[col] = fmt_d[col].values

        X = df[fcols].values
        y = df["Is Laundering"].values.astype(int)
        probs = xgb.predict_proba(X)[:, 1]
        preds = (probs >= thr).astype(int)

        pr_auc = average_precision_score(y, probs)
        print(f"  Threshold: {thr:.4f}  |  PR-AUC: {pr_auc:.5f}")
        print(classification_report(y, preds, digits=4,
                                    target_names=["clean", "laundering"]))
    else:
        print(f"\n  XGBoost model not found at {model_path}.")
        print("  Run scripts/train_xgboost_baseline.py first.")


if __name__ == "__main__":
    main()
