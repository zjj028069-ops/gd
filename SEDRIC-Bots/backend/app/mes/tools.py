"""The only tools a MES-mode session gets (plus `clarify`).

Rules every tool here follows:
- One fixed SEDRIC01 API path per tool; IDs are checked to be UUIDs before they
  go into a path. The model never supplies a URL or path.
- Reads run straight away. Writes first show the user a summary built from
  data looked up in the system (not from the model's wording) and only run
  after the user clicks 确认.
- No delete tools on purpose.
"""
from __future__ import annotations

import json
import re
from typing import Any

from ..tools import Tool, ToolCtx, obj
from . import client
from .client import MesError, check_id

MES_TOOLS: dict[str, Tool] = {}

PRIORITY = {"urgent": "加急", "normal": "正常", "delayed": "延期", "none": "未设置"}
EXECUTION = {"not_started": "未开始", "running": "生产中", "paused": "已暂停", "completed": "已完成",
             "cancelled": "已取消", "closed": "已关闭"}
WO_ACTIONS = {"start": "开始", "pause": "暂停", "resume": "恢复", "complete": "完成", "cancel": "取消"}
PRICING = {"piece": "计件", "time": "计时"}
INSPECTION = {"none": "免检", "full": "全检", "sample": "抽检"}


def _reg(name: str, description: str, parameters: dict[str, Any], handler) -> None:
    MES_TOOLS[name] = Tool(name, "mes", description, parameters, handler)


def _out(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, default=str)


def _owner(ctx: ToolCtx) -> str:
    owner = ctx.session.get("owner") or ""
    # Only turns submitted through the MES gateway by the session's owner may
    # use that owner's MES login.
    if not owner or ctx.meta.get("mes_owner") != owner:
        raise MesError("这个会话没有绑定当前登录的业务系统用户，不能操作业务系统。")
    return owner


def _num(value: Any, what: str, positive: bool = True) -> str:
    s = str(value if value is not None else "").strip()
    try:
        f = float(s)
    except ValueError:
        raise MesError(f"{what} 必须是数字")
    if positive and f <= 0:
        raise MesError(f"{what} 必须大于 0")
    if f < 0:
        raise MesError(f"{what} 不能是负数")
    # MES wants plain decimals without exponent or trailing junk.
    out = format(f, "f").rstrip("0").rstrip(".") if "." in format(f, "f") else format(f, "f")
    return out or "0"


def _date(value: Any, what: str) -> str | None:
    s = str(value or "").strip()
    if not s:
        return None
    from datetime import date
    try:
        if len(s) != 10:
            raise ValueError
        date.fromisoformat(s)
    except ValueError:
        raise MesError(f"{what} 要写成有效的 YYYY-MM-DD 日期")
    return s


def _wrap(fn):
    async def run(ctx: ToolCtx, args: dict[str, Any]) -> str:
        try:
            return await fn(ctx, _owner(ctx), args)
        except MesError as e:
            return _out({"error": e.message, "code": e.code or None})
    return run


async def _confirm(ctx: ToolCtx, title: str, lines: list[str]) -> bool:
    return await ctx.approve(title, "\n".join(lines))


# ── lookups ─────────────────────────────────────────────────────────────────


def _product_row(p: dict[str, Any]) -> dict[str, Any]:
    return {"id": p.get("id"), "code": p.get("code"), "name": p.get("name"), "specification": p.get("specification"),
            "unit": p.get("unit_name"), "source": p.get("source"), "has_route": p.get("has_route")}


async def _product(owner: str, pid: str) -> dict[str, Any]:
    data = await client.call(owner, "GET", f"/api/products/{check_id(pid, '商品ID')}")
    return (data or {}).get("product") or data or {}


