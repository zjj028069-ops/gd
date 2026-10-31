"""Tool registry. A tool = OpenAI function schema + async handler(ctx, args) -> str.
Each tool belongs to a toolset the bot can switch on or off."""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

Handler = Callable[["ToolCtx", dict[str, Any]], Awaitable[str]]


@dataclass
class Tool:
    name: str
    toolset: str
    description: str
    parameters: dict[str, Any]
    handler: Handler
    # Only offered when this returns True for the context (e.g. message_agent
    # is not offered inside group-room sessions).
    available: Callable[["ToolCtx"], bool] | None = None

    def schema(self) -> dict[str, Any]:
        return {"type": "function", "function": {"name": self.name, "description": self.description,
                                                 "parameters": self.parameters}}


@dataclass
class ToolCtx:
    bot: str
    profile: dict[str, Any]
    session: dict[str, Any]
    meta: dict[str, Any]
    runtime: Any
    cancel: asyncio.Event
    call_id: str = ""
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def kind(self) -> str:
        return self.session.get("kind", "chat")

    async def approve(self, title: str, detail: str) -> bool:
        return await self.runtime.request_approval(self, title, detail)

    async def clarify(self, question: str, choices: list[str]) -> str:
        return await self.runtime.request_clarify(self, question, choices)


REGISTRY: dict[str, Tool] = {}


def register(tool: Tool) -> Tool:
    REGISTRY[tool.name] = tool
    return tool


def obj(props: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {"type": "object", "properties": props, "required": required or []}


def ok(data: Any) -> str:
    return data if isinstance(data, str) else json.dumps(data, ensure_ascii=False)


def err(message: str) -> str:
    return json.dumps({"error": message}, ensure_ascii=False)


def load_all() -> None:
    # Import for side effects (each module registers its tools).
    from . import clarify, cron_tool, files, memory_tool, messaging, skills_tool, terminal, web  # noqa: F401
