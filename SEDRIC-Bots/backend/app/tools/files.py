"""File tools: read / write / patch / list / search, rooted at the bot's workspace."""
from __future__ import annotations

import fnmatch
import os
import re
from pathlib import Path
from typing import Any

from ..storage import truncate
from . import Tool, ToolCtx, err, obj, ok, register
from .terminal import approval_mode, workspace


def resolve(ctx: ToolCtx, path: str) -> Path:
    p = Path(os.path.expanduser(path or "."))
    return p if p.is_absolute() else (workspace(ctx) / p)


def _inside(ctx: ToolCtx, p: Path) -> bool:
    try:
        p.resolve().relative_to(workspace(ctx).resolve())
        return True
    except ValueError:
        return False


async def _guard_write(ctx: ToolCtx, p: Path, what: str) -> str | None:
    mode = approval_mode(ctx)
    if mode == "auto":
        return None
    if mode == "always" or not _inside(ctx, p):
        if not await ctx.approve(what, str(p)):
            return err("用户拒绝了这次写入。")
    return None


async def read_file(ctx: ToolCtx, args: dict[str, Any]) -> str:
    p = resolve(ctx, args.get("path", ""))
    if not p.exists():
        return err(f"文件不存在：{p}")
    if p.is_dir():
        return err("这是一个目录，请用 list_dir")
    data = p.read_bytes()
    if b"\x00" in data[:4096]:
        return err(f"二进制文件（{len(data)} 字节），无法按文本读取")
    text = data.decode("utf-8", "replace")
    lines = text.splitlines()
    offset = max(1, int(args.get("offset") or 1))
    limit = max(1, min(int(args.get("limit") or 500), 2000))
    chunk = lines[offset - 1: offset - 1 + limit]
    body = "\n".join(f"{i + offset:>5}| {ln}" for i, ln in enumerate(chunk))
    more = len(lines) - (offset - 1 + len(chunk))
    return truncate(body, 40000) + (f"\n… 还有 {more} 行（用 offset 继续读）" if more > 0 else "")


async def write_file(ctx: ToolCtx, args: dict[str, Any]) -> str:
    p = resolve(ctx, args.get("path", ""))
    if (g := await _guard_write(ctx, p, "写入文件")):
        return g
    p.parent.mkdir(parents=True, exist_ok=True)
    content = args.get("content") or ""
    p.write_text(content, encoding="utf-8")
    return ok({"status": "written", "path": str(p), "bytes": len(content.encode())})


async def patch_file(ctx: ToolCtx, args: dict[str, Any]) -> str:
    p = resolve(ctx, args.get("path", ""))
    if not p.exists():
        return err(f"文件不存在：{p}")
    old, new = args.get("old_text") or "", args.get("new_text") or ""
    text = p.read_text(encoding="utf-8", errors="replace")
    n = text.count(old) if old else 0
    if n == 0:
        return err("old_text 在文件里找不到，请先 read_file 确认原文")
    if n > 1 and not args.get("replace_all"):
        return err(f"old_text 出现了 {n} 次，请提供更多上下文让它唯一，或设置 replace_all=true")
    if (g := await _guard_write(ctx, p, "修改文件")):
        return g
    p.write_text(text.replace(old, new) if args.get("replace_all") else text.replace(old, new, 1), encoding="utf-8")
    return ok({"status": "patched", "path": str(p), "replacements": n if args.get("replace_all") else 1})


async def list_dir(ctx: ToolCtx, args: dict[str, Any]) -> str:
    p = resolve(ctx, args.get("path", "."))
    if not p.is_dir():
        return err(f"不是目录：{p}")
    rows = []
    for e in sorted(p.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower()))[:500]:
        if e.name == ".hb_proc":
            continue
        try:
            size = e.stat().st_size if e.is_file() else None
        except OSError:
            size = None
        rows.append(f"{'📁' if e.is_dir() else '📄'} {e.name}" + (f"  ({size} B)" if size is not None else ""))
    return f"{p}\n" + ("\n".join(rows) or "(空目录)")


async def search_files(ctx: ToolCtx, args: dict[str, Any]) -> str:
    root = resolve(ctx, args.get("path", "."))
    pattern = args.get("pattern") or ""
    glob = args.get("glob") or "*"
    try:
        rx = re.compile(pattern, re.I) if pattern else None
    except re.error as e:
        return err(f"正则无效：{e}")
    hits: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules", "__pycache__", ".venv", ".hb_proc")]
        for fn in filenames:
            if not fnmatch.fnmatch(fn, glob):
                continue
            fp = Path(dirpath) / fn
            if rx is None:
                hits.append(str(fp))
            else:
                try:
                    if fp.stat().st_size > 2_000_000:
                        continue
                    for i, line in enumerate(fp.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
                        if rx.search(line):
                            hits.append(f"{fp}:{i}: {line.strip()[:200]}")
                            if len(hits) >= 200:
                                break
                except OSError:
                    continue
            if len(hits) >= 200:
                break
        if len(hits) >= 200:
            break
    return "\n".join(hits) or "没有匹配结果"


register(Tool("read_file", "files", "读取文本文件（带行号）。相对路径基于你的 workspace。",
              obj({"path": {"type": "string"}, "offset": {"type": "integer", "description": "起始行，从 1 开始"},
                   "limit": {"type": "integer", "description": "最多读取多少行，默认 500"}}, ["path"]), read_file))
register(Tool("write_file", "files", "创建或覆盖一个文本文件。",
              obj({"path": {"type": "string"}, "content": {"type": "string"}}, ["path", "content"]), write_file))
register(Tool("patch_file", "files", "精确替换文件中的一段文本（old_text 必须唯一）。",
              obj({"path": {"type": "string"}, "old_text": {"type": "string"}, "new_text": {"type": "string"},
                   "replace_all": {"type": "boolean"}}, ["path", "old_text", "new_text"]), patch_file))
register(Tool("list_dir", "files", "列出目录内容。", obj({"path": {"type": "string"}}), list_dir))
register(Tool("search_files", "files", "按文件名 glob 和/或内容正则搜索文件。",
              obj({"path": {"type": "string"}, "pattern": {"type": "string", "description": "内容正则（可选）"},
                   "glob": {"type": "string", "description": "文件名通配，如 *.py"}}), search_files))
