"""Shared fixtures: a real backend process on a throwaway data dir, plus a fake
OpenAI-compatible model server. Run from the repo root:  python -m pytest tests -q"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[1]
TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "backend"))

# One data dir per test session, shared by the server process and any
# in-process unit tests (backend modules read HB_DATA at import time).
TMP = Path(tempfile.mkdtemp(prefix="hb-test-"))
os.environ["HB_DATA"] = str(TMP / "data")


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def wait_http(url: str, timeout: float = 30) -> None:
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            httpx.get(url, timeout=2)
            return
        except httpx.HTTPError:
            time.sleep(0.2)
    raise RuntimeError(f"{url} did not start")


class Api:
    def __init__(self, base: str):
        self.base = base
        self.c = httpx.Client(base_url=base, timeout=60)

    def get(self, path, **kw):
        return self.c.get(path, **kw)

    def post(self, path, json_=None, **kw):
        return self.c.post(path, json=json_ if json_ is not None else {}, **kw)

    def patch(self, path, json_):
        return self.c.patch(path, json=json_)

    def put(self, path, json_):
        return self.c.put(path, json=json_)

    def delete(self, path):
        return self.c.delete(path)

    # helpers -----------------------------------------------------------------

    def ok(self, method: str, path: str, body=None):
        r = getattr(self, method)(path) if method in ("get", "delete") else getattr(self, method)(path, body if body is not None else {})
        assert r.status_code == 200, f"{method} {path} -> {r.status_code} {r.text[:300]}"
        return r.json()

    def create_bot(self, name: str, **kw):
        body = {"name": name, "title": kw.pop("title", name.title()), "kickoff": kw.pop("kickoff", False), **kw}
        return self.ok("post", "/api/bots", body)

    def botchat(self, name: str) -> str:
        return self.ok("post", f"/api/bots/{name}/botchat")["id"]

    def session(self, sid: str):
        return self.ok("get", f"/api/sessions/{sid}")

    def wait_idle(self, sid: str, timeout: float = 30):
        t0 = time.time()
        time.sleep(0.15)
        while time.time() - t0 < timeout:
            s = self.session(sid)
            if not s["running"] and not s["queued"]:
                return s
            time.sleep(0.15)
        raise AssertionError(f"session {sid} still busy after {timeout}s")

    def say(self, sid: str, text: str, attachments=None, timeout: float = 30):
        self.ok("post", f"/api/sessions/{sid}/messages", {"text": text, "attachments": attachments or []})
        return self.wait_idle(sid, timeout)

    def pending(self):
        return self.ok("get", "/api/state")["pending"]

    def wait_pending(self, timeout: float = 15):
        t0 = time.time()
        while time.time() - t0 < timeout:
            p = self.pending()
            if p:
                return p
            time.sleep(0.15)
        raise AssertionError("no pending request appeared")

    def wait_group(self, gid: str, timeout: float = 60):
        t0 = time.time()
        time.sleep(0.3)
        while time.time() - t0 < timeout:
            g = self.ok("get", f"/api/groups/{gid}")
            if not g["running"]:
                return g
            time.sleep(0.2)
        raise AssertionError("group still running")


def last_assistant(s) -> str:
    for m in reversed(s["messages"]):
        if m["role"] == "assistant" and m.get("content"):
            return m["content"]
    return ""


@pytest.fixture(scope="session")
def fake_llm():
    port = free_port()
    p = subprocess.Popen([sys.executable, str(TESTS / "fake_openai.py"), str(port)])
    wait_http(f"http://127.0.0.1:{port}/v1/models")
    yield f"http://127.0.0.1:{port}/v1"
    p.kill()


class Server:
    def __init__(self, data: Path, port: int):
        self.data = data
        self.port = port
        self.proc: subprocess.Popen | None = None
        self.log = data.parent / f"server-{port}.log"

    def start(self):
        env = {**os.environ, "HB_DATA": str(self.data), "PYTHONIOENCODING": "utf-8"}
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(self.port), "--log-level", "warning"],
            cwd=ROOT / "backend", env=env, stdout=open(self.log, "ab"), stderr=subprocess.STDOUT)
        wait_http(f"http://127.0.0.1:{self.port}/api/state")

    def stop(self):
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
            self.proc = None

    def restart(self):
        self.stop()
        time.sleep(0.5)
        self.start()


@pytest.fixture(scope="session")
def server(fake_llm):
    tmp = TMP
    srv = Server(tmp / "data", free_port())
    srv.start()
    api = Api(f"http://127.0.0.1:{srv.port}")
    providers = [{"id": f"f{k}", "name": f"fake-{k}", "base_url": fake_llm, "api_key": k, "models": ["fake-1"]}
                 for k in ("ok", "think", "bad", "broke", "slow", "badjson", "loop")]
    providers.append({"id": "fdown", "name": "down", "base_url": "http://127.0.0.1:9/v1", "api_key": "x", "models": ["m"]})
    api.ok("put", "/api/settings", {"providers": providers, "default_provider": "mock", "default_model": "mock-agent"})
    srv.api = api
    yield srv
    srv.stop()
    if os.environ.get("HB_KEEP_TEST_DATA") is None:
        shutil.rmtree(tmp, ignore_errors=True)
    else:
        print("test data kept at", tmp)


@pytest.fixture(scope="session")
def api(server) -> Api:
    return server.api


class Events:
    """Collects SSE events in a background thread."""

    def __init__(self, base: str):
        self.items: list[dict] = []
        self._stop = False
        threading.Thread(target=self._run, args=(base,), daemon=True).start()
        t0 = time.time()
        while "hello" not in self.types() and time.time() - t0 < 15:
            time.sleep(0.05)
        assert "hello" in self.types(), "event stream did not connect"

    def _run(self, base):
        try:
            self._stream(base)
        except httpx.HTTPError:
            pass  # the server went away at teardown

    def _stream(self, base):
        buf = b""
        with httpx.stream("GET", base + "/api/events", timeout=None) as r:
            for chunk in r.iter_raw():
                if self._stop:
                    break
                buf += chunk
                while b"\n\n" in buf:
                    frame, buf = buf.split(b"\n\n", 1)
                    line = frame.decode("utf-8")
                    if line.startswith("data:"):
                        self.items.append(json.loads(line[5:]))

    def types(self):
        return [e["type"] for e in self.items]

    def close(self):
        self._stop = True
