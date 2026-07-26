"""
Retrain XGBoost model incorporating analyst feedback labels.

Reads the original HI-Small_Trans.csv training data, applies analyst
feedback overrides (TP/FP labels), and retrains the model.

Usage:
    python scripts/retrain_with_feedback.py [--feedback-json <path>]

Called by POST /feedback/retrain endpoint. Also runnable standalone.
When called from the endpoint, feedback is passed via --feedback-json
to avoid DuckDB lock contention from the subprocess.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, classification_report, precision_recall_curve
from xgboost import XGBClassifier

ROOT    = Path(__file__).parent.parent
CSV     = ROOT / "data/raw/HI-Small_Trans.csv"
OUT_DIR = ROOT / "data/models"
OUT     = OUT_DIR / "xgb_baseline.joblib"

SEED = 42
_ENTROPY_BINS = 10


def _shannon_entropy(values: np.ndarray) -> float:
    if len(values) == 0:
        return 0.0
    counts, _ = np.histogram(values, bins=_ENTROPY_BINS)
    probs = counts / counts.sum()
    probs = probs[probs > 0]
    return float(-np.sum(probs * np.log2(probs)))


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


def _load_feedback_overrides(feedback_json: str | None = None) -> dict[str, bool]:
    """
    Load analyst feedback and return {account_id: label} overrides.
    Supports two modes:
      1. --feedback-json <path>  (preferred — avoids DuckDB lock contention)
      2. DuckDB connection       (fallback for standalone use)
    """
    if feedback_json:
        path = Path(feedback_json)
        if path.exists():
            rows = json.loads(path.read_text())
            overrides: dict[str, bool] = {}
            for entry in rows:
                overrides[entry["account_id"]] = entry["label"]
            if overrides:
                tp = sum(1 for v in overrides.values() if v)
                fp = sum(1 for v in overrides.values() if not v)
                print(f"  Loaded {len(overrides)} feedback overrides from JSON ({tp} TP, {fp} FP)")
            else:
                print("  No analyst feedback found — training on original labels only.")
            return overrides

    # Fallback: connect to DuckDB directly (standalone use)
    import duckdb
    DB_PATH = ROOT / "data/finsherlock.duckdb"
    if not DB_PATH.exists():
        print("  No DuckDB found — running without feedback overrides.")
        return {}

    conn = duckdb.connect(str(DB_PATH), read_only=True)
    try:
        rows = conn.execute(
            "SELECT account_id, label FROM analyst_feedback ORDER BY created_at"
        ).fetchall()
    except Exception:
        # Table may not exist yet
        return {}
    finally:
        conn.close()

    if not rows:
        print("  No analyst feedback found — training on original labels only.")
        return {}

    overrides = {}
    for account_id, label in rows:
        overrides[account_id] = bool(label)

    tp = sum(1 for v in overrides.values() if v)
    fp = sum(1 for v in overrides.values() if not v)
    print(f"  Loaded {len(overrides)} feedback overrides ({tp} TP, {fp} FP)")
    return overrides


def main(feedback_json: str | None = None) -> None:
    print(f"Loading {CSV} ...")
    df = pd.read_csv(CSV, parse_dates=["Timestamp"])
    n_launder_orig = int(df["Is Laundering"].sum())
    print(f"  {len(df):,} rows  |  {n_launder_orig:,} labeled laundering")

    # ── Apply analyst feedback overrides ──────────────────────────────────────
    overrides = _load_feedback_overrides(feedback_json=feedback_json)
    if overrides:
        # Map sender_account_id column (named "Account" in the CSV)
        mask = df["Account"].isin(overrides)
        n_overridden = mask.sum()
        # Apply overrides: TP accounts get label=1, FP accounts get label=0
        for idx in df[mask].index:
            acct = df.at[idx, "Account"]
            df.at[idx, "Is Laundering"] = int(overrides[acct])
        n_launder_new = int(df["Is Laundering"].sum())
        print(f"  Overrode {n_overridden:,} rows  |  laundering labels: {n_launder_orig:,} → {n_launder_new:,}")

    # ── Stable chronological sort ──────────────────────────────────────────────
    df = df.sort_values("Timestamp", kind="mergesort").reset_index(drop=True)

    # ── 60 / 20 / 20 chronological split ──────────────────────────────────────
    n = len(df)
    tr_end, va_end = int(n * 0.6), int(n * 0.8)
    train = df.iloc[:tr_end].copy()
    val   = df.iloc[tr_end:va_end].copy()
    test  = df.iloc[va_end:].copy()

    print(f"\n  Split:  train {len(train):,}  |  val {len(val):,}  |  test {len(test):,}")

    # ── Degree features from TRAIN ONLY ───────────────────────────────────────
    train_out_deg = train.groupby("Account").size()
    train_in_deg  = train.groupby("Account.1").size()

    # ── Amount entropy per sender from TRAIN ONLY ─────────────────────────────
    train_amount_entropy = train.groupby("Account")["Amount Paid"].apply(
        lambda s: _shannon_entropy(s.values.astype(float))
    )

    def add_features(part: pd.DataFrame) -> pd.DataFrame:
        part = part.copy()
        part["sender_out_degree"]  = part["Account"].map(train_out_deg).fillna(0.0)
        part["receiver_in_degree"] = part["Account.1"].map(train_in_deg).fillna(0.0)
        part["log_amount_paid"]    = np.log1p(part["Amount Paid"].astype("float64"))
        part["amount_entropy"]     = part["Account"].map(train_amount_entropy).fillna(0.0)
        return part

    train = add_features(train)
    val   = add_features(val)
    test  = add_features(test)

    # ── Time-of-day / day-of-week one-hot ─────────────────────────────────────
    def add_time_features(part):
        part = part.copy()
        hod_dummies = pd.get_dummies(part["Timestamp"].dt.hour, prefix="hod", dtype=int)
        dow_dummies = pd.get_dummies(part["Timestamp"].dt.dayofweek, prefix="dow", dtype=int)
        return part, list(hod_dummies.columns), list(dow_dummies.columns), hod_dummies, dow_dummies

    train, hod_cols, dow_cols, hod_dummies, dow_dummies = add_time_features(train)
    for col in hod_cols:
        train[col] = hod_dummies[col].values
    for col in dow_cols:
        train[col] = dow_dummies[col].values

    def add_time_aligned(part):
        part = part.copy()
        hod_dummies = pd.get_dummies(part["Timestamp"].dt.hour, prefix="hod", dtype=int)
        dow_dummies = pd.get_dummies(part["Timestamp"].dt.dayofweek, prefix="dow", dtype=int)
        hod_dummies = hod_dummies.reindex(columns=hod_cols, fill_value=0)
        dow_dummies = dow_dummies.reindex(columns=dow_cols, fill_value=0)
        for col in hod_cols:
            part[col] = hod_dummies[col].values
        for col in dow_cols:
            part[col] = dow_dummies[col].values
        return part

    val  = add_time_aligned(val)
    test = add_time_aligned(test)

    # ── Payment Format one-hot ─────────────────────────────────────────────────
    fmt_dummies = pd.get_dummies(train["Payment Format"], prefix="fmt", dtype=int)
    fmt_cols    = list(fmt_dummies.columns)
    for col in fmt_cols:
        train[col] = fmt_dummies[col].values

    def add_fmt(part):
        d = pd.get_dummies(part["Payment Format"], prefix="fmt", dtype=int)
        d = d.reindex(columns=fmt_cols, fill_value=0)
        for col in fmt_cols:
            part[col] = d[col].values

    add_fmt(val)
    add_fmt(test)

    FEATURE_COLS = (
        ["sender_out_degree", "receiver_in_degree", "log_amount_paid", "amount_entropy"]
        + hod_cols + dow_cols + fmt_cols
    )
    print(f"\n  {len(FEATURE_COLS)} features")

    Xtr, ytr = train[FEATURE_COLS].values, train["Is Laundering"].values.astype(int)
    Xva, yva = val[FEATURE_COLS].values,   val["Is Laundering"].values.astype(int)
    Xte, yte = test[FEATURE_COLS].values,  test["Is Laundering"].values.astype(int)

    # ── Class imbalance ────────────────────────────────────────────────────────
    scale_pos_weight = float((ytr == 0).sum()) / max(float((ytr == 1).sum()), 1.0)
    print(f"  scale_pos_weight: {scale_pos_weight:.2f}")

    # ── Train ──────────────────────────────────────────────────────────────────
    print("\n  Training XGBoost ...")
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

    # ── Threshold ──────────────────────────────────────────────────────────────
    val_probs = xgb.predict_proba(Xva)[:, 1]
    threshold = best_threshold_by_f1(yva, val_probs)
    print(f"  Best threshold: {threshold:.4f}")

    # ── Evaluate ───────────────────────────────────────────────────────────────
    test_probs = xgb.predict_proba(Xte)[:, 1]
    test_preds = (test_probs >= threshold).astype(int)
    pr_auc     = average_precision_score(yte, test_probs)

    print(f"\n{'=' * 62}")
    print("  RETRAINED MODEL — TEST SET RESULTS")
    print("=" * 62)
    print(classification_report(yte, test_preds, digits=4, target_names=["clean", "laundering"]))
    print(f"  PR-AUC:  {pr_auc:.5f}")
    pk = precision_at_k(yte, test_probs)
    for k, v in pk.items():
        tp = int(round(v * min(k, len(yte))))
        print(f"  Precision@{k:<5}  {v:.4f}  ({tp} TP in top {k})")
    print("=" * 62)

    # ── Save ───────────────────────────────────────────────────────────────────
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "model":               xgb,
        "feature_cols":        FEATURE_COLS,
        "fmt_cols":            fmt_cols,
        "hod_cols":            hod_cols,
        "dow_cols":            dow_cols,
        "threshold":           threshold,
        "train_out_deg":       dict(train_out_deg),
        "train_in_deg":        dict(train_in_deg),
        "train_amount_entropy": dict(train_amount_entropy),
        "pr_auc":              pr_auc,
        "n_train":             len(train),
        "n_val":               len(val),
        "n_test":              len(test),
        "feedback_overrides":  len(overrides),
    }
    joblib.dump(payload, OUT, compress=3)
    size_mb = OUT.stat().st_size / 1_048_576
    print(f"\n  Saved → {OUT}  ({size_mb:.1f} MB)")


if __name__ == "__main__":
    feedback_json = None
    if len(sys.argv) > 1 and sys.argv[1] == "--feedback-json" and len(sys.argv) > 2:
        feedback_json = sys.argv[2]
    main(feedback_json=feedback_json)
