"""LLM access: one streaming chat call against any OpenAI-compatible endpoint,
plus a built-in mock provider so the whole app works without an API key."""
from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import httpx

from .settings import provider_key

OnEvent = Callable[[str, str], Awaitable[None] | None]


class LLMError(Exception):
    """kind: auth | quota | rate | config | network | other"""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind
        self.message = message


@dataclass
class ChatResult:
    content: str = ""
    reasoning: str = ""
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    finish_reason: str = ""
    usage: dict[str, Any] = field(default_factory=dict)
    cancelled: bool = False


class ThinkSplitter:
    """Routes inline <think>…</think> spans (MiniMax, Qwen, DeepSeek-R1 distills)
    to the reasoning channel while streaming."""

    def __init__(self) -> None:
        self.buf = ""
        self.in_think = False

    def feed(self, text: str) -> list[tuple[str, str]]:
        self.buf += text
        out: list[tuple[str, str]] = []
        while self.buf:
            tag = "</think>" if self.in_think else "<think>"
            idx = self.buf.find(tag)
            if idx >= 0:
                if idx:
                    out.append(("reasoning" if self.in_think else "text", self.buf[:idx]))
                self.buf = self.buf[idx + len(tag):]
                self.in_think = not self.in_think
                continue
            # Hold back a possible partial tag at the end.
            keep = 0
            for k in range(1, len(tag)):
                if self.buf.endswith(tag[:k]):
                    keep = k
            emit = self.buf[: len(self.buf) - keep]
            if emit:
                out.append(("reasoning" if self.in_think else "text", emit))
            self.buf = self.buf[len(self.buf) - keep:]
            break
        return out

    def flush(self) -> list[tuple[str, str]]:
        if not self.buf:
            return []
        rest, self.buf = self.buf, ""
        return [("reasoning" if self.in_think else "text", rest)]


async def _emit(on_event: OnEvent | None, kind: str, text: str) -> None:
    if on_event and text:
        r = on_event(kind, text)
        if asyncio.iscoroutine(r):
            await r


def _classify(status: int, body: str) -> LLMError:
    low = body.lower()
    msg = body.strip()[:500] or f"HTTP {status}"
    if status in (401, 403):
        return LLMError("auth", f"认证失败（{status}）：API Key 无效或无权限。{msg}")
    if status == 402 or re.search(r"insufficient|quota|balance|余额|credit", low):
        return LLMError("quota", f"额度或余额不足：{msg}")
    if status == 429:
        return LLMError("rate", f"请求过于频繁（429）：{msg}")
    if status in (400, 404) and re.search(r"model", low):
        return LLMError("config", f"模型配置有误：{msg}")
    return LLMError("other", f"模型接口出错（{status}）：{msg}")


async def chat(
    provider: dict[str, Any] | None,
    model: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
    on_event: OnEvent | None = None,
    cancel: asyncio.Event | None = None,
    temperature: float | None = None,
) -> ChatResult:
    if provider is None or not model:
        raise LLMError("config", "还没有配置可用的模型。请在「设置 → 模型」里添加提供商。")
    if provider["id"] == "mock":
        return await mock_chat(messages, tools or [], on_event, cancel)
    base = provider.get("base_url") or ""
    if not base.startswith("http"):
        raise LLMError("config", f"提供商「{provider.get('name')}」的 Base URL 无效。")
    key = provider_key(provider)
    headers = {"Content-Type": "application/json", **(provider.get("extra_headers") or {})}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    body: dict[str, Any] = {"model": model, "messages": messages, "stream": True}
    if tools:
        body["tools"] = tools
    if temperature is not None:
        body["temperature"] = temperature

    result = ChatResult()
    calls: dict[int, dict[str, Any]] = {}
    splitter = ThinkSplitter()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(600, connect=20), trust_env=True) as client:
            async with client.stream("POST", f"{base}/chat/completions", json=body, headers=headers) as r:
                if r.status_code >= 400:
                    raise _classify(r.status_code, (await r.aread()).decode("utf-8", "replace"))
                async for line in r.aiter_lines():
                    if cancel is not None and cancel.is_set():
                        result.cancelled = True
                        break
                    line = line.strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        obj = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    if obj.get("error"):
                        err = obj["error"]
                        raise _classify(int(err.get("code") or 500) if str(err.get("code", "")).isdigit() else 500,
                                        json.dumps(err, ensure_ascii=False))
                    if obj.get("usage"):
                        result.usage = obj["usage"]
                    choices = obj.get("choices") or []
                    if not choices:
                        continue
                    ch = choices[0]
                    delta = ch.get("delta") or ch.get("message") or {}
                    rs = delta.get("reasoning_content") or delta.get("reasoning")
                    if isinstance(rs, str) and rs:
                        result.reasoning += rs
                        await _emit(on_event, "reasoning", rs)
                    content = delta.get("content")
                    if isinstance(content, str) and content:
                        for kind, piece in splitter.feed(content):
                            if kind == "text":
                                result.content += piece
                            else:
                                result.reasoning += piece
                            await _emit(on_event, kind, piece)
                    for tc in delta.get("tool_calls") or []:
                        idx = tc.get("index", 0)
                        slot = calls.setdefault(idx, {"id": "", "type": "function", "function": {"name": "", "arguments": ""}})
                        if tc.get("id"):
                            slot["id"] = tc["id"]
                        fn = tc.get("function") or {}
                        if fn.get("name"):
                            slot["function"]["name"] += fn["name"]
                        if fn.get("arguments"):
                            slot["function"]["arguments"] += fn["arguments"]
                    if ch.get("finish_reason"):
                        result.finish_reason = ch["finish_reason"]
    except LLMError:
        raise
    except httpx.HTTPError as e:
        raise LLMError("network", f"无法连接模型接口「{provider.get('name')}」（{base}）：{type(e).__name__} {e}".strip()) from e
    for kind, piece in splitter.flush():
        if kind == "text":
            result.content += piece
        else:
            result.reasoning += piece
        await _emit(on_event, kind, piece)
    for i, (_, c) in enumerate(sorted(calls.items())):
        if not c["id"]:
            c["id"] = f"call_{i}_{abs(hash(c['function']['name'])) % 10_000}"
        if c["function"]["name"]:
            result.tool_calls.append(c)
    return result


