"""
Real-time transaction stream simulator.

Reads the IBM AML CSV chronologically, inserts rows into DuckDB at
accelerated speed, and emits SSE events when transactions cross
detection thresholds (structuring, high ML score).

Designed for live hackathon demos — makes the system catch fraud "as it happens."
"""

from __future__ import annotations

import asyncio
import csv
import io
import logging
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import AsyncGenerator, Optional

import duckdb
import numpy as np

logger = logging.getLogger(__name__)

CSV_PATH = Path(__file__).parent / "data/raw/HI-Small_Trans.csv"

# Structuring detection thresholds (mirrors anomaly_detection.py)
STRUCTURING_THRESHOLD = 10_000
STRUCTURING_BAND = 0.05
STRUCTURING_NEAR_LO = STRUCTURING_THRESHOLD * (1 - STRUCTURING_BAND)

# Alert: minimum near-threshold txns in the sliding window to trigger
ALERT_MIN_NEAR_THRESHOLD = 2


@dataclass
class StreamStatus:
    running: bool = False
    paused: bool = False
    speed: float = 100.0          # real-time multiplier (100x = 1s real = 100s data)
    rows_inserted: int = 0
    total_rows: int = 0
    alerts_fired: int = 0
    current_timestamp: Optional[str] = None
    start_time: Optional[float] = None
    elapsed_real: float = 0.0

    def to_dict(self) -> dict:
        return {
            "running": self.running,
            "paused": self.paused,
            "speed": self.speed,
            "rows_inserted": self.rows_inserted,
            "total_rows": self.total_rows,
            "alerts_fired": self.alerts_fired,
            "current_timestamp": self.current_timestamp,
            "elapsed_real": round(self.elapsed_real, 1),
            "progress": round(self.rows_inserted / max(self.total_rows, 1) * 100, 1),
        }


@dataclass
class StreamEvent:
    type: str           # "transaction", "alert", "status", "complete"
    data: dict = field(default_factory=dict)

    def to_sse(self) -> str:
        import json
        return f"data: {json.dumps(self.data, default=str)}\n\n"


