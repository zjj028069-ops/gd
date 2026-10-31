"""批量建资料的工具（读文件后用：图纸 → 商品+工序+路线+BOM；BOM 表 → 物料+BOM）。

规则和 tools.py 一样：固定接口路径、ID 先校验、写操作先给用户看由系统数据整理的汇总、
确认后才执行、没有删除工具。
"""
from __future__ import annotations

from typing import Any

from . import client
from .client import MesError, check_id
from .tools import PRICING, S, _confirm, _items, _num, _out, _product, _reg, _wrap, obj

ATTRIBUTE = {"manufactured": "自制", "purchased": "外购", "outsourced": "外协"}


async def _units(owner: str) -> dict[str, dict[str, Any]]:
    return {str(u.get("name") or "").strip(): u for u in await _items(owner, "/api/units")}


async def _find_by_code(owner: str, code: str) -> dict[str, Any] | None:
    if not code:
        return None
    rows = await _items(owner, "/api/products", {"q": code[:100], "page_size": "20"})
    return next((r for r in rows if str(r.get("code") or "") == code), None)


async def _find_by_name(owner: str, name: str) -> dict[str, Any] | None:
    rows = await _items(owner, "/api/products", {"q": name[:100], "page_size": "20"})
    return next((r for r in rows if str(r.get("name") or "").strip() == name), None)


async def create_products(ctx, owner, args):
    raw = args.get("items") or []
    if not isinstance(raw, list) or not raw:
        raise MesError("items 不能为空")
    if len(raw) > 30:
        raise MesError("一次最多建 30 个商品")
    units = await _units(owner)
    plan: list[tuple[dict[str, Any], str]] = []
    existing: list[dict[str, Any]] = []
    conflicts: list[dict[str, Any]] = []
    new_units: list[str] = []
    for i, it in enumerate(raw, 1):
        if not isinstance(it, dict):
            raise MesError(f"第 {i} 个商品格式不对")
        name = str(it.get("name") or "").strip()[:200]
        if not name:
            raise MesError(f"第 {i} 个商品没有名称")
        code = str(it.get("code") or "").strip()[:64]
        found = await _find_by_code(owner, code)
        if found:
            existing.append({"id": found.get("id"), "code": found.get("code"), "name": found.get("name"), "existed": True})
            continue
        same = await _find_by_name(owner, name)
        if same:
            # 同名但编号不同：可能是同一个东西，也可能只是重名（规格不同），不能擅自合并
            conflicts.append({"wanted": {"code": code, "name": name, "specification": it.get("specification")},
                              "existing": {"id": same.get("id"), "code": same.get("code"), "name": same.get("name"),
                                           "specification": same.get("specification")}})
            continue
        unit = str(it.get("unit") or "").strip()[:20]
        if unit and unit not in units and unit not in new_units:
            new_units.append(unit)
        attr = str(it.get("attribute") or "purchased")
        if attr not in ATTRIBUTE:
            raise MesError("attribute 只能是 manufactured（自制）/ purchased（外购）/ outsourced（外协）")
        body: dict[str, Any] = {"name": name, "attribute": attr}
        if code:
            body["code"] = code
        spec = str(it.get("specification") or "").strip()[:500]
        if spec:
            body["specification"] = spec
        if it.get("cost_price") not in (None, ""):
            body["cost_price"] = _num(it["cost_price"], f"{name} 的单价", positive=False)
        plan.append((body, unit))
    ask = ("有同名不同编号的商品，没有新建也没有替换：用 clarify 问用户，是沿用已有的那个，还是改个名字新建。"
           "用户没确认前，不要拿已有商品顶替。") if conflicts else None
    if not plan:
        return _out({"ok": True, "items": existing, "conflicts": conflicts,
                     "message": ask or "这些商品系统里都已经有了，没有新建。"})
    lines = [f"新建 {len(plan)} 个商品："]
    for body, unit in plan:
        lines.append(f"· {body.get('code') or '(自动编号)'} {body['name']}"
                     f"{'  ' + body['specification'] if body.get('specification') else ''}"
                     f"  {unit or '默认单位'}  {ATTRIBUTE[body['attribute']]}"
                     f"{'  单价 ' + body['cost_price'] if body.get('cost_price') else ''}")
    if new_units:
        lines.append("同时新建单位：" + "、".join(new_units))
    if existing:
        lines.append("已存在、不重复建：" + "、".join(f"{e['code']} {e['name']}" for e in existing))
    if conflicts:
        lines.append("名称和已有商品重复、先不建：" + "、".join(
            f"{c['wanted']['name']}（已有 {c['existing']['code']}）" for c in conflicts))
    if not await _confirm(ctx, "批量新建商品", lines):
        return _out({"cancelled": True, "message": "用户没有确认，商品没有创建。"})
    for name in new_units:
        data = await client.call(owner, "POST", "/api/units", body={"code": f"U{client.request_key()[:8].upper()}", "name": name})
        units[name] = (data or {}).get("unit") or {}
    created = []
    for body, unit in plan:
        if unit and units.get(unit, {}).get("id"):
            body["unit_id"] = units[unit]["id"]
        try:
            data = await client.call(owner, "POST", "/api/products", body=body)
        except MesError as e:
            created.append({"name": body["name"], "error": e.message})
            continue
        p = (data or {}).get("product") or data or {}
        created.append({"id": p.get("id"), "code": p.get("code"), "name": p.get("name")})
    return _out({"ok": True, "items": existing + created, **({"conflicts": conflicts, "message": ask} if conflicts else {})})


