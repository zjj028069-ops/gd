"""赛德瑞克操作说明书：按「章 → 节」切块，给业务助手检索用。

只读一份固定的文本文件（manual/sedric-manual.txt），不碰业务数据。
检索用中文二字词重叠打分，够用且不需要额外依赖。换新版说明书时，
把新文本覆盖这个文件即可（每章以「第 NN 章」开头，每节以「一、」这类序号开头）。"""
from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

MANUAL = Path(__file__).parent / "manual" / "sedric-manual.txt"
CHAPTER_RE = re.compile(r"^第 ?(\d{2}) ?章\s*(.+)$")
SECTION_RE = re.compile(r"^[一二三四五六七八九十]{1,3}、.+")
CHUNK_MAX = 2600


@lru_cache(maxsize=1)
def chunks() -> list[dict[str, str]]:
    if not MANUAL.exists():
        return []
    out: list[dict[str, str]] = []
    chapter, section, buf = "前言", "", []

    def flush() -> None:
        body = "\n".join(buf).strip()
        if body:
            title = f"{chapter} · {section}" if section else chapter
            for i in range(0, len(body), CHUNK_MAX):
                out.append({"title": title + (f"（续{i // CHUNK_MAX}）" if i else ""), "text": body[i:i + CHUNK_MAX]})
        buf.clear()

    for line in MANUAL.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        m = CHAPTER_RE.match(s)
        if m:
            flush()
            chapter, section = f"第{m.group(1)}章 {m.group(2).strip()}", ""
            continue
        if SECTION_RE.match(s) and len(s) < 40:
            flush()
            section = s
            continue
        buf.append(line)
    flush()
    return out


def _grams(text: str) -> set[str]:
    t = re.sub(r"[\s，。、：；「」『』（）()《》“”,.:;!?！？\-—·]+", "", text.lower())
    return {t[i:i + 2] for i in range(len(t) - 1)} | set(re.findall(r"[a-z0-9]+", text.lower()))


def search(query: str, limit: int = 3) -> list[dict[str, str]]:
    q = _grams(query)
    if not q:
        return []
    scored = []
    for c in chunks():
        title_g = _grams(c["title"])
        body_g = _grams(c["text"])
        score = len(q & body_g) + 3 * len(q & title_g)
        if score:
            scored.append((score, c))
    scored.sort(key=lambda x: -x[0])
    return [c for _, c in scored[:limit]]


@lru_cache(maxsize=1)
def table_of_contents() -> str:
    seen: list[str] = []
    for c in chunks():
        ch = c["title"].split(" · ")[0]
        if ch not in seen:
            seen.append(ch)
    return "、".join(seen)