class StreamSimulator:
    """
    Singleton-ish simulator. Only one stream can run at a time.
    Uses asyncio.Event for start/stop coordination.
    """

    def __init__(self):
        self.status = StreamStatus()
        self._stop_event = asyncio.Event()
        self._pause_event = asyncio.Event()
        self._pause_event.set()  # not paused initially
        self._subscribers: list[asyncio.Queue] = []
        self._recent_txns: dict[str, list] = defaultdict(list)  # account → [(amount, timestamp)]
        self._task: Optional[asyncio.Task] = None
        self._fired_alerts: set[tuple] = set()  # dedup: (account_id, alert_type, key)

    def subscribe(self) -> asyncio.Queue:
        """Create a new subscriber queue for SSE streaming."""
        q: asyncio.Queue = asyncio.Queue()
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        if q in self._subscribers:
            self._subscribers.remove(q)

    async def _broadcast(self, event: StreamEvent):
        """Send event to all subscribers."""
        dead = []
        for q in self._subscribers:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            self._subscribers.remove(q)

    async def start(self, speed: float = 100.0, db_path: Optional[str] = None):
        """Start the stream simulation in the background."""
        if self.status.running:
            return {"error": "Stream already running"}

        self.status = StreamStatus(running=True, speed=speed, start_time=time.time())
        self._stop_event.clear()
        self._pause_event.set()
        self._recent_txns.clear()
        self._fired_alerts.clear()

        self._task = asyncio.create_task(self._run(db_path))
        return self.status.to_dict()

    async def stop(self):
        """Stop the stream simulation."""
        if not self.status.running:
            return {"error": "No stream running"}
        self._stop_event.set()
        self._pause_event.set()  # unblock if paused
        if self._task:
            await asyncio.wait_for(self._task, timeout=5)
        self.status.running = False
        self.status.paused = False
        return self.status.to_dict()

    async def pause(self):
        if not self.status.running:
            return {"error": "No stream running"}
        self.status.paused = True
        self._pause_event.clear()
        return self.status.to_dict()

    async def resume(self):
        if not self.status.running:
            return {"error": "No stream running"}
        self.status.paused = False
        self._pause_event.set()
        return self.status.to_dict()

    def set_speed(self, speed: float):
        self.status.speed = max(0.1, min(speed, 10000))

    async def _run(self, db_path: Optional[str] = None):
        """Main simulation loop — reads CSV, inserts, detects, emits."""
        import data.db as db_module

        if not CSV_PATH.exists():
            logger.error("CSV not found at %s", CSV_PATH)
            await self._broadcast(StreamEvent("error", {"error": f"CSV not found at {CSV_PATH}"}))
            self.status.running = False
            return

        # Read and sort CSV chronologically
        logger.info("Loading CSV for stream simulation...")
        rows = []
        with open(CSV_PATH, "r") as f:
            reader = csv.DictReader(f)
            for row in reader:
                try:
                    ts = row["Timestamp"]
                    amount = float(row.get("Amount Paid", 0) or 0)
                    rows.append({
                        "timestamp": ts,
                        "sender": row.get("Account", ""),
                        "receiver": row.get("Account.1", row.get("Account", "")),
                        "amount": amount,
                        "currency": row.get("Payment Currency", "USD"),
                        "tx_type": row.get("Payment Format", "transfer"),
                        "country": row.get("From Bank Country", ""),
                        "channel": row.get("Payment Format", ""),
                        "is_laundering": row.get("Is Laundering", "0") == "1",
                    })
                except (KeyError, ValueError):
                    continue

        # Sort chronologically
        rows.sort(key=lambda r: r["timestamp"])
        self.status.total_rows = len(rows)
        logger.info("Loaded %d rows for streaming", len(rows))

        await self._broadcast(StreamEvent("status", {
            **self.status.to_dict(),
            "message": f"Loaded {len(rows):,} transactions. Streaming at {self.status.speed}x speed.",
        }))

        conn = db_module.get_connection(Path(db_path)) if db_path else db_module.get_connection()
        batch = []
        batch_size = 5  # insert N rows per tick for smooth display
        prev_ts_date = None

        for i, row in enumerate(rows):
            if self._stop_event.is_set():
                break

            await self._pause_event.wait()
            if self._stop_event.is_set():
                break

            batch.append(row)

            # Insert batch when full or at end
            if len(batch) >= batch_size or i == len(rows) - 1:
                self._insert_batch(conn, batch)
                self.status.rows_inserted += len(batch)
                self.status.current_timestamp = row["timestamp"]

                # Broadcast transaction events
                for r in batch:
                    await self._broadcast(StreamEvent("transaction", {
                        "type": "transaction",
                        "transaction_id": f"STR-{self.status.rows_inserted:08d}",
                        "timestamp": r["timestamp"],
                        "sender": r["sender"],
                        "receiver": r["receiver"],
                        "amount": r["amount"],
                        "currency": r["currency"],
                        "tx_type": r["tx_type"],
                        "channel": r["channel"],
                        "is_laundering": r["is_laundering"],
                    }))

                # Check for alerts on affected accounts
                affected = set(r["sender"] for r in batch)
                alerts = self._check_alerts(conn, affected)
                for alert in alerts:
                    self.status.alerts_fired += 1
                    await self._broadcast(StreamEvent("alert", alert))

                batch = []

            # Calculate sleep: map data-time gap to real-time sleep
            if i < len(rows) - 1:
                sleep_time = self._calc_sleep(rows[i], rows[i + 1])
                await asyncio.sleep(sleep_time)

        # Done
        self.status.running = False
        self.status.elapsed_real = time.time() - (self.status.start_time or time.time())
        await self._broadcast(StreamEvent("complete", self.status.to_dict()))
        logger.info("Stream simulation complete. %d rows inserted, %d alerts fired.",
                     self.status.rows_inserted, self.status.alerts_fired)

    def _insert_batch(self, conn, batch: list):
        """Insert a batch of transactions into DuckDB."""
        for i, r in enumerate(batch):
            txn_id = f"STR-{self.status.rows_inserted + i:08d}"
            try:
                conn.execute(
                    """INSERT OR IGNORE INTO transactions
                       (transaction_id, timestamp, sender_account_id, receiver_account_id,
                        amount, currency, transaction_type, country, channel, is_laundering)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    [
                        txn_id,
                        r["timestamp"],
                        r["sender"],
                        r["receiver"],
                        r["amount"],
                        r["currency"],
                        r["tx_type"],
                        r["country"],
                        r["channel"],
                        r["is_laundering"],
                    ],
                )
            except Exception as exc:
                logger.debug("Insert failed for %s: %s", txn_id, exc)

    def _check_alerts(self, conn, account_ids: set) -> list[dict]:
        """Run lightweight detection on recently-affected accounts.

        Deduplicates via self._fired_alerts so each distinct pattern fires at most once:
        - structuring: keyed by (account_id, 'structuring', near_threshold_count)
        - large_transaction: keyed by (account_id, 'large_transaction', txn_timestamp)
        """
        alerts = []
        for account_id in account_ids:
            # ── Structuring: near-threshold deposits in last 30 days ──────────
            try:
                result = conn.execute(
                    """SELECT COUNT(*) as cnt, SUM(amount) as total,
                              MIN(timestamp) as first_ts, MAX(timestamp) as last_ts
                       FROM transactions
                       WHERE sender_account_id = ?
                         AND amount >= ? AND amount < ?
                         AND timestamp >= (SELECT MAX(timestamp) FROM transactions) - INTERVAL '30 days'""",
                    [account_id, STRUCTURING_NEAR_LO, STRUCTURING_THRESHOLD],
                ).fetchone()

                if result and result[0] >= ALERT_MIN_NEAR_THRESHOLD:
                    dedup_key = (account_id, "structuring", result[0])
                    if dedup_key not in self._fired_alerts:
                        self._fired_alerts.add(dedup_key)
                        alerts.append({
                            "type": "alert",
                            "alert_type": "structuring",
                            "severity": "high" if result[0] >= 4 else "medium",
                            "account_id": account_id,
                            "message": f"Structuring detected: {result[0]} near-threshold deposits totalling ${result[1]:,.2f}",
                            "near_threshold_count": result[0],
                            "total_amount": result[1],
                            "first_ts": str(result[2]),
                            "last_ts": str(result[3]),
                        })
            except Exception as exc:
                logger.debug("Structuring check failed for %s: %s", account_id, exc)

            # ── Large transaction: single amount ≥ $50k ───────────────────────
            try:
                result = conn.execute(
                    """SELECT amount, timestamp FROM transactions
                       WHERE sender_account_id = ? AND amount >= 50000
                       ORDER BY timestamp DESC LIMIT 1""",
                    [account_id],
                ).fetchone()
                if result:
                    dedup_key = (account_id, "large_transaction", str(result[1]))
                    if dedup_key not in self._fired_alerts:
                        self._fired_alerts.add(dedup_key)
                        alerts.append({
                            "type": "alert",
                            "alert_type": "large_transaction",
                            "severity": "medium",
                            "account_id": account_id,
                            "message": f"Large transaction: ${result[0]:,.2f}",
                            "amount": result[0],
                            "timestamp": str(result[1]),
                        })
            except Exception:
                pass

        return alerts

    def _calc_sleep(self, current: dict, next_row: dict) -> float:
        """
        Map data-time gap to real-time sleep.
        At 100x speed, 1 hour of data = 36 seconds of real time.
        At 1000x speed, 1 day of data = 86.4 seconds of real time.
        Capped at 50ms minimum for smoothness.
        """
        try:
            fmt = "%Y/%m/%d %H:%M"
            t1 = datetime.strptime(current["timestamp"], fmt)
            t2 = datetime.strptime(next_row["timestamp"], fmt)
            data_gap_seconds = (t2 - t1).total_seconds()
        except (ValueError, KeyError):
            return 0.05

        if data_gap_seconds <= 0:
            return 0.05

        real_gap = data_gap_seconds / self.status.speed
        return max(0.05, min(real_gap, 2.0))  # cap at 2s for huge gaps


# Module-level singleton
simulator = StreamSimulator()