async def create_processes(ctx, owner, args):
    raw = args.get("items") or []
    if not isinstance(raw, list) or not raw:
        raise MesError("items 不能为空")
    if len(raw) > 30:
        raise MesError("一次最多建 30 道工序")
    have = {str(p.get("name") or "").strip(): p for p in await _items(owner, "/api/processes")}
    plan: list[dict[str, Any]] = []
    existing: list[dict[str, Any]] = []
    for i, it in enumerate(raw, 1):
        it = it if isinstance(it, dict) else {}
        name = str(it.get("name") or "").strip()[:100]
        if not name:
            raise MesError(f"第 {i} 道工序没有名称")
        if name in have:
            existing.append({"id": have[name].get("id"), "name": name, "existed": True})
            continue
        mode = str(it.get("pricing_mode") or "piece")
        if mode not in PRICING:
            raise MesError("计价方式只能是 piece（计件）或 time（计时）")
        body: dict[str, Any] = {"name": name, "standard_minutes": _num(it.get("standard_minutes") or "1", f"{name} 的标准工时"),
                                "pricing_mode": mode}
        if it.get("wage_rate") not in (None, ""):
            body["wage_rate"] = _num(it["wage_rate"], f"{name} 的工资单价", positive=False)
        plan.append(body)
    if not plan:
        return _out({"ok": True, "items": existing, "message": "这些工序系统里都已经有了，没有新建。"})
    lines = [f"新建 {len(plan)} 道工序："] + [
        f"· {b['name']}  {b['standard_minutes']} 分钟/件  {PRICING[b['pricing_mode']]}"
        f"{'  ' + b['wage_rate'] + ' 元' if b.get('wage_rate') else ''}" for b in plan]
    if existing:
        lines.append("已存在、直接用：" + "、".join(e["name"] for e in existing))
    if not await _confirm(ctx, "批量新建工序", lines):
        return _out({"cancelled": True, "message": "用户没有确认，工序没有创建。"})
    created = []
    for body in plan:
        try:
            data = await client.call(owner, "POST", "/api/processes", body=body)
        except MesError as e:
            created.append({"name": body["name"], "error": e.message})
            continue
        p = (data or {}).get("process") or data or {}
        created.append({"id": p.get("id"), "code": p.get("code"), "name": p.get("name")})
    by_name = {e["name"]: e for e in existing + created}
    ordered = [by_name.get(str((it or {}).get("name") or "").strip()[:100]) for it in raw if isinstance(it, dict)]
    return _out({"ok": True, "items": ordered})


async def create_route(ctx, owner, args):
    name = str(args.get("name") or "").strip()[:200]
    if not name:
        raise MesError("工艺路线名称不能为空")
    ids = [check_id(p, "工序ID") for p in (args.get("process_ids") or [])][:100]
    if not ids:
        raise MesError("process_ids 不能为空（按先后顺序）")
    procs = {p["id"]: p for p in await _items(owner, "/api/processes")}
    missing = [i for i in ids if i not in procs]
    if missing:
        raise MesError(f"工序 {missing[0]} 不存在，先用 mes_list_processes 查 ID")
    code = str(args.get("code") or "").strip()[:64] or f"RT{client.request_key()[:8].upper()}"
    lines = [f"路线名称：{name}", f"路线编号：{code}",
             "工序顺序：" + " → ".join(str(procs[i].get("name")) for i in ids), "最后一道工序完成后自动入库"]
    if not await _confirm(ctx, "新建工艺路线", lines):
        return _out({"cancelled": True, "message": "用户没有确认，工艺路线没有创建。"})
    steps = [{"process_id": pid, "auto_inbound": n == len(ids) - 1} for n, pid in enumerate(ids)]
    data = await client.call(owner, "POST", "/api/routes",
                             body={"request_key": client.request_key(), "code": code, "name": name, "steps": steps})
    r = (data or {}).get("route") or {}
    return _out({"ok": True, "route": {"route_id": r.get("id"), "code": r.get("code"), "name": r.get("name"),
                                       "route_version_id": r.get("current_version_id")}})


