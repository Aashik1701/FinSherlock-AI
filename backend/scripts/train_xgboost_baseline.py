"""
Offline XGBoost baseline training script — run ONCE from the backend/ directory.

    python scripts/train_xgboost_baseline.py

Methodology (mirrors financial-fraud-ring-detection.ipynb):
  - Leakage-aware chronological 60/20/20 split on HI-Small_Trans.csv
  - Degree features computed from train split ONLY, looked up for val/test
  - scale_pos_weight for class imbalance
  - Threshold tuned by maximising F1 on validation set
  - Model + feature list + threshold saved to data/models/xgb_baseline.joblib
"""

from __future__ import annotations

import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import (
    average_precision_score,
    classification_report,
    precision_recall_curve,
)
from xgboost import XGBClassifier

ROOT    = Path(__file__).parent.parent
CSV     = ROOT / "data/raw/HI-Small_Trans.csv"
OUT_DIR = ROOT / "data/models"
OUT     = OUT_DIR / "xgb_baseline.joblib"

SEED = 42


def best_threshold_by_f1(y_true: np.ndarray, probs: np.ndarray) -> float:
    prec, rec, thr = precision_recall_curve(y_true, probs)
    with np.errstate(divide="ignore", invalid="ignore"):
        f1 = np.where((prec + rec) > 0, 2 * prec * rec / (prec + rec), 0.0)
    best = int(np.nanargmax(f1[:-1])) if len(thr) else 0
    return float(thr[best]) if len(thr) else 0.5


def precision_at_k(y_true: np.ndarray, probs: np.ndarray, ks=(50, 100, 500)) -> dict:
    order = np.argsort(-probs)
    y_sorted = y_true[order]
    out: dict[int, float] = {}
    for k in ks:
        kk = min(k, len(y_sorted))
        out[k] = float(y_sorted[:kk].sum() / kk) if kk else 0.0
    return out


