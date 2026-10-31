"""In-process event bus. Every UI client holds one SSE stream; the backend
publishes small typed events and the client refetches or patches state."""
from __future__ import annotations

import asyncio
import json
from typing import Any


class EventBus:
    def __init__(self) -> None:
        self._subs: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=5000)
        self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subs.discard(q)

    def publish(self, type_: str, **data: Any) -> None:
        payload = json.dumps({"type": type_, **data}, ensure_ascii=False, default=str)
        for q in list(self._subs):
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                # A stalled client loses events rather than blocking everyone; it
                # resyncs on reconnect.
                self._subs.discard(q)


bus = EventBus()


def toast(text: str, level: str = "info") -> None:
    bus.publish("toast", text=text, level=level)
