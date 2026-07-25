"""
Orchestrator — executes a planner-produced execution plan step by step.

Design choices:
  - Steps run sequentially (order matters: EDA before feature engineering).
  - Each step's output is keyed by tool name in the results dict.
  - Tool errors are captured per-step and do NOT abort the whole plan, so a
    single failing tool still lets other steps complete and lets the UI show
    partial results rather than a blank page.
  - The orchestrator never calls the LLM directly — it only routes plan steps
    to call_tool() from the registry.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from agent.registry import call_tool

logger = logging.getLogger(__name__)


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
