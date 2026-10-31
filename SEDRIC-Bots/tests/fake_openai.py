"""A fake OpenAI-compatible endpoint for tests.

Behaviour is chosen by the API key:
  ok        normal streamed answer; calls `memory` once if the user says "记住"
  think     streams <think>…</think> inside content, split across chunks
  bad       401
  broke     402 insufficient balance
  slow      streams slowly (for interrupt tests)
  badjson   tool call with invalid JSON arguments, then answers
Run: python fake_openai.py <port>
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def chunk(delta, finish=None):
    return "data: " + json.dumps({"choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}) + "\n\n"


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _key(self):
        return (self.headers.get("Authorization") or "").replace("Bearer ", "")

    def do_GET(self):
        if self.path.endswith("/models"):
            if self._key() == "bad":
                return self._err(401, "invalid api key")
            return self._json(200, {"data": [{"id": "fake-1"}, {"id": "fake-2"}]})
        self._json(404, {"error": "nope"})

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _err(self, code, msg):
        self._json(code, {"error": {"message": msg, "code": code}})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        req = json.loads(self.rfile.read(n) or b"{}")
        key = self._key()
        if key == "bad":
            return self._err(401, "invalid api key")
        if key == "broke":
            return self._err(402, "insufficient balance")
        msgs = req.get("messages", [])
        last = msgs[-1] if msgs else {}
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        out = []
        tools = {t["function"]["name"] for t in req.get("tools") or []}
        content = last.get("content")
        text = content if isinstance(content, str) else json.dumps(content)
        has_image = isinstance(content, list) and any(p.get("type") == "image_url" for p in content)
        if last.get("role") == "user" and "记住" in text and "memory" in tools:
            args = json.dumps({"action": "add", "target": "user", "content": "测试记忆"}, ensure_ascii=False)
            out.append(chunk({"tool_calls": [{"index": 0, "id": "call_a", "type": "function", "function": {"name": "memory", "arguments": ""}}]}))
            for i in range(0, len(args), 7):
                out.append(chunk({"tool_calls": [{"index": 0, "function": {"arguments": args[i:i + 7]}}]}))
            out.append(chunk({}, "tool_calls"))
        elif key == "badjson" and last.get("role") == "user" and "memory" in tools:
            out.append(chunk({"tool_calls": [{"index": 0, "id": "call_b", "type": "function", "function": {"name": "memory", "arguments": "{not json"}}]}))
            out.append(chunk({}, "tool_calls"))
        elif key == "loop" and tools:
            # Never stops calling tools — exercises the step cap.
            out.append(chunk({"tool_calls": [{"index": 0, "id": f"call_l{len(msgs)}", "type": "function", "function": {"name": "list_dir", "arguments": "{}"}}]}))
            out.append(chunk({}, "tool_calls"))
        elif key == "loop":
            out.append(chunk({"content": "最终回答"}))
            out.append(chunk({}, "stop"))
        elif key == "think":
            for piece in ["<thi", "nk>我在想", "事情</th", "ink>答案", "是42"]:
                out.append(chunk({"content": piece}))
            out.append(chunk({}, "stop"))
        else:
            reply = "收到图片" if has_image else ("工具结果已收到" if last.get("role") == "tool" else "你好，我是假模型")
            out.append(chunk({"reasoning_content": "推理中"}))
            for ch in reply:
                out.append(chunk({"content": ch}))
            out.append(chunk({}, "stop"))
        out.append("data: [DONE]\n\n")
        for piece in out:
            try:
                self.wfile.write(piece.encode())
                self.wfile.flush()
            except OSError:
                return
            if key == "slow":
                time.sleep(0.3)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
