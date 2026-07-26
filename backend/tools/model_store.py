"""Shared model loader for FinSherlock ML tools.

The XGBoost baseline is stored as a joblib payload. Loading it once and
reusing the cached payload keeps startup cheaper and avoids repeating the
deserialization warnings in every tool module.
"""

from __future__ import annotations

import logging
from functools import lru_cache
from pathlib import Path

import joblib

logger = logging.getLogger(__name__)

MODEL_PATH = Path(__file__).parent.parent / "data/models/xgb_baseline.joblib"


@lru_cache(maxsize=1)
def load_xgb_payload() -> dict:
    """Load and cache the baseline model payload."""
    payload = joblib.load(MODEL_PATH)
    logger.info("Loaded XGBoost baseline payload from %s", MODEL_PATH)
    return payload