async def _items(owner: str, path: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    data = await client.call(owner, "GET", path, params=params)
    return list((data or {}).get("items") or [])


def _match(rows: list[dict[str, Any]], keyword: str, *fields: str) -> list[dict[str, Any]]:
    k = (keyword or "").strip().lower()
    if not k:
        return rows
    return [r for r in rows if any(k in str(r.get(f) or "").lower() for f in fields)]


async def search_products(ctx, owner, args):
    rows = await _items(owner, "/api/products", {"q": str(args.get("keyword") or "")[:100], "page_size": "20"})
    return _out({"items": [_product_row(p) for p in rows], "count": len(rows)})


async def list_processes(ctx, owner, args):
    rows = _match(await _items(owner, "/api/processes"), args.get("keyword"), "name", "code")
    return _out({"items": [{"id": r["id"], "code": r.get("code"), "name": r.get("name"),
                            "pricing": PRICING.get(r.get("pricing_mode"), r.get("pricing_mode")),
                            "wage_rate": r.get("wage_rate"), "standard_minutes": r.get("standard_minutes"),
                            "active": r.get("active")} for r in rows[:50]], "count": len(rows)})


async def list_routes(ctx, owner, args):
    rows = _match(await _items(owner, "/api/routes"), args.get("keyword"), "name", "code")
    return _out({"items": [{"route_id": r["id"], "code": r.get("code"), "name": r.get("name"),
                            "route_version_id": r.get("current_version_id"), "steps": r.get("steps_count"),
                            "active": r.get("active")} for r in rows[:50]], "count": len(rows)})


async def list_boms(ctx, owner, args):
    rows = await _items(owner, "/api/boms")
    if args.get("product_id"):
        pid = check_id(args["product_id"], "商品ID")
        rows = [r for r in rows if r.get("parent_product_id") == pid]
    return _out({"items": [{"bom_id": r["id"], "code": r.get("code"), "name": r.get("name"),
                            "product": r.get("parent_name"), "product_id": r.get("parent_product_id"),
                            "bom_version_id": r.get("current_version_id"), "is_default": r.get("is_default"),
                            "items": r.get("items_count"), "active": r.get("active")} for r in rows[:50]]})


async def list_warehouses(ctx, owner, args):
    rows = await _items(owner, "/api/warehouses")
    return _out({"items": [{"id": r["id"], "code": r.get("code"), "name": r.get("name"), "active": r.get("active")}
                           for r in rows]})


async def list_customers(ctx, owner, args):
    rows = _match(await _items(owner, "/api/customers"), args.get("keyword"), "name", "code")
    return _out({"items": [{"id": r["id"], "code": r.get("code"), "name": r.get("name")} for r in rows[:50]]})


async def list_team_members(ctx, owner, args):
    rows = await _items(owner, "/api/team-members")
    return _out({"items": [{"id": r["id"], "name": r.get("display_name"), "role": r.get("role")} for r in rows[:100]]})


def _wo_row(w: dict[str, Any]) -> dict[str, Any]:
    snap = w.get("product_snapshot") or {}
    tasks = w.get("tasks") or []
    return {"id": w.get("id"), "code": w.get("code"), "product": snap.get("name") or snap.get("code"),
            "plan_qty": w.get("plan_qty"), "output_qty": w.get("output_qty"),
            "status": "已暂停" if w.get("order_paused") else EXECUTION.get(w.get("execution"), w.get("execution")),
            "priority": PRIORITY.get(w.get("priority"), w.get("priority")), "due_date": w.get("due_date"),
            "tasks": len(tasks), "created_at": w.get("created_at")}


async def list_work_orders(ctx, owner, args):
    page = max(1, min(int(args.get("page") or 1), 1000))
    data = await client.call(owner, "GET", "/api/work-orders", params={"page": str(page), "page_size": "20"})
    rows = [_wo_row(w) for w in (data or {}).get("items") or []]
    k = (args.get("keyword") or "").strip()
    if k:
        rows = [r for r in rows if k in str(r.get("code")) or k in str(r.get("product"))]
    return _out({"items": rows, "total": (data or {}).get("total"), "page": page})


async def _wo(owner: str, wid: str) -> dict[str, Any]:
    ref = str(wid or "").strip()
    if not client.UUID_RE.match(ref):
        # 也接受加工单号（如 WO000009 / JG261028-1），在最近的单子里按单号找
        if not re.match(r"^[A-Za-z0-9_-]{2,64}$", ref):
            raise MesError("加工单要写系统里的单号或 ID")
        data = await client.call(owner, "GET", "/api/work-orders", params={"page_size": "200"})
        hit = next((w for w in (data or {}).get("items") or [] if str(w.get("code", "")).upper() == ref.upper()), None)
        if not hit:
            raise MesError(f"找不到加工单「{ref}」，用 mes_list_work_orders 看看单号对不对")
        ref = hit["id"]
    data = await client.call(owner, "GET", f"/api/work-orders/{ref}")
    return (data or {}).get("work_order") or {}


async def get_work_order(ctx, owner, args):
    w = await _wo(owner, args.get("work_order_id"))
    row = _wo_row(w)
    row["tasks"] = [{"task_id": t.get("id"), "sequence": t.get("sequence"),
                     "process": (t.get("process_snapshot") or {}).get("name"),
                     "plan_qty": t.get("plan_qty"), "good": t.get("approved_good"),
                     "status": EXECUTION.get(t.get("execution"), t.get("execution")),
                     "pricing": PRICING.get(t.get("pricing_mode")), "wage_rate": t.get("wage_rate")}
                    for t in w.get("tasks") or []]
    row["materials"] = [{"name": (m.get("component_snapshot") or {}).get("name"), "required_qty": m.get("required_qty")}
                        for m in (w.get("materials") or [])[:30]]
    row["note"] = w.get("note")
    return _out(row)


# ── writes (each one asks the user first) ──────────────────────────────────


async def create_work_order(ctx, owner, args):
    product = await _product(owner, args.get("product_id"))
    if not product.get("id"):
        raise MesError("找不到这个商品")
    qty = _num(args.get("quantity"), "计划数")
    body: dict[str, Any] = {"request_key": client.request_key(), "product_id": product["id"], "quantity": qty}
    lines = [f"商品：{product.get('name')}（{product.get('code')}）", f"计划数：{qty} {product.get('unit_name') or ''}".rstrip()]
    process_ids = [check_id(p, "工序ID") for p in (args.get("process_ids") or [])][:30]
    route_version_id = args.get("route_version_id")
    if process_ids and route_version_id:
        raise MesError("工序列表和工艺路线只能二选一")
    if process_ids:
        procs = {p["id"]: p for p in await _items(owner, "/api/processes")}
        names = []
        for pid in process_ids:
            if pid not in procs:
                raise MesError(f"工序 {pid} 不存在")
            names.append(procs[pid].get("name"))
        body["tasks"] = [{"process_id": pid} for pid in process_ids]
        lines.append("工序：" + " → ".join(str(n) for n in names))
    elif route_version_id:
        rv = check_id(route_version_id, "工艺路线版本ID")
        route = next((r for r in await _items(owner, "/api/routes") if r.get("current_version_id") == rv), None)
        if not route:
            raise MesError("找不到这条工艺路线（要用 mes_list_routes 里的 route_version_id）")
        body["route_version_id"] = rv
        lines.append(f"工艺路线：{route.get('name')}（{route.get('steps_count')} 道工序）")
    else:
        raise MesError("还没有选工序：请让用户选工序（process_ids）或工艺路线（route_version_id）")
    if args.get("bom_version_id"):
        bv = check_id(args["bom_version_id"], "BOM版本ID")
        bom = next((b for b in await _items(owner, "/api/boms") if b.get("current_version_id") == bv), None)
        if not bom:
            raise MesError("找不到这个 BOM")
        body["bom_version_id"] = bv
        lines.append(f"BOM：{bom.get('name') or bom.get('code')}")
    if args.get("warehouse_id"):
        wid = check_id(args["warehouse_id"], "仓库ID")
        wh = next((w for w in await _items(owner, "/api/warehouses") if w.get("id") == wid), None)
        if not wh:
            raise MesError("找不到这个仓库")
        body["warehouse_id"] = wid
        lines.append(f"仓库：{wh.get('name')}")
    pr = str(args.get("priority") or "").strip()
    if pr:
        if pr not in PRIORITY:
            raise MesError("优先级只能是 urgent / normal / delayed")
        body["priority"] = pr
        lines.append(f"优先级：{PRIORITY[pr]}")
    for key, label in (("due_date", "交货日期"), ("planned_start", "计划开始"), ("planned_end", "计划结束")):
        d = _date(args.get(key), label)
        if d:
            body[key] = d
            lines.append(f"{label}：{d}")
    note = str(args.get("note") or "").strip()[:255]
    if note:
        body["note"] = note
        lines.append(f"备注：{note}")
    if not await _confirm(ctx, "创建加工单", lines):
        return _out({"cancelled": True, "message": "用户没有确认，加工单没有创建。问用户要改哪里。"})
    data = await client.call(owner, "POST", "/api/work-orders", body=body)
    w = (data or {}).get("work_order") or {}
    return _out({"ok": True, "work_order": _wo_row(w)})


async def work_order_action(ctx, owner, args):
    action = str(args.get("action") or "")
    if action not in WO_ACTIONS:
        raise MesError("action 只能是 start / pause / resume / complete / cancel")
    w = await _wo(owner, args.get("work_order_id"))
    reason = str(args.get("reason") or "").strip()[:200]
    lines = [f"加工单：{w.get('code')}（{(w.get('product_snapshot') or {}).get('name')}）",
             f"当前状态：{_wo_row(w)['status']}", f"操作：{WO_ACTIONS[action]}"]
    if reason:
        lines.append(f"原因：{reason}")
    if not await _confirm(ctx, f"{WO_ACTIONS[action]}加工单", lines):
        return _out({"cancelled": True, "message": "用户没有确认，状态没有改。"})
    body: dict[str, Any] = {"action": action, "version": w.get("version"), "request_key": client.request_key()}
    if reason:
        body["reason"] = reason
    data = await client.call(owner, "POST", f"/api/work-orders/{w['id']}/actions", body=body)
    return _out({"ok": True, "work_order": _wo_row((data or {}).get("work_order") or w)})


async def update_work_order(ctx, owner, args):
    """Same fields as the 修改 button in the classic UI (plan-fields).
    That MES endpoint has no body schema, so everything is checked here."""
    w = await _wo(owner, args.get("work_order_id"))
    if not w.get("id"):
        raise MesError("找不到这张加工单")
    if str(args.get("quantity") or "").strip():
        raise MesError("计划数不能修改（传统界面也不支持）。未开始的单子可以取消后重开一张。")
    body: dict[str, Any] = {"version": w.get("version")}
    lines = [f"加工单：{w.get('code')}（{(w.get('product_snapshot') or {}).get('name')}）"]

    def old(v: Any) -> str:
        return str(v)[:10] if v else "未填"

    for key, label in (("due_date", "交货日期"), ("planned_start", "计划开始"), ("planned_end", "计划结束")):
        d = _date(args.get(key), label)
        if d and d != old(w.get(key)):
            body[key] = d
            lines.append(f"{label}：{old(w.get(key))} → {d}")
    start = body.get("planned_start") or (str(w.get("planned_start"))[:10] if w.get("planned_start") else None)
    end = body.get("planned_end") or (str(w.get("planned_end"))[:10] if w.get("planned_end") else None)
    if start and end and start > end:
        raise MesError(f"计划开始（{start}）不能晚于计划结束（{end}）")
    pr = str(args.get("priority") or "").strip()
    if pr:
        if pr not in PRIORITY:
            raise MesError("优先级只能是 urgent / normal / delayed / none")
        if pr != (w.get("priority") or "none"):
            body["priority"] = pr
            lines.append(f"优先级：{PRIORITY.get(w.get('priority') or 'none')} → {PRIORITY[pr]}")
    if args.get("note") is not None and str(args.get("note")).strip() != "":
        note = str(args["note"]).strip()[:255]
        if note != (w.get("note") or ""):
            body["note"] = note
            lines.append(f"备注：{w.get('note') or '无'} → {note}")
    if len(body) == 1:
        return _out({"unchanged": True, "message": "没有需要修改的内容（和现在一样，或者没给新值）。"})
    if not await _confirm(ctx, "修改加工单", lines):
        return _out({"cancelled": True, "message": "用户没有确认，加工单没有修改。问用户要改哪里。"})
    data = await client.call(owner, "PATCH", f"/api/work-orders/{w['id']}/plan-fields", body=body)
    nw = (data or {}).get("work_order") or {}
    row = _wo_row(nw)
    row.update({"planned_start": nw.get("planned_start"), "planned_end": nw.get("planned_end"), "note": nw.get("note")})
    return _out({"ok": True, "work_order": row})


async def create_process(ctx, owner, args):
    name = str(args.get("name") or "").strip()[:100]
    if not name:
        raise MesError("工序名称不能为空")
    minutes = _num(args.get("standard_minutes") or "1", "标准工时（分钟）")
    mode = str(args.get("pricing_mode") or "piece")
    if mode not in PRICING:
        raise MesError("计价方式只能是 piece（计件）或 time（计时）")
    body: dict[str, Any] = {"name": name, "standard_minutes": minutes, "pricing_mode": mode}
    lines = [f"工序名称：{name}", f"标准工时：{minutes} 分钟", f"计价方式：{PRICING[mode]}"]
    if args.get("wage_rate") not in (None, ""):
        body["wage_rate"] = _num(args["wage_rate"], "工资单价", positive=False)
        lines.append(f"工资单价：{body['wage_rate']} 元")
    insp = str(args.get("inspection_scheme") or "")
    if insp:
        if insp not in INSPECTION:
            raise MesError("检验方案只能是 none / full / sample")
        body["inspection_scheme"] = insp
        lines.append(f"检验方案：{INSPECTION[insp]}")
    if not await _confirm(ctx, "新建工序", lines):
        return _out({"cancelled": True, "message": "用户没有确认，工序没有创建。"})
    data = await client.call(owner, "POST", "/api/processes", body=body)
    p = (data or {}).get("process") or data or {}
    return _out({"ok": True, "process": {"id": p.get("id"), "code": p.get("code"), "name": p.get("name")}})


async def create_warehouse(ctx, owner, args):
    code = str(args.get("code") or "").strip()[:64]
    name = str(args.get("name") or "").strip()[:200]
    if not code or not name:
        raise MesError("仓库编号和名称都要填")
    if not await _confirm(ctx, "新建仓库", [f"仓库编号：{code}", f"仓库名称：{name}"]):
        return _out({"cancelled": True, "message": "用户没有确认，仓库没有创建。"})
    data = await client.call(owner, "POST", "/api/warehouses",
                             body={"request_key": client.request_key(), "code": code, "name": name})
    w = (data or {}).get("warehouse") or {}
    return _out({"ok": True, "warehouse": {"id": w.get("id"), "code": w.get("code"), "name": w.get("name")}})


async def create_customer(ctx, owner, args):
    code = str(args.get("code") or "").strip()[:64]
    name = str(args.get("name") or "").strip()[:200]
    if not code or not name:
        raise MesError("客户编号和名称都要填")
    if not await _confirm(ctx, "新建客户", [f"客户编号：{code}", f"客户名称：{name}"]):
        return _out({"cancelled": True, "message": "用户没有确认，客户没有创建。"})
    data = await client.call(owner, "POST", "/api/customers",
                             body={"request_key": client.request_key(), "code": code, "name": name})
    cu = (data or {}).get("customer") or {}
    return _out({"ok": True, "customer": {"id": cu.get("id"), "code": cu.get("code"), "name": cu.get("name")}})


async def report_production(ctx, owner, args):
    w = await _wo(owner, args.get("work_order_id"))
    tid = check_id(args.get("task_id"), "生产任务ID")
    task = next((t for t in w.get("tasks") or [] if t.get("id") == tid), None)
    if not task:
        raise MesError("这个生产任务不属于这张加工单")
    good = _num(args.get("good_qty"), "良品数", positive=False)
    defect = _num(args.get("defect_qty") or 0, "不良品数", positive=False)
    if float(good) + float(defect) <= 0:
        raise MesError("良品数和不良品数不能都是 0")
    body: dict[str, Any] = {"request_key": client.request_key(), "task_id": tid, "good_qty": good,
                            "defect_qty": defect, "rework_qty": "0", "scrap_qty": "0"}
    lines = [f"加工单：{w.get('code')}", f"工序：{(task.get('process_snapshot') or {}).get('name')}",
             f"良品数：{good}", f"不良品数：{defect}"]
    if args.get("operator_id"):
        oid = check_id(args["operator_id"], "报工人ID")
        member = next((m for m in await _items(owner, "/api/team-members") if m.get("id") == oid), None)
        if not member:
            raise MesError("找不到这个报工人")
        body["operator_id"] = oid
        lines.append(f"报工人：{member.get('display_name')}（代报）")
    note = str(args.get("note") or "").strip()[:200]
    if note:
        body["note"] = note
        lines.append(f"备注：{note}")
    if not await _confirm(ctx, "提交报工", lines):
        return _out({"cancelled": True, "message": "用户没有确认，没有报工。"})
    data = await client.call(owner, "POST", "/api/production-reports", body=body)
    rep = (data or {}).get("report") or {}
    return _out({"ok": True, "report_id": rep.get("id"), "status": rep.get("approval") or rep.get("status")})


async def check_ready(ctx, owner, args):
    """确定性的前置检查：一次查完某件事要用到的资料，列出缺什么、怎么补。"""
    task = str(args.get("task") or "work_order")
    missing: list[str] = []
    ok_items: list[str] = []
    if task == "work_order":
        kw = str(args.get("product_keyword") or "")[:100]
        products = await _items(owner, "/api/products", {"q": kw, "page_size": "20"})
        if not products:
            missing.append(f"商品：系统里{'找不到「' + kw + '」' if kw else '还没有商品'}。需要先在「商品管理 → 商品列表」新建（问用户商品名称、单位）。")
        else:
            ok_items.append("商品候选：" + "、".join(f"{p.get('name')}（{p.get('code')}）" for p in products[:8]))
        procs = [p for p in await _items(owner, "/api/processes") if p.get("active", True)]
        routes = await _items(owner, "/api/routes")
        if not procs:
            missing.append("工序：系统里没有工序。需要先在「生产管理 → 工序管理」新建（问用户工序名称、计件单价）。")
        else:
            no_staff = [p.get("name") for p in procs if not (p.get("reporter_ids") or [])]
            ok_items.append("工序：" + "、".join(str(p.get("name")) for p in procs[:15]) + (f"；工艺路线：{len(routes)} 条" if routes else "；没有工艺路线"))
            if no_staff:
                missing.append(f"生产人员：工序「{'、'.join(map(str, no_staff[:10]))}」没配生产人员，开单可以，但之后报工会被拦。"
                               "如果用户之后要报工，先在「工序管理 → 修改 → 生产信息 → 生产人员」配好（问用户配谁）。")
        whs = await _items(owner, "/api/warehouses")
        if not [w for w in whs if w.get("active", True)]:
            missing.append("仓库：系统里一个仓库都没有，加工单提交会被拦（「请先维护仓库」）。必须先在「仓库管理 → 仓库管理 → 新增」建一个，"
                           "必填：仓库名、管理员、仓库位置（省/市/区）。这些都要问用户，或者给出建议值让用户确认。")
        else:
            ok_items.append("仓库：" + "、".join(str(w.get("name")) for w in whs[:8]))
    elif task == "report":
        w = await _wo(owner, args.get("work_order_id"))
        if (w.get("execution") or "") not in ("running",):
            missing.append(f"加工单 {w.get('code')} 现在是「{_wo_row(w)['status']}」，要先「开始」才能报工。")
        members = {m["id"]: m.get("display_name") for m in await _items(owner, "/api/team-members")}
        procs = {p["id"]: p for p in await _items(owner, "/api/processes")}
        for t in w.get("tasks") or []:
            name = (t.get("process_snapshot") or {}).get("name")
            staff = (procs.get(t.get("process_id")) or {}).get("reporter_ids") or []
            state = EXECUTION.get(t.get("execution"), t.get("execution"))
            if not staff:
                missing.append(f"工序「{name}」没配生产人员，报工会被拦。先去「工序管理 → 修改 → 生产人员」配好（可选：{'、'.join(members.values())}）。")
            if t.get("execution") != "running":
                missing.append(f"工序「{name}」现在是「{state}」，要先在加工单详情「工序流程」里点「开始工序」。")
            ok_items.append(f"工序「{name}」：{state}，计划 {t.get('plan_qty')}，已报良品 {t.get('approved_good')}")
    else:
        raise MesError("task 只能是 work_order 或 report")
    return _out({"ready": not missing, "missing": missing, "found": ok_items,
                 "next": "把 missing 里要用户定的事合成一个 clarify 问题（带建议值），用户确认后先补前置资料，再做主任务。"
                 if missing else "前置资料齐全，可以直接开始。"})


async def memory_tool(ctx, owner, args):
    from . import memory
    action = str(args.get("action") or "add")
    who = f"Bot（{client.user_info(owner).get('name') or '用户'}）"
    try:
        tenant = memory.tenant_of(owner)
        if action == "add":
            e = memory.add(tenant, args.get("text"), who, source=ctx.session.get("id", ""))
            return _out({"ok": True, "added": bool(e), "message": "已记住" if e else "已经有一样的经验了"})
        if action == "update":
            e = memory.update(tenant, str(args.get("id") or ""), args.get("text"), who)
            return _out({"ok": True, "updated": e["text"]})
    except memory.MemoryError as e:
        raise MesError(str(e))
    raise MesError("action 只能是 add 或 update（删除请让管理员在「经验」面板里操作）")


async def search_manual(ctx, owner, args):
    from . import manual
    query = str(args.get("query") or "").strip()[:200]
    if not query:
        raise MesError("query 不能为空")
    hits = manual.search(query)
    if not hits:
        return _out({"items": [], "message": "说明书里没有找到相关内容，换个说法再查，或如实告诉用户说明书没写。"})
    return _out({"items": [{"section": h["title"], "text": h["text"]} for h in hits]})


S = {"type": "string"}
_reg("mes_memory",
     "往本企业的经验库里记一条经验（add），或改正已有的一条（update，带 id）。写成「场景/现象 → 正确做法」，一句话。"
     "用户说「记住……」时用；任务做完后系统也会自动回顾记录，不必每次手动记。不要记单号、数量、人名等一次性信息。",
     obj({"action": {"type": "string", "enum": ["add", "update"]}, "text": S, "id": S}, ["action", "text"]),
     _wrap(memory_tool))
_reg("mes_check_ready",
     "开始干活前的前置检查（只读，很快）：task=work_order（开加工单，可带 product_keyword）或 report（报工，带 work_order_id）。"
     "一次查完商品/工序/生产人员/仓库/加工单状态等，返回缺什么、该怎么补。代操作前必须先调用。",
     obj({"task": {"type": "string", "enum": ["work_order", "report"]}, "product_keyword": S, "work_order_id": S}, ["task"]),
     _wrap(check_ready))
_reg("mes_search_manual",
     "查《赛德瑞克完整操作说明书》。用户问「怎么做/在哪里/是什么意思」、或你不确定某个业务规则时先查它，"
     "按说明书原文回答（菜单路径、按钮名照抄）。query 写关键词，如「开加工单 工序」「结算工资」。",
     obj({"query": S}, ["query"]), _wrap(search_manual))
_reg("mes_search_products", "按名称/编号/规格搜索商品，返回商品 ID。开加工单前必须先用它找到商品。",
     obj({"keyword": S}), _wrap(search_products))
_reg("mes_list_processes", "列出工序（可按关键字过滤），返回工序 ID、计价方式、工资单价。", obj({"keyword": S}), _wrap(list_processes))
_reg("mes_list_routes", "列出工艺路线，返回 route_version_id（开加工单时用）。", obj({"keyword": S}), _wrap(list_routes))
_reg("mes_list_boms", "列出 BOM（可只看某个商品的），返回 bom_version_id。", obj({"product_id": S}), _wrap(list_boms))
_reg("mes_list_warehouses", "列出仓库。", obj({}), _wrap(list_warehouses))
_reg("mes_list_customers", "列出客户（可按关键字过滤）。", obj({"keyword": S}), _wrap(list_customers))
_reg("mes_list_team_members", "列出本企业成员（报工人、生产人员）。", obj({}), _wrap(list_team_members))
_reg("mes_list_work_orders", "列出最近的加工单，可按单号/商品名过滤，每页 20 条。",
     obj({"keyword": S, "page": {"type": "integer"}}), _wrap(list_work_orders))
_reg("mes_get_work_order", "查看一张加工单的详情：状态、每道工序（task_id）的进度、用料。",
     obj({"work_order_id": {"type": "string", "description": "加工单号或 ID"}}, ["work_order_id"]), _wrap(get_work_order))
_reg("mes_create_work_order",
     "创建加工单。必须有商品 ID、计划数，以及工序（process_ids，按顺序）或工艺路线（route_version_id）二选一。"
     "调用后系统会把汇总给用户确认，用户确认后才真正创建。",
     obj({"product_id": S, "quantity": S, "process_ids": {"type": "array", "items": S}, "route_version_id": S,
          "bom_version_id": S, "warehouse_id": S,
          "priority": {"type": "string", "enum": ["urgent", "normal", "delayed"]},
          "due_date": {"type": "string", "description": "YYYY-MM-DD"},
          "planned_start": {"type": "string", "description": "YYYY-MM-DD"},
          "planned_end": {"type": "string", "description": "YYYY-MM-DD"},
          "note": S}, ["product_id", "quantity"]),
     _wrap(create_work_order))
_reg("mes_update_work_order",
     "修改加工单：交货日期、计划开始、计划结束、优先级、备注（和传统界面的「修改」一样）。只传要改的字段。"
     "计划数不能改；日期也不能清空。会先让用户确认。",
     obj({"work_order_id": S, "due_date": {"type": "string", "description": "YYYY-MM-DD"},
          "planned_start": {"type": "string", "description": "YYYY-MM-DD"},
          "planned_end": {"type": "string", "description": "YYYY-MM-DD"},
          "priority": {"type": "string", "enum": ["urgent", "normal", "delayed", "none"]}, "note": S},
         ["work_order_id"]), _wrap(update_work_order))
_reg("mes_work_order_action", "改加工单状态：开始/暂停/恢复/完成/取消。会先让用户确认。",
     obj({"work_order_id": S, "action": {"type": "string", "enum": list(WO_ACTIONS)}, "reason": S},
         ["work_order_id", "action"]), _wrap(work_order_action))
_reg("mes_create_process", "新建工序（开加工单缺工序时用）。会先让用户确认。",
     obj({"name": S, "standard_minutes": S, "pricing_mode": {"type": "string", "enum": ["piece", "time"]},
          "wage_rate": S, "inspection_scheme": {"type": "string", "enum": ["none", "full", "sample"]}}, ["name"]),
     _wrap(create_process))
_reg("mes_create_warehouse", "新建仓库（系统里还没有仓库时，加工单建不了）。会先让用户确认。",
     obj({"code": S, "name": S}, ["code", "name"]), _wrap(create_warehouse))
_reg("mes_create_customer", "新建客户。会先让用户确认。", obj({"code": S, "name": S}, ["code", "name"]), _wrap(create_customer))
_reg("mes_report_production", "给某张加工单的某道工序报工（进行中的工序才能报）。会先让用户确认。",
     obj({"work_order_id": S, "task_id": S, "good_qty": S, "defect_qty": S, "operator_id": S, "note": S},
         ["work_order_id", "task_id", "good_qty"]), _wrap(report_production))