async def list_models(provider: dict[str, Any]) -> list[str]:
    if provider["id"] == "mock":
        return ["mock-agent"]
    key = provider_key(provider)
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    async with httpx.AsyncClient(timeout=20, trust_env=True) as client:
        r = await client.get(f"{provider['base_url']}/models", headers=headers)
        if r.status_code >= 400:
            raise _classify(r.status_code, r.text)
        data = r.json()
    items = data.get("data") if isinstance(data, dict) else data
    return sorted({(m.get("id") if isinstance(m, dict) else str(m)) for m in (items or []) if m})


# ── mock provider ────────────────────────────────────────────────────────────


def _text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    return ""


def _tool_call(name: str, args: dict[str, Any]) -> dict[str, Any]:
    return {"id": f"mock_{name}_{abs(hash(json.dumps(args, ensure_ascii=False))) % 100000}", "type": "function",
            "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}


async def mock_chat(messages, tools, on_event, cancel) -> ChatResult:
    """Deterministic stand-in for a model. Exercises every flow (tools, DMs,
    group rounds, routines) so the app can be tried before adding a key."""
    system = _text_of(messages[0]["content"]) if messages and messages[0]["role"] == "system" else ""
    m = re.search(r"（@([a-z0-9_-]+)）", system)
    me = m.group(1) if m else "bot"
    t = re.search(r"显示名称：(.+)", system)
    title = t.group(1).strip() if t else me
    d = re.search(r"职责描述：(.+)", system)
    desc = d.group(1).strip() if d else ""
    tool_names = {tl["function"]["name"] for tl in tools}
    last = messages[-1] if messages else {"role": "user", "content": ""}
    res = ChatResult(finish_reason="stop")

    if last["role"] == "tool":
        name = last.get("name") or ""
        for prev in reversed(messages):
            for c in prev.get("tool_calls") or []:
                if c["id"] == last.get("tool_call_id"):
                    name = c["function"]["name"]
        content = _text_of(last.get("content"))
        if name == "message_agent":
            text = "消息已经发出去了，对方回复后我会第一时间转告你。"
        elif name == "clarify":
            text = f"明白了，你的选择是：{content}。我会按这个来。"
        else:
            text = f"工具 `{name}` 执行完成，结果如下：\n\n```\n{content[:600]}\n```"
    else:
        u = _text_of(last.get("content")).strip()
        text = ""
        if u.startswith("[群聊"):
            lines = [ln.strip() for ln in u.split("\n") if ln.startswith("  ")]
            mentioned = any(f"@{me}" in ln for ln in lines if "(you)" not in ln)
            others_spoke = any(not re.match(r"^\S.* \(user\):", ln) and "(you)" not in ln and not ln.startswith("…") for ln in lines)
            nudge = "cannot be passed" in u or "不能 pass" in u
            last_user = next((ln for ln in reversed(lines) if "(user):" in ln), "")
            if "让我选" in last_user and "clarify" in tool_names and not any(
                    m.get("role") == "tool" for m in messages[-3:]):
                res.tool_calls = [_tool_call("clarify", {"question": "你更喜欢哪个方案？", "choices": ["方案 A", "方案 B"]})]
                res.finish_reason = "tool_calls"
                return res
            if nudge or mentioned or not others_spoke:
                user_line = next((ln for ln in reversed(lines) if "(user):" in ln), lines[-1] if lines else "")
                topic = user_line.split(":", 1)[-1].strip()[:60]
                text = f"我是 {title}，关于「{topic}」，我的看法是：可以先拆成小步骤推进。"
            else:
                text = "(pass)"
        elif u.startswith("Message from 🤖"):
            body = u.split(":", 1)[-1].strip()
            text = f"收到！我是 {title}。关于「{body[:80]}」：这是我（演示模式）的回复，已经记下了。"
        elif u.startswith("[message_agent 回执]"):
            text = "我的队友回复了：\n\n" + u.split("\n", 1)[-1].strip()
        elif u.startswith("[定时任务"):
            text = f"定时任务执行完毕（演示模式）。任务内容：{u.split(chr(10), 1)[-1].strip()[:100]}"
        elif "介绍一下你自己" in u:
            text = f"大家好，我是 **{title}**（@{me}）。" + (f"我的职责是：{desc}。" if desc else "") + "\n\n有事随时找我，也可以在群聊里 @我。"
        else:
            g = re.search(r"(告诉|问问|通知|让)\s*@([a-z0-9_-]+)\s*(.*)", u)
            mcp_m = re.search(r"调用\s*(mcp_[\w-]+)\s*(\{.*\})?", u, re.S)
            file_w = re.match(r"^写文件\s+(\S+)\s+(.+)$", u, re.S)
            file_r = re.match(r"^读取文件\s+(\S+)", u)
            bg = re.match(r"^后台运行\s+(.+)$", u)
            if mcp_m and mcp_m.group(1) in tool_names:
                try:
                    margs = json.loads(mcp_m.group(2) or "{}")
                except json.JSONDecodeError:
                    margs = {}
                res.tool_calls = [_tool_call(mcp_m.group(1), margs)]
            elif file_w and "write_file" in tool_names:
                res.tool_calls = [_tool_call("write_file", {"path": file_w.group(1), "content": file_w.group(2)})]
            elif file_r and "read_file" in tool_names:
                res.tool_calls = [_tool_call("read_file", {"path": file_r.group(1)})]
            elif bg and "terminal" in tool_names:
                res.tool_calls = [_tool_call("terminal", {"command": bg.group(1), "background": True})]
            elif g and "message_agent" in tool_names:
                res.tool_calls = [_tool_call("message_agent", {"target": g.group(2), "message": g.group(3) or "你好！"})]
            elif (g := re.match(r"^(运行|执行|\$)\s*(.+)", u)) and "terminal" in tool_names:
                res.tool_calls = [_tool_call("terminal", {"command": g.group(2)})]
            elif (g := re.search(r"记住(.+)", u)) and "memory" in tool_names:
                res.tool_calls = [_tool_call("memory", {"action": "add", "target": "memory", "content": g.group(1).strip("：: ")})]
            elif (g := re.search(r"每\s*(\d+)\s*(分钟|小时)\s*(.+)", u)) and "cronjob" in tool_names:
                unit = "m" if g.group(2) == "分钟" else "h"
                res.tool_calls = [_tool_call("cronjob", {"action": "create", "name": g.group(3)[:20],
                                                         "schedule": f"every {g.group(1)}{unit}", "instruction": g.group(3)})]
            elif ("让我选" in u or "问我" in u) and "clarify" in tool_names:
                res.tool_calls = [_tool_call("clarify", {"question": "你更喜欢哪个方案？", "choices": ["方案 A", "方案 B"]})]
            elif (g := re.search(r"(搜索|查一下)\s*(.+)", u)) and "web_search" in tool_names:
                res.tool_calls = [_tool_call("web_search", {"query": g.group(2)})]
            else:
                text = (f"你好，我是 {title}（演示模式）。收到你的消息：「{u[:80]}」\n\n"
                        "试试这些指令：`运行 dir`、`记住 我喜欢喝茶`、`告诉 @某个bot 你好`、`每 5 分钟 喝水提醒`、`让我选`。\n"
                        "在左下角「设置 → 模型」里配置真实模型后，我就能真正思考了。")
        if res.tool_calls:
            res.finish_reason = "tool_calls"
            await _emit(on_event, "reasoning", "（演示模式）决定调用工具…")
            return res
    for i in range(0, len(text), 3):
        if cancel is not None and cancel.is_set():
            res.cancelled = True
            break
        piece = text[i:i + 3]
        res.content += piece
        await _emit(on_event, "text", piece)
        await asyncio.sleep(0.012)
    return res
