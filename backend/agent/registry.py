"""
Tool registry — the single source of truth for all FinSherlock tools.

Three consumers share one registration:
  1. LLM planner — gets JSON function-calling schemas via `get_llm_tool_schemas()`
  2. FastAPI router — auto-generates a POST /tools/{name} endpoint per tool
  3. pytest — iterates TOOL_REGISTRY to exercise every tool with a sample payload

Usage
-----
from agent.registry import tool, TOOL_REGISTRY

@tool(
    name="my_tool",
    description="Does something useful",
    schema=MyArgsModel,
)
def my_tool(args: MyArgsModel) -> dict:
    ...
"""

from __future__ import annotations

import inspect
import json
import logging
from typing import Any, Callable

from pydantic import BaseModel

logger = logging.getLogger(__name__)

# Central registry: name → {fn, description, schema (Pydantic model class)}
TOOL_REGISTRY: dict[str, dict[str, Any]] = {}


def tool(name: str, description: str, schema: type[BaseModel]) -> Callable:
    """
    Decorator that registers a function as a callable tool.

    Parameters
    ----------
    name:        Unique tool identifier (used as the function-calling name and URL slug)
    description: One-line description surfaced to the LLM and Swagger UI
    schema:      Pydantic BaseModel class whose fields define the tool's arguments
    """
    def decorator(fn: Callable) -> Callable:
        if name in TOOL_REGISTRY:
            raise ValueError(f"Tool '{name}' is already registered.")

        TOOL_REGISTRY[name] = {
            "fn": fn,
            "description": description,
            "schema": schema,
        }
        logger.debug("Registered tool: %s", name)
        return fn

    return decorator


def call_tool(name: str, raw_args: dict[str, Any]) -> dict[str, Any]:
    """
    Execute a registered tool by name, validating args through its Pydantic schema.

    Raises KeyError if the tool is not registered.
    Raises pydantic.ValidationError if args don't match the schema.
    """
    if name not in TOOL_REGISTRY:
        raise KeyError(f"Unknown tool: '{name}'. Registered: {list(TOOL_REGISTRY)}")

    entry = TOOL_REGISTRY[name]
    args_model: BaseModel = entry["schema"](**raw_args)
    return entry["fn"](args_model)


def get_llm_tool_schemas() -> list[dict]:
    """
    Return OpenAI-compatible function-calling schemas for every registered tool.
    Feed this directly into litellm / openai SDK `tools=` parameter.
    """
    schemas = []
    for name, entry in TOOL_REGISTRY.items():
        pydantic_schema = entry["schema"].model_json_schema()
        # OpenAI function-calling format
        schemas.append({
            "type": "function",
            "function": {
                "name": name,
                "description": entry["description"],
                "parameters": pydantic_schema,
            },
        })
    return schemas


def list_tools() -> list[dict[str, str]]:
    """Return a lightweight summary of registered tools (name + description)."""
    return [
        {"name": name, "description": entry["description"]}
        for name, entry in TOOL_REGISTRY.items()
    ]
