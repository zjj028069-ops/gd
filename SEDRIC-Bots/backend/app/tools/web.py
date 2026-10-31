"""web_search (Bing / DuckDuckGo HTML, no key needed) and web_fetch."""
from __future__ import annotations

import html
import re
from typing import Any
from urllib.parse import parse_qs, quote_plus, unquote, urlparse

import httpx

from ..storage import truncate
from . import Tool, ToolCtx, err, obj, ok, register

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/126.0 Safari/537.36")


def html_to_text(raw: str) -> str:
    raw = re.sub(r"(?is)<(script|style|noscript|svg|head)[^>]*>.*?</\1>", " ", raw)
    raw = re.sub(r"(?i)<br\s*/?>|</(p|div|li|h[1-6]|tr|section|article)>", "\n", raw)
    raw = re.sub(r"(?s)<[^>]+>", " ", raw)
    text = html.unescape(raw)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return text.strip()


def _strip(s: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", s or "")).strip()


async def _bing(client: httpx.AsyncClient, q: str) -> list[dict[str, str]]:
    r = await client.get(f"https://cn.bing.com/search?q={quote_plus(q)}&ensearch=0")
    out = []
    for block in re.findall(r'(?s)<li class="b_algo".*?</li>', r.text):
        a = re.search(r'(?s)<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', block)
        if not a:
            continue
        snip = re.search(r'(?s)<p[^>]*>(.*?)</p>', block)
        out.append({"title": _strip(a.group(2)), "url": html.unescape(a.group(1)), "snippet": _strip(snip.group(1) if snip else "")})
    return out


async def _ddg(client: httpx.AsyncClient, q: str) -> list[dict[str, str]]:
    r = await client.post("https://html.duckduckgo.com/html/", data={"q": q})
    out = []
    for m in re.finditer(r'(?s)<a rel="nofollow" class="result__a" href="([^"]+)">(.*?)</a>.*?class="result__snippet"[^>]*>(.*?)</a>', r.text):
        url = html.unescape(m.group(1))
        if "uddg=" in url:
            url = unquote(parse_qs(urlparse(url).query).get("uddg", [url])[0])
        out.append({"title": _strip(m.group(2)), "url": url, "snippet": _strip(m.group(3))})
    return out


async def web_search(ctx: ToolCtx, args: dict[str, Any]) -> str:
    q = (args.get("query") or "").strip()
    if not q:
        return err("query 不能为空")
    n = max(1, min(int(args.get("max_results") or 8), 15))
    errors = []
    async with httpx.AsyncClient(timeout=15, headers={"User-Agent": UA}, follow_redirects=True, trust_env=True) as c:
        for engine in (_bing, _ddg):
            try:
                res = await engine(c, q)
                if res:
                    return ok({"query": q, "engine": engine.__name__.strip("_"), "results": res[:n]})
            except httpx.HTTPError as e:
                errors.append(f"{engine.__name__}: {e}")
    return err("搜索没有结果或搜索引擎不可达。" + ("; ".join(errors)))


async def web_fetch(ctx: ToolCtx, args: dict[str, Any]) -> str:
    url = (args.get("url") or "").strip()
    if not url.startswith(("http://", "https://")):
        return err("url 必须以 http(s):// 开头")
    try:
        async with httpx.AsyncClient(timeout=25, headers={"User-Agent": UA}, follow_redirects=True, trust_env=True) as c:
            r = await c.get(url)
    except httpx.HTTPError as e:
        return err(f"抓取失败：{type(e).__name__} {e}".strip())
    ctype = r.headers.get("content-type", "")
    if "html" in ctype:
        title = re.search(r"(?is)<title[^>]*>(.*?)</title>", r.text)
        text = html_to_text(r.text)
        head = f"# {_strip(title.group(1))}\n\n" if title else ""
    elif "json" in ctype or "text" in ctype or "xml" in ctype:
        text, head = r.text, ""
    else:
        return ok({"status": r.status_code, "content_type": ctype, "bytes": len(r.content), "note": "非文本内容，未展示"})
    limit = max(1000, min(int(args.get("max_chars") or 15000), 60000))
    return f"[{r.status_code}] {r.url}\n\n" + truncate(head + text, limit)


register(Tool("web_search", "web", "联网搜索，返回标题、链接和摘要。需要最新信息时使用。",
              obj({"query": {"type": "string"}, "max_results": {"type": "integer"}}, ["query"]), web_search))
register(Tool("web_fetch", "web", "抓取一个网页并转成纯文本。",
              obj({"url": {"type": "string"}, "max_chars": {"type": "integer"}}, ["url"]), web_fetch))