def main() -> None:
    print(f"Loading {CSV} ...")
    df = pd.read_csv(CSV, parse_dates=["Timestamp"])
    n_launder = int(df["Is Laundering"].sum())
    print(f"  {len(df):,} rows  |  {n_launder:,} labeled laundering  |  "
          f"{n_launder / len(df) * 100:.4f}% positive rate")

    # ── Stable chronological sort ──────────────────────────────────────────────
    df = df.sort_values("Timestamp", kind="mergesort").reset_index(drop=True)

    # String timestamp used for Patterns.txt key matching
    df["_ts_str"] = df["Timestamp"].dt.strftime("%Y/%m/%d %H:%M")

    # ── 60 / 20 / 20 chronological split ──────────────────────────────────────
    n = len(df)
    tr_end, va_end = int(n * 0.6), int(n * 0.8)
    train = df.iloc[:tr_end].copy()
    val   = df.iloc[tr_end:va_end].copy()
    test  = df.iloc[va_end:].copy()

    print(f"\n  Split:  train {len(train):,}  |  val {len(val):,}  |  test {len(test):,}")
    print(f"          laundering — train {int(train['Is Laundering'].sum()):,}  "
          f"val {int(val['Is Laundering'].sum()):,}  "
          f"test {int(test['Is Laundering'].sum()):,}")

    # ── Degree features from TRAIN ONLY (leakage-aware) ───────────────────────
    train_out_deg = train.groupby("Account").size()
    train_in_deg  = train.groupby("Account.1").size()

    def add_features(part: pd.DataFrame) -> pd.DataFrame:
        part = part.copy()
        part["sender_out_degree"]    = part["Account"].map(train_out_deg).fillna(0.0)
        part["receiver_in_degree"]   = part["Account.1"].map(train_in_deg).fillna(0.0)
        part["is_currency_mismatch"] = (
            part["Payment Currency"].astype(str) != part["Receiving Currency"].astype(str)
        ).astype("int8")
        part["log_amount_paid"] = np.log1p(part["Amount Paid"].astype("float64"))
        return part

    train = add_features(train)
    val   = add_features(val)
    test  = add_features(test)

    # ── Payment Format one-hot — categories fixed from train ──────────────────
    fmt_dummies = pd.get_dummies(train["Payment Format"], prefix="fmt", dtype=int)
    fmt_cols    = list(fmt_dummies.columns)
    for col in fmt_cols:
        train[col] = fmt_dummies[col].values

    def add_fmt(part: pd.DataFrame) -> None:
        d = pd.get_dummies(part["Payment Format"], prefix="fmt", dtype=int)
        d = d.reindex(columns=fmt_cols, fill_value=0)
        for col in fmt_cols:
            part[col] = d[col].values

    add_fmt(val)
    add_fmt(test)

    FEATURE_COLS = (
        ["sender_out_degree", "receiver_in_degree", "is_currency_mismatch", "log_amount_paid"]
        + fmt_cols
    )
    print(f"\n  {len(FEATURE_COLS)} features: {FEATURE_COLS}")

    Xtr, ytr = train[FEATURE_COLS].values, train["Is Laundering"].values.astype(int)
    Xva, yva = val[FEATURE_COLS].values,   val["Is Laundering"].values.astype(int)
    Xte, yte = test[FEATURE_COLS].values,  test["Is Laundering"].values.astype(int)

    # ── Class imbalance weight ─────────────────────────────────────────────────
    scale_pos_weight = float((ytr == 0).sum()) / max(float((ytr == 1).sum()), 1.0)
    print(f"\n  scale_pos_weight (train class ratio): {scale_pos_weight:.2f}")

    # ── Train XGBoost ──────────────────────────────────────────────────────────
    print("\n  Training XGBoost (n_estimators=300, max_depth=6, lr=0.1) ...")
    xgb = XGBClassifier(
        n_estimators=300,
        max_depth=6,
        learning_rate=0.1,
        scale_pos_weight=scale_pos_weight,
        tree_method="hist",
        random_state=SEED,
        n_jobs=-1,
        eval_metric="aucpr",
    )
    xgb.fit(Xtr, ytr, eval_set=[(Xva, yva)], verbose=False)
    print("  Done.")

    # ── Threshold selection on VAL (maximise F1) ───────────────────────────────
    val_probs = xgb.predict_proba(Xva)[:, 1]
    threshold = best_threshold_by_f1(yva, val_probs)
    print(f"\n  Best threshold by val-F1: {threshold:.4f}")

    # ── Test-set evaluation ────────────────────────────────────────────────────
    test_probs = xgb.predict_proba(Xte)[:, 1]
    test_preds = (test_probs >= threshold).astype(int)
    pr_auc     = average_precision_score(yte, test_probs)

    sep = "=" * 62
    print(f"\n{sep}")
    print("  XGBoost TEST-SET RESULTS")
    print(sep)
    print(classification_report(yte, test_preds, digits=4, target_names=["clean", "laundering"]))
    print(f"  PR-AUC (Average Precision):  {pr_auc:.5f}")
    pk = precision_at_k(yte, test_probs)
    for k, v in pk.items():
        tp = int(round(v * min(k, len(yte))))
        print(f"  Precision@{k:<5}            {v:.4f}  ({tp} true positives in top {k})")
    print(sep)

    # ── Feature importances (gain) ─────────────────────────────────────────────
    print("\n  Feature importances (gain-based):")
    pairs = sorted(zip(FEATURE_COLS, xgb.feature_importances_), key=lambda x: -x[1])
    for feat, imp in pairs:
        bar = "█" * int(imp * 50)
        print(f"    {feat:<35} {imp:.4f}  {bar}")

    # ── Save ───────────────────────────────────────────────────────────────────
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "model":         xgb,
        "feature_cols":  FEATURE_COLS,
        "fmt_cols":      fmt_cols,
        "threshold":     threshold,
        "train_out_deg": dict(train_out_deg),
        "train_in_deg":  dict(train_in_deg),
        "pr_auc":        pr_auc,
        "n_train":       len(train),
        "n_val":         len(val),
        "n_test":        len(test),
    }
    joblib.dump(payload, OUT, compress=3)
    size_mb = OUT.stat().st_size / 1_048_576
    print(f"\n  Saved → {OUT}  ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
