"""
Planner agent — translates a natural-language analyst query into a structured
JSON execution plan.

Call flow
---------
call_planner(query)
  └─ try Groq → try Gemini (via litellm)
       └─ on any failure: deterministic_fallback_plan(query)

The LLM is given the full TOOL_REGISTRY schema (via get_llm_tool_schemas) so it
can only reference tools that actually exist.  It is instructed to respond with
pure JSON — the plan struct — never with prose or data analysis.

deterministic_fallback_plan() uses regex/keyword matching and requires zero API
keys, so the whole system works out-of-the-box before any credentials are wired.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

logger = logging.getLogger(__name__)

# Provider fallback chain.  litellm resolves these model strings to the correct
# provider SDK automatically.
PROVIDERS: list[str] = [
    "groq/llama-3.3-70b-versatile",
    "gemini/gemini-2.0-flash",
]

# Maps provider prefix → environment-variable name that must be set.
_KEY_ENV: dict[str, str] = {
    "groq":   "GROQ_API_KEY",
    "gemini": "GEMINI_API_KEY",
}

# ---------------------------------------------------------------------------
# System prompt — embedded tool schemas at call time
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT_TEMPLATE = """\
You are the planning brain of FinSherlock AI, an Anti-Money Laundering investigation platform.

Your ONLY job: parse the analyst's query and produce a JSON execution plan.
You do NOT run analysis, query data, or make fraud decisions.
You only decide WHICH registered tools to call and with WHAT arguments.

Available tools (JSON schemas):
{tool_schemas}

Respond with ONLY a valid JSON object — no markdown, no prose, no code fences.
Use exactly this structure:

{{
  "intent": "<broad_exploration | pattern_scan | single_entity_lookup | pure_aggregation>",
  "filters": {{
    "date_from":   null,
    "date_to":     null,
    "account_ids": null,
    "country":          null,
    "segment":          null,
    "transaction_type": null,
    "window_days":      30
  }},
  "target_pattern": "<null | structuring | smurfing | layering>",
  "plan": [
    {{"tool": "<exact tool name>", "args": {{}}}}
  ],
  "planner_source": "llm"
}}

IMPORTANT: classify_risk and explain_flag receive prior tool outputs via injection.
Set structuring_output, anomaly_output, and classify_output to null in their args —
the orchestrator fills them automatically at runtime.

Standard chain patterns (use these exactly):

Pure aggregation / count query (e.g., "how many customers made N+ transactions under $10,000"):
  run_eda → detect_structuring  (DO NOT run ML, IsolationForest, SHAP, or graph tools for simple count queries!)

Structuring query:
  run_eda → engineer_features → detect_structuring
  → classify_risk(structuring_output=null) → explain_flag(classify_output=null, target_pattern="structuring")

Single-entity / customer query:
  engineer_features(account_ids=[id]) → detect_anomalies(account_ids=[id])
  → classify_risk(anomaly_output=null, account_id=id) → explain_flag(classify_output=null, account_id=id)

Smurfing / layering / generic anomaly query:
  run_eda → engineer_features → detect_anomalies
  → classify_risk(anomaly_output=null) → explain_flag(classify_output=null, target_pattern=<pattern>)

Broad exploration:
  run_eda → engineer_features → detect_anomalies
  → classify_risk(anomaly_output=null) → explain_flag(classify_output=null)

