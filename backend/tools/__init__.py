# Import all tool modules so their @tool decorators fire at import time.
# The FastAPI app and the orchestrator both import this package.
from tools import eda, feature_engineering, anomaly_detection, risk_classifier, explainer  # noqa: F401
