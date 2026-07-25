# Import all tool modules here so their @tool decorators fire at import time.
# The router in main.py imports this package to ensure every tool is registered.
from tools import eda, feature_engineering  # noqa: F401