Extract date windows from "last N days" → set window_days. Extract country ("in Country X" / "US", "UK") → set country filter. Extract segment ("corporate", "retail") → set segment filter.
"""


def _build_system_prompt(tool_schemas: list[dict]) -> str:
    return _SYSTEM_PROMPT_TEMPLATE.format(
        tool_schemas=json.dumps(tool_schemas, indent=2)
    )


# ---------------------------------------------------------------------------
# Provider availability check
# ---------------------------------------------------------------------------

def _has_api_key(provider: str) -> bool:
    """Return True if the required env var for this provider is non-empty."""
    prefix = provider.split("/")[0]
    env_var = _KEY_ENV.get(prefix, "")
    return bool(env_var and os.environ.get(env_var, "").strip())


# ---------------------------------------------------------------------------
# JSON extraction — strips markdown fences if the model wraps its output
# ---------------------------------------------------------------------------

def _extract_json(raw: str) -> dict:
    # Strip ``` or ```json fences that some models add despite instructions
    cleaned = re.sub(r"^```(?:json)?\s*", "", raw.strip(), flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```$", "", cleaned.strip())
    return json.loads(cleaned)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def call_planner(query: str) -> dict:
    """
    Parse query → execution plan.

    Tries each provider in PROVIDERS in order.  Falls back to the deterministic
    planner if litellm is unavailable, no API key is set, or the provider errors.
    """
    # Lazy import so the module is usable even if litellm is not installed
    try:
        import litellm  # noqa: F401
        litellm_available = True
    except ImportError:
        logger.warning("litellm not installed — using deterministic fallback")
        litellm_available = False

    if litellm_available:
        from agent.registry import get_llm_tool_schemas
        import litellm as _litellm  # re-import with alias for clarity

        tool_schemas = get_llm_tool_schemas()
        system_prompt = _build_system_prompt(tool_schemas)

        for provider in PROVIDERS:
            if not _has_api_key(provider):
                logger.info("Skipping %s — %s not set", provider, _KEY_ENV.get(provider.split("/")[0], "?"))
                continue

            try:
                logger.info("Calling planner via %s", provider)
                kwargs: dict[str, Any] = {
                    "model": provider,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": query},
                    ],
                    "temperature": 0,
                    "max_tokens": 1024,
                }
                # Groq and most OpenAI-compatible endpoints support json_object mode
                if provider.startswith("groq"):
                    kwargs["response_format"] = {"type": "json_object"}

                response = _litellm.completion(**kwargs)
                raw_content: str = response.choices[0].message.content or ""
                plan = _extract_json(raw_content)
                plan["planner_source"] = f"llm:{provider}"
                logger.info("Plan produced by %s (intent=%s)", provider, plan.get("intent"))
                return plan

            except Exception as exc:
                logger.warning("Provider %s failed: %s", provider, exc)

    logger.info("All LLM providers skipped or failed — using deterministic fallback")
    return deterministic_fallback_plan(query)


# ---------------------------------------------------------------------------
# Deterministic fallback planner
# ---------------------------------------------------------------------------

def deterministic_fallback_plan(query: str) -> dict:
    """
    Keyword/regex-based plan builder.  Zero API calls, zero dependencies beyond
    stdlib.  This is the path taken when no API keys are configured.

    Patterns (checked in priority order):
      1. Single entity  — "customer <id>" / "account <id>" / "explain <id>"
      2. Smurfing       — smurf / fan-out / fan out
      3. Structuring    — structuring / threshold / cash deposit
      4. Layering       — layering / chain / hop / intermediary
      5. Generic        — everything else → broad exploration
    """
    q = query.lower()

    # --- Extract optional date window from "last N days" ---
    window_days = 30
    window_match = re.search(r"last\s+(\d+)\s+days?", q)
    if window_match:
        window_days = int(window_match.group(1))

    # --- Extract optional date anchors "since YYYY-MM-DD" / "from YYYY-MM-DD" ---
    date_from: str | None = None
    date_to:   str | None = None
    date_since = re.search(r"(?:since|from)\s+(\d{4}-\d{2}-\d{2})", q)
    date_until = re.search(r"(?:until|to|before)\s+(\d{4}-\d{2}-\d{2})", q)
    if date_since:
        date_from = date_since.group(1)
    if date_until:
        date_to = date_until.group(1)

    # --- Extract optional country filter ---
    country: str | None = None
    country_match = re.search(r"\b(?:in|from|country)\s+([A-Za-z]{2,15})\b", q)
    if country_match and country_match.group(1).lower() not in {"the", "last", "recent", "customer", "account"}:
        country = country_match.group(1).upper()

    # --- Extract optional segment filter ---
    segment: str | None = None
    segment_match = re.search(r"\b(retail|corporate|private[\s-]banking|commercial)\b", q)
    if segment_match:
        segment = segment_match.group(1).lower()

    # --- Extract optional transaction_type filter ---
    transaction_type: str | None = None
    txn_type_match = re.search(r"\b(cash[\s_]?deposit|wire|transfer|withdrawal|crypto)\b", q)
    if txn_type_match:
        transaction_type = txn_type_match.group(1).lower().replace(" ", "_")

    base_filters: dict[str, Any] = {
        "date_from":        date_from,
        "date_to":          date_to,
        "account_ids":      None,
        "country":          country,
        "segment":          segment,
        "transaction_type": transaction_type,
        "window_days":      window_days,
    }

    # 0. Pure Aggregation query path ———————————————————————————————————————————
    # Matches: "which customers made 10+ transactions under $10,000",
    #          "count of transactions below 10k", "how many transactions"
    if re.search(r"(\d+\+\s+transactions|how\s+many\s+customers|count\s+of\s+txns|transactions\s+under\s+\$?\d+)", q):
        min_txns = 2
        count_match = re.search(r"(\d+)\+\s+transactions", q)
        if count_match:
            min_txns = int(count_match.group(1))

        return {
            "intent": "pure_aggregation",
            "filters": base_filters,
            "target_pattern": "structuring",
            "plan": [
                {"tool": "run_eda", "args": {}},
                {"tool": "detect_structuring", "args": {"window_days": window_days, "threshold": 10000.0}},
            ],
            "planner_source": "deterministic",
        }

# 1. Single-entity lookup —————————————————————————————————————————————————
    # Matches: "customer 1098", "account ACC_A", "explain ACC_A",
    #          "show customer 42", "investigate account XYZ-99"
    # Run on the ORIGINAL query (not q) to preserve case in the captured ID.
    # The optional second group handles "investigate account XYZ-99" so that
    # the first trigger word doesn't consume the second and skip the actual ID.
    entity_match = re.search(
        r"(?:customer|account|entity|explain|investigate)\s+"
        r"(?:(?:customer|account|entity|explain|investigate)\s+)?"
        r"([A-Za-z0-9_\-]+)",
        query,
        re.IGNORECASE,
    )
    if entity_match:
        entity_id = entity_match.group(1)
        return {
            "intent": "single_entity_lookup",
            "filters": {**base_filters, "account_ids": [entity_id]},
            "target_pattern": None,
            "plan": [
                {
                    "tool": "engineer_features",
                    "args": {"account_ids": [entity_id], "window_days": window_days, "persist": False},
                },
                {
                    "tool": "detect_anomalies",
                    "args": {"account_ids": [entity_id], "window_days": window_days},
                },
                {
                    "tool": "ml_risk_score",
                    "args": {"account_ids": [entity_id], "window_days": window_days, "top_n": 20},
                },
                {
                    "tool": "classify_risk",
                    "args": {"anomaly_output": None, "ml_output": None, "account_id": entity_id},
                },
                {
                    "tool": "shap_explain",
                    "args": {"account_ids": [entity_id], "window_days": window_days},
                },
                {
                    "tool": "explain_flag",
                    "args": {"classify_output": None, "account_id": entity_id},
                },
            ],
            "planner_source": "deterministic",
        }

    # 2. Smurfing ——————————————————————————————————————————————————————————————
    if re.search(
        r"smurf|fan[\s-]out|fan[\s-]in|multiple\s+sender|multiple\s+receiver"
        r"|multiple\s+accounts?",
        q,
    ):
        return {
            "intent": "pattern_scan",
            "filters": base_filters,
            "target_pattern": "smurfing",
            "plan": [
                {"tool": "run_eda",           "args": {}},
                {"tool": "engineer_features", "args": {"window_days": window_days, "persist": False}},
                {"tool": "detect_smurfing",   "args": {"window_days": window_days}},
                {"tool": "ml_risk_score",     "args": {"window_days": window_days, "top_n": 50}},
                {"tool": "classify_risk",     "args": {"smurfing_output": None, "ml_output": None}},
                {"tool": "shap_explain",      "args": {"account_ids": "from_ml_output", "window_days": window_days}},
                {"tool": "explain_flag",      "args": {"classify_output": None, "target_pattern": "smurfing"}},
            ],
            "planner_source": "deterministic",
        }

    # 3. Structuring ——————————————————————————————————————————————————————————
    if re.search(r"structur|threshold|cash\s+deposit|just\s+under|below\s+report|ctr\b", q):
        return {
            "intent": "pattern_scan",
            "filters": base_filters,
            "target_pattern": "structuring",
            "plan": [
                {"tool": "run_eda",            "args": {}},
                {"tool": "engineer_features",  "args": {"window_days": window_days, "persist": False}},
                {"tool": "detect_structuring", "args": {"window_days": window_days}},
                {"tool": "ml_risk_score",      "args": {"window_days": window_days, "top_n": 50}},
                {"tool": "classify_risk",      "args": {"structuring_output": None, "ml_output": None}},
                {"tool": "shap_explain",       "args": {"account_ids": "from_ml_output", "window_days": window_days}},
                {"tool": "explain_flag",       "args": {"classify_output": None, "target_pattern": "structuring"}},
            ],
            "planner_source": "deterministic",
        }

    # 4. Layering —————————————————————————————————————————————————————————————
    # \bhops? covers both "hop" and "hops"; word boundary before prevents false
    # matches on words like "shop".
    if re.search(
        r"layer|chain|multi[\s-]hop|\bhops?|intermediar|pass[\s-]through|obscur|network",
        q,
    ):
        return {
            "intent": "pattern_scan",
            "filters": base_filters,
            "target_pattern": "layering",
            "plan": [
                {"tool": "run_eda",           "args": {}},
                {"tool": "engineer_features", "args": {"window_days": window_days, "persist": False}},
                {"tool": "detect_layering",   "args": {"window_days": window_days}},
                {"tool": "detect_round_trips", "args": {"window_days": window_days, "min_hops": 3}},
                {"tool": "detect_cycles",     "args": {"window_days": window_days, "min_length": 3, "max_length": 8}},
                {"tool": "ml_risk_score",     "args": {"window_days": window_days, "top_n": 50}},
                {"tool": "classify_risk",     "args": {"layering_output": None, "ml_output": None}},
                {"tool": "shap_explain",      "args": {"account_ids": "from_ml_output", "window_days": window_days}},
                {"tool": "explain_flag",      "args": {"classify_output": None, "target_pattern": "layering"}},
            ],
            "planner_source": "deterministic",
        }

    # 5. Round-trip / cycle detection —————————————————————————————————————————————
    if re.search(r"round[\s-]?trip|circular|cycle|loop|return[\s-]?flow", q):
        return {
            "intent": "pattern_scan",
            "filters": base_filters,
            "target_pattern": "round_trip",
            "plan": [
                {"tool": "run_eda",           "args": {}},
                {"tool": "engineer_features", "args": {"window_days": window_days, "persist": False}},
                {"tool": "detect_round_trips", "args": {"window_days": window_days, "min_hops": 3}},
                {"tool": "detect_cycles",     "args": {"window_days": window_days, "min_length": 2, "max_length": 8}},
                {"tool": "ml_risk_score",     "args": {"window_days": window_days, "top_n": 50}},
                {"tool": "classify_risk",     "args": {"anomaly_output": None, "ml_output": None}},
                {"tool": "shap_explain",      "args": {"account_ids": "from_ml_output", "window_days": window_days}},
                {"tool": "explain_flag",      "args": {"classify_output": None, "target_pattern": "round_trip"}},
            ],
            "planner_source": "deterministic",
        }

    # 6. Generic catch-all ——————————————————————————————————————————————————
    return {
        "intent": "broad_exploration",
        "filters": base_filters,
        "target_pattern": None,
        "plan": [
            {"tool": "run_eda",            "args": {}},
            {"tool": "engineer_features",  "args": {"window_days": window_days, "persist": False}},
            {"tool": "detect_anomalies",   "args": {"window_days": window_days}},
            {"tool": "detect_cycles",      "args": {"window_days": window_days, "min_length": 2, "max_length": 6}},
            {"tool": "compute_pagerank",   "args": {"window_days": window_days, "top_n": 20}},
            {"tool": "ml_risk_score",      "args": {"window_days": window_days, "top_n": 50}},
            {"tool": "classify_risk",      "args": {"anomaly_output": None, "ml_output": None}},
            {"tool": "shap_explain",       "args": {"account_ids": "from_ml_output", "window_days": window_days}},
            {"tool": "explain_flag",       "args": {"classify_output": None}},
        ],
        "planner_source": "deterministic",
    }
