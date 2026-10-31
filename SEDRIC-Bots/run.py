"""Start SEDRIC Bots.

    python run.py                  # http://127.0.0.1:8765, opens the browser
    python run.py --port 9000 --no-browser
    python run.py --data D:/my-bots-data
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# Windows consoles default to GBK; never let a status line crash startup.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:
        pass


def ensure_frontend() -> None:
    dist = ROOT / "frontend" / "dist" / "index.html"
    if dist.exists():
        return
    npm = shutil.which("npm")
    if not npm:
        print("! 前端还没构建，并且找不到 npm。请安装 Node.js 后在 frontend 目录运行：npm install && npm run build")
        return
    print("· 首次运行：正在构建前端（npm install && npm run build）…")
    subprocess.run([npm, "install"], cwd=ROOT / "frontend", check=True, shell=sys.platform == "win32")
    subprocess.run([npm, "run", "build"], cwd=ROOT / "frontend", check=True, shell=sys.platform == "win32")


def ensure_backend_deps() -> None:
    try:
        import croniter  # noqa: F401
        import fastapi  # noqa: F401
        import httpx  # noqa: F401
        import multipart  # noqa: F401
        import uvicorn  # noqa: F401
    except ImportError:
        print("· 正在安装后端依赖…")
        subprocess.run([sys.executable, "-m", "pip", "install", "-r", str(ROOT / "backend" / "requirements.txt")], check=True)


def main() -> None:
    ap = argparse.ArgumentParser(description="SEDRIC Bots")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--data", default=None, help="数据目录（默认 ./data）")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    if args.data:
        os.environ["HB_DATA"] = str(Path(args.data).resolve())
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    ensure_backend_deps()
    ensure_frontend()
    sys.path.insert(0, str(ROOT / "backend"))
    url = f"http://{args.host}:{args.port}"
    print(f"✓ SEDRIC Bots 运行在 {url}  （Ctrl+C 退出）")
    if not args.no_browser:
        threading.Thread(target=lambda: (time.sleep(1.5), webbrowser.open(url)), daemon=True).start()
    import uvicorn
    uvicorn.run("app.main:app", host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
