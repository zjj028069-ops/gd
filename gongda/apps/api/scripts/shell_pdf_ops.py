#!/usr/bin/env python3
"""SEDRIC01 shell-tool PDF ops helper. stdin JSON -> stdout JSON. No network."""
from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
import traceback
from pathlib import Path

MAX_PAGES_DEFAULT = 100


def fail(msg: str, code: str = "PDF_ERROR") -> None:
    print(json.dumps({"ok": False, "error": msg, "code": code}, ensure_ascii=False))
    sys.exit(0)


def ok(payload: dict) -> None:
    print(json.dumps({"ok": True, **payload}, ensure_ascii=False))
    sys.exit(0)


def read_input() -> dict:
    raw = sys.stdin.read()
    if not raw.strip():
        fail("empty stdin", "EMPTY")
    return json.loads(raw)


def write_b64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("ascii")


def count_pages(paths: list[Path]) -> int:
    try:
        import fitz  # PyMuPDF
    except Exception:
        from pypdf import PdfReader

        return sum(len(PdfReader(str(p)).pages) for p in paths)
    total = 0
    for p in paths:
        doc = fitz.open(str(p))
        total += doc.page_count
        doc.close()
    return total


def do_merge(files: list[Path], out_dir: Path) -> dict:
    from pypdf import PdfWriter, PdfReader

    writer = PdfWriter()
    for p in files:
        reader = PdfReader(str(p))
        for page in reader.pages:
            writer.add_page(page)
    out = out_dir / "merged.pdf"
    with out.open("wb") as f:
        writer.write(f)
    return {
        "filename": "merged.pdf",
        "mime": "application/pdf",
        "bytes_b64": write_b64(out),
        "pages": len(writer.pages),
    }


def do_split(files: list[Path], out_dir: Path) -> dict:
    from pypdf import PdfWriter, PdfReader

    if len(files) != 1:
        fail("拆分一次只能上传 1 个 PDF", "TOO_MANY_FILES")
    reader = PdfReader(str(files[0]))
    parts = []
    for i, page in enumerate(reader.pages):
        w = PdfWriter()
        w.add_page(page)
        name = f"page-{i + 1:03d}.pdf"
        path = out_dir / name
        with path.open("wb") as f:
            w.write(f)
        parts.append(
            {
                "filename": name,
                "mime": "application/pdf",
                "bytes_b64": write_b64(path),
                "page": i + 1,
            }
        )
    return {"parts": parts, "pages": len(parts)}


def do_to_images(files: list[Path], out_dir: Path, dpi: int = 120) -> dict:
    try:
        import fitz
    except Exception as e:
        fail(f"转图依赖 PyMuPDF 不可用: {e}", "DEP_MISSING")
    if len(files) != 1:
        fail("转图一次只能上传 1 个 PDF", "TOO_MANY_FILES")
    doc = fitz.open(str(files[0]))
    parts = []
    zoom = dpi / 72.0
    mat = fitz.Matrix(zoom, zoom)
    for i in range(doc.page_count):
        page = doc.load_page(i)
        pix = page.get_pixmap(matrix=mat, alpha=False)
        name = f"page-{i + 1:03d}.png"
        path = out_dir / name
        pix.save(str(path))
        parts.append(
            {
                "filename": name,
                "mime": "image/png",
                "bytes_b64": write_b64(path),
                "page": i + 1,
            }
        )
    doc.close()
    return {"parts": parts, "pages": len(parts)}


def do_extract_text(files: list[Path]) -> dict:
    try:
        import fitz
    except Exception:
        fitz = None
    texts = []
    total_pages = 0
    for p in files:
        if fitz is not None:
            doc = fitz.open(str(p))
            chunks = []
            for i in range(doc.page_count):
                chunks.append(doc.load_page(i).get_text("text"))
            total_pages += doc.page_count
            doc.close()
            texts.append({"filename": p.name, "text": "\n".join(chunks)})
        else:
            from pypdf import PdfReader

            reader = PdfReader(str(p))
            chunks = [(page.extract_text() or "") for page in reader.pages]
            total_pages += len(reader.pages)
            texts.append({"filename": p.name, "text": "\n".join(chunks)})
    joined = "\n\n".join(f"===== {t['filename']} =====\n{t['text']}" for t in texts)
    return {"texts": texts, "text": joined, "pages": total_pages}


def main() -> None:
    try:
        data = read_input()
    except Exception as e:
        fail(f"JSON 解析失败: {e}", "BAD_JSON")
        return

    op = str(data.get("op") or "")
    max_pages = int(data.get("max_pages") or MAX_PAGES_DEFAULT)
    file_items = data.get("files") or []
    if not isinstance(file_items, list) or not file_items:
        fail("缺少 files", "NO_FILES")

    with tempfile.TemporaryDirectory(prefix="sedric-pdf-") as td:
        td_path = Path(td)
        paths: list[Path] = []
        try:
            for i, item in enumerate(file_items):
                name = str(item.get("filename") or f"f{i}.pdf")
                if not name.lower().endswith(".pdf"):
                    fail(f"仅允许 PDF：{name}", "TYPE")
                b64 = item.get("bytes_b64") or ""
                raw = base64.b64decode(b64)
                if not raw.startswith(b"%PDF"):
                    fail(f"不是合法 PDF：{name}", "TYPE")
                path = td_path / f"in-{i}-{Path(name).name}"
                path.write_bytes(raw)
                paths.append(path)

            pages = count_pages(paths)
            if pages > max_pages:
                fail(f"总页数 {pages} 超过上限 {max_pages}", "TOO_MANY_PAGES")

            out_dir = td_path / "out"
            out_dir.mkdir()
            if op == "merge":
                ok(do_merge(paths, out_dir))
            elif op == "split":
                ok(do_split(paths, out_dir))
            elif op == "to_images":
                ok(do_to_images(paths, out_dir))
            elif op == "extract_text":
                ok(do_extract_text(paths))
            else:
                fail(f"未知 op: {op}", "BAD_OP")
        except SystemExit:
            raise
        except Exception as e:
            fail(f"{type(e).__name__}: {e}", "PDF_ERROR")


if __name__ == "__main__":
    main()
