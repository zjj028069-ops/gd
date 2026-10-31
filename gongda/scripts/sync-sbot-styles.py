"""把 SEDRIC Bots 的设计（styles.css）同步到 MES 的 Bot 界面。

所有选择器都加上 `.sbx` 作用域，:root/html/body 映射到 `.sbx` 本身，动画名加 sbx- 前缀，
这样 SEDRIC Bots 的样式只作用在 Bot 界面里，不会影响 MES 原有页面。

用法（在 gongda 目录）：python scripts/sync-sbot-styles.py [../SEDRIC-Bots]
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BOTS = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else (ROOT.parent / "SEDRIC-Bots")
SRC = BOTS / "frontend" / "src" / "styles.css"
OUT = ROOT / "apps" / "web" / "src" / "modules" / "sbot" / "ui" / "sbx.css"
SCOPE = ".sbx"
# 与 MES 全局样式重名的 class（MES 里 .sidebar 是固定定位深色侧栏、.brand 是登录页标志），改名避免互相影响
RENAME = {"sidebar": "sbx-sidebar", "brand": "sbx-brand"}


def split_top(s: str, sep: str = ",") -> list[str]:
    out, depth, cur = [], 0, ""
    for ch in s:
        if ch in "([":
            depth += 1
        elif ch in ")]":
            depth -= 1
        if ch == sep and depth == 0:
            out.append(cur)
            cur = ""
        else:
            cur += ch
    out.append(cur)
    return [x.strip() for x in out if x.strip()]


def scope_selector(sel: str) -> str:
    sel = sel.strip()
    for old, new in RENAME.items():
        sel = re.sub(rf"\.{old}(?![\w-])", f".{new}", sel)
    dark = re.match(r"^:root\[data-theme=['\"]?dark['\"]?\]\s*(.*)$", sel)
    if dark:
        rest = dark.group(1)
        return f"{SCOPE}[data-theme='dark']" + (f" {rest}" if rest else "")
    if sel in (":root", "html", "body", "#root"):
        return SCOPE
    if sel == "*":
        return f"{SCOPE}, {SCOPE} *"
    m = re.match(r"^(html|body)\s+(.*)$", sel)
    if m:
        return f"{SCOPE} {m.group(2)}"
    return f"{SCOPE} {sel}"


def parse_blocks(css: str):
    """Yield (prelude, body) for top-level blocks; body may contain nested blocks."""
    i, n = 0, len(css)
    while i < n:
        j = css.find("{", i)
        if j < 0:
            break
        prelude = css[i:j].strip()
        depth, k = 1, j + 1
        while k < n and depth:
            if css[k] == "{":
                depth += 1
            elif css[k] == "}":
                depth -= 1
            k += 1
        yield prelude, css[j + 1:k - 1]
        i = k


def transform(css: str, keyframes: set[str]) -> str:
    out = []
    for prelude, body in parse_blocks(css):
        prelude = re.sub(r"/\*.*?\*/", "", prelude, flags=re.S).strip()
        if prelude.startswith("@keyframes"):
            name = prelude.split()[1]
            out.append(f"@keyframes sbx-{name} {{{body}}}")
        elif prelude.startswith(("@media", "@supports")):
            out.append(f"{prelude} {{\n{transform(body, keyframes)}\n}}")
        elif prelude.startswith("@"):
            out.append(f"{prelude} {{{body}}}")
        else:
            sels = ", ".join(scope_selector(s) for s in split_top(prelude))
            def rename(m: re.Match) -> str:
                return re.sub(r"(?<![\w-])([\w-]+)(?![\w-])",
                              lambda t: f"sbx-{t.group(1)}" if t.group(1) in keyframes else t.group(1), m.group(0))
            body = re.sub(r"animation(?:-name)?\s*:[^;}]*", rename, body)
            out.append(f"{sels} {{{body}}}")
    return "\n".join(out)


def main() -> None:
    css = SRC.read_text(encoding="utf-8")
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    keyframes = set(re.findall(r"@keyframes\s+([\w-]+)", css))
    body = transform(css, keyframes)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("/* 自动生成：scripts/sync-sbot-styles.py ← SEDRIC-Bots/frontend/src/styles.css，请不要手改 */\n" + body + "\n",
                   encoding="utf-8")
    print(f"wrote {OUT} ({len(body)} chars, {len(keyframes)} keyframes)")


if __name__ == "__main__":
    main()
