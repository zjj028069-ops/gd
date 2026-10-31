"""A tiny stdio MCP server for tests (no dependencies): tools `echo` and `add`."""
import json
import sys

TOOLS = [
    {"name": "echo", "description": "Echo text back", "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}},
    {"name": "add", "description": "Add two numbers", "inputSchema": {"type": "object", "properties": {"a": {"type": "number"}, "b": {"type": "number"}}}},
]


def reply(mid, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": mid}
    if error:
        msg["error"] = {"code": -32000, "message": error}
    else:
        msg["result"] = result
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    try:
        req = json.loads(line)
    except json.JSONDecodeError:
        continue
    method, mid, params = req.get("method"), req.get("id"), req.get("params") or {}
    if mid is None:
        continue  # notification
    if method == "initialize":
        reply(mid, {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "fake", "version": "1"}})
    elif method == "tools/list":
        reply(mid, {"tools": TOOLS})
    elif method == "tools/call":
        name, args = params.get("name"), params.get("arguments") or {}
        if name == "echo":
            reply(mid, {"content": [{"type": "text", "text": "ECHO:" + str(args.get("text", ""))}]})
        elif name == "add":
            reply(mid, {"content": [{"type": "text", "text": str(args.get("a", 0) + args.get("b", 0))}]})
        else:
            reply(mid, {"content": [{"type": "text", "text": "no such tool"}], "isError": True})
    else:
        reply(mid, error="unknown method")