async def create_bom(ctx, owner, args):
    parent = await _product(owner, args.get("product_id"))
    if not parent.get("id"):
        raise MesError("找不到成品商品")
    raw = args.get("items") or []
    if not isinstance(raw, list) or not raw:
        raise MesError("items 不能为空")
    if len(raw) > 200:
        raise MesError("一个 BOM 最多 200 行")
    items: list[dict[str, Any]] = []
    lines = [f"成品：{parent.get('code')} {parent.get('name')}", "用料（每 1 个成品）："]
    for i, it in enumerate(raw, 1):
        it = it if isinstance(it, dict) else {}
        comp = await _product(owner, it.get("product_id"))
        if not comp.get("id"):
            raise MesError(f"第 {i} 行物料找不到")
        if comp["id"] == parent["id"]:
            raise MesError("物料不能是成品自己")
        qty = _num(it.get("quantity"), f"{comp.get('name')} 的用量")
        row: dict[str, Any] = {"component_product_id": comp["id"], "quantity": qty}
        if it.get("loss_rate") not in (None, ""):
            row["loss_rate"] = _num(it["loss_rate"], "损耗率", positive=False)
        items.append(row)
        lines.append(f"· {comp.get('code')} {comp.get('name')}  {qty} {comp.get('unit_name') or ''}".rstrip())
    body: dict[str, Any] = {"request_key": client.request_key(), "parent_product_id": parent["id"], "items": items}
    if args.get("route_version_id"):
        body["route_version_id"] = check_id(args["route_version_id"], "工艺路线版本ID")
        lines.append("关联工艺路线：是")
    if not await _confirm(ctx, "新建 BOM", lines):
        return _out({"cancelled": True, "message": "用户没有确认，BOM 没有创建。"})
    data = await client.call(owner, "POST", "/api/boms", body=body)
    b = (data or {}).get("bom") or {}
    return _out({"ok": True, "bom": {"bom_id": b.get("id"), "bom_version_id": b.get("current_version_id"),
                                     "items": b.get("items_count")}})


_reg("mes_create_products",
     "批量新建商品/物料（最多 30 个，读 BOM 表、图纸用料清单、下单表时用）。按编号查重，已有的不重复建；单位不存在会一起建。"
     "成品用 attribute=manufactured（自制，才能建 BOM），原材料/辅料用 purchased（外购）。会先让用户确认。",
     obj({"items": {"type": "array", "items": obj({"code": S, "name": S, "specification": S, "unit": S,
                                                   "attribute": {"type": "string", "enum": list(ATTRIBUTE)},
                                                   "cost_price": S}, ["name"])}}, ["items"]),
     _wrap(create_products))
_reg("mes_create_processes",
     "批量新建工序（最多 30 道，读图纸工艺路线时用）。按名称查重，已有的直接返回 ID；返回的 items 和传入顺序一一对应。"
     "standard_minutes 填工时（分钟/件）。会先让用户确认。",
     obj({"items": {"type": "array", "items": obj({"name": S, "standard_minutes": S,
                                                   "pricing_mode": {"type": "string", "enum": ["piece", "time"]},
                                                   "wage_rate": S}, ["name"])}}, ["items"]),
     _wrap(create_processes))
_reg("mes_create_route", "新建工艺路线：按先后顺序传工序 ID。返回 route_version_id（开加工单、建 BOM 时用）。会先让用户确认。",
     obj({"name": S, "code": S, "process_ids": {"type": "array", "items": S}}, ["name", "process_ids"]), _wrap(create_route))
_reg("mes_create_bom",
     "给成品（必须是自制商品）建 BOM：items 每行是物料商品 ID 和每 1 个成品的用量。可关联工艺路线。会先让用户确认。",
     obj({"product_id": S, "route_version_id": S,
          "items": {"type": "array", "items": obj({"product_id": S, "quantity": S, "loss_rate": S},
                                                  ["product_id", "quantity"])}}, ["product_id", "items"]),
     _wrap(create_bom))
