"""
Orchestrator — executes a planner-produced execution plan step by step.

Design choices:
  - Steps run sequentially (order matters: EDA → features → detection → classify → explain).
  - Each step's output is keyed by tool name in the accumulated results dict.
  - Result injection: tools that declare placeholder injection fields
    (structuring_output, anomaly_output, classify_output) have those fields
    filled from prior step results before the tool is called.  The plan JSON
    stores null for these; the orchestrator wires them at runtime.
  - Tool errors are captured per-step and do NOT abort the whole plan.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Generator

from agent.registry import call_tool

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Result injection table
# ---------------------------------------------------------------------------
# Maps: arg field name → the tool whose result should be injected there.
# A step's args dict may contain any of these keys with value None;
# the orchestrator replaces None with the accumulated result of the named tool
# (if that tool has already run in this plan execution).

_INJECT: dict[str, str] = {
    "structuring_output": "detect_structuring",
    "anomaly_output":     "detect_anomalies",
    "smurfing_output":    "detect_smurfing",
    "layering_output":    "detect_layering",
    "ml_risk_output":     "ml_risk_score",
    "classify_output":    "classify_risk",
}

# Placeholder strings that should be resolved from prior tool results.
# Maps: placeholder string → (source_tool, extractor_lambda)
_PLACEHOLDER_RESOLVERS: dict[str, tuple[str, callable]] = {
    "from_ml_output": (
        "ml_risk_score",
        lambda result: [a["account_id"] for a in result.get("scored_accounts", []) if "account_id" in a],
    ),
}


def _inject_results(step_args: dict[str, Any], accumulated: dict[str, Any]) -> dict[str, Any]:
    """
    Return a copy of step_args with injection placeholders replaced by
    the corresponding accumulated tool result, if available.

    Two mechanisms:
      1. None-valued fields in _INJECT → filled from the named tool's full result.
      2. String placeholders in args values → resolved via _PLACEHOLDER_RESOLVERS.
    """
    args = dict(step_args)

    # Mechanism 1: None-valued injection fields
    for field, source_tool in _INJECT.items():
        if field in args and args[field] is None and source_tool in accumulated:
            args[field] = accumulated[source_tool]
            logger.debug("  injected %s from %s", field, source_tool)

    # Mechanism 2: String placeholders in arg values
    for key, value in args.items():
        if isinstance(value, str) and value in _PLACEHOLDER_RESOLVERS:
            source_tool, extractor = _PLACEHOLDER_RESOLVERS[value]
            if source_tool in accumulated:
                resolved = extractor(accumulated[source_tool])
                args[key] = resolved
                logger.debug("  resolved placeholder '%s' for arg %s → %d items from %s", value, key, len(resolved), source_tool)

    return args


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def execute_plan(plan: dict[str, Any]) -> dict[str, Any]:
    """
    Execute each step in plan["plan"] via the tool registry.

    Parameters
    ----------
    plan : dict
        Output of call_planner() — must contain a "plan" key with a list of
        {"tool": str, "args": dict} step dicts.

    Returns
    -------
    dict with keys:
      "plan"    — the original plan (echoed for frontend rendering)
      "results" — {tool_name: result_or_error_dict} for each step executed
      "timing"  — {tool_name: elapsed_seconds} per step
      "errors"  — list of tool names that failed (empty if all succeeded)
    """
    steps: list[dict] = plan.get("plan", [])
    results: dict[str, Any] = {}
    timing:  dict[str, float] = {}
    errors:  list[str] = []

    logger.info(
        "Executing plan: intent=%s, pattern=%s, steps=%d",
        plan.get("intent"),
        plan.get("target_pattern"),
        len(steps),
    )

    for step in steps:
        tool_name: str = step.get("tool", "")
        args: dict    = step.get("args", {})

        if not tool_name:
            logger.warning("Skipping plan step with missing 'tool' key: %s", step)
            continue

        # Inject results from prior steps into placeholder fields
        args = _inject_results(args, results)

        t0 = time.monotonic()
        try:
            logger.info("  → running tool: %s", tool_name)
            result = call_tool(tool_name, args)
            results[tool_name] = result
            logger.info("  ✓ %s completed", tool_name)
        except Exception as exc:
            logger.warning("  ✗ %s failed: %s", tool_name, exc)
            results[tool_name] = {
                "error":     str(exc),
                "tool":      tool_name,
                "args_used": args,
            }
            errors.append(tool_name)
        finally:
            timing[tool_name] = round(time.monotonic() - t0, 3)

    return {
        "plan":    plan,
        "results": results,
        "timing":  timing,
        "errors":  errors,
    }


def execute_plan_stream(plan: dict[str, Any]) -> Generator[str, None, None]:
    """
    Execute each plan step and yield SSE-formatted strings as each tool completes.

    Event types emitted:
      {"type": "plan",       "plan": dict}
      {"type": "tool_start", "tool": str}
      {"type": "tool_done",  "tool": str, "result": dict, "elapsed": float}
      {"type": "tool_error", "tool": str, "error": str,   "elapsed": float}
      {"type": "complete",   "errors": list, "timing": dict}
    """

    def sse(data: dict) -> str:
        return f"data: {json.dumps(data)}\n\n"

    steps:   list[dict]        = plan.get("plan", [])
    results: dict[str, Any]    = {}
    timing:  dict[str, float]  = {}
    errors:  list[str]         = []

    logger.info(
        "Streaming plan: intent=%s, pattern=%s, steps=%d",
        plan.get("intent"),
        plan.get("target_pattern"),
        len(steps),
    )

    yield sse({"type": "plan", "plan": plan})

    for step in steps:
        tool_name: str = step.get("tool", "")
        args: dict     = step.get("args", {})

        if not tool_name:
            continue

        args = _inject_results(args, results)
        yield sse({"type": "tool_start", "tool": tool_name})

        t0 = time.monotonic()
        try:
            logger.info("  → running tool: %s", tool_name)
            result = call_tool(tool_name, args)
            results[tool_name] = result
            elapsed = round(time.monotonic() - t0, 3)
            timing[tool_name]  = elapsed
            logger.info("  ✓ %s completed in %.3fs", tool_name, elapsed)
            yield sse({"type": "tool_done", "tool": tool_name,
                       "result": result, "elapsed": elapsed})
        except Exception as exc:
            elapsed = round(time.monotonic() - t0, 3)
            timing[tool_name]  = elapsed
            results[tool_name] = {"error": str(exc), "tool": tool_name}
            errors.append(tool_name)
            logger.warning("  ✗ %s failed: %s", tool_name, exc)
            yield sse({"type": "tool_error", "tool": tool_name,
                       "error": str(exc), "elapsed": elapsed})

    yield sse({"type": "complete", "errors": errors, "timing": timing})
