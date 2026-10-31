import type { FastifyInstance } from 'fastify';
import type { Sql } from './database.js';
import { Problem, type Actor, type Services } from './services.js';
import { bodyOf, clean, idOf, withTenant } from './round8-kit.js';

const DEFAULT_FORMULA = 'case(${任务.计价方式}=="计件",${报工.良品数}*${报工.工资单价};${任务.计价方式}=="计时",${报工.报工时长}/3600*${报工.工资单价})';

export type PerfMatch = {
  id: string;
  wage_rate: string;
  formula: string;
  param1: string;
  param2: string;
  param3: string;
  param4: string;
  param5: string;
  priority: number;
  fields: string[];
};

/** 绩效公式求值（支持原版 case / 比较 / 四则运算，禁止 eval） */
export function evaluateWageFormula(expression: string, vars: Record<string, string | number>): string {
  const src = expression.trim();
  if (!src) throw new Problem(422, 'FORMULA', '公式格式不正确：空公式');
  const replaced = src.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
    if (!(name in vars)) throw new Problem(422, 'FORMULA', `公式格式不正确：未知变量 ${name}`);
    const value = vars[name];
    if (typeof value === 'number') return String(value);
    const text = String(value);
    // 良品数/单价等以字符串传入时仍按数字代入，否则 "100"*"0.6" 会在算术处报错（T34 工资回归用字符串数量）
    if (/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return text;
    return JSON.stringify(text);
  });
  function parse(expr: string): number {
    const text = expr.trim();
    const caseMatch = /^case\((.*)\)$/s.exec(text);
    if (caseMatch) {
      const inner = caseMatch[1]!;
      const segs = splitTop(inner, ';');
      if (segs.length > 1) {
        for (const seg of segs) {
          const idx = firstTopComma(seg);
          if (idx < 0) return parse(seg);
          if (truthy(seg.slice(0, idx))) return parse(seg.slice(idx + 1));
        }
        throw new Problem(422, 'FORMULA', '公式格式不正确：case 无匹配分支');
      }
      const parts = splitTop(inner, ',');
      for (let i = 0; i + 1 < parts.length; i += 2) {
        if (truthy(parts[i]!)) return parse(parts[i + 1]!);
      }
      if (parts.length % 2 === 1) return parse(parts[parts.length - 1]!);
      throw new Problem(422, 'FORMULA', '公式格式不正确：case 无匹配分支');
    }
    return arith(text);
  }
  function truthy(cond: string): boolean {
    const c = cond.trim();
    const eq = splitTop(c, '==');
    if (eq.length === 2) return String(parseMaybe(eq[0]!)) === String(parseMaybe(eq[1]!));
    const ne = splitTop(c, '!=');
    if (ne.length === 2) return String(parseMaybe(ne[0]!)) !== String(parseMaybe(ne[1]!));
    return Number(arith(c)) !== 0;
  }
  function parseMaybe(token: string): string | number {
    const t = token.trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
    return arith(t);
  }
  function arith(expr: string): number {
    const tokens = tokenize(expr);
    let i = 0;
    function peek() { return tokens[i]; }
    function take() { return tokens[i++]; }
    function parseExpr(): number {
      let v = parseTerm();
      while (peek() === '+' || peek() === '-') {
        const op = take();
        const r = parseTerm();
        v = op === '+' ? v + r : v - r;
      }
      return v;
    }
    function parseTerm(): number {
      let v = parseFactor();
      while (peek() === '*' || peek() === '/') {
        const op = take();
        const r = parseFactor();
        if (op === '/') {
          if (r === 0) throw new Problem(422, 'FORMULA', '公式格式不正确：除数为0');
          v = v / r;
        } else v = v * r;
      }
      return v;
    }
    function parseFactor(): number {
      const t = take();
      if (t === '(') {
        const v = parseExpr();
        if (take() !== ')') throw new Problem(422, 'FORMULA', '公式格式不正确：括号不匹配');
        return v;
      }
      if (t === '-') return -parseFactor();
      if (t === undefined) throw new Problem(422, 'FORMULA', '公式格式不正确：表达式不完整');
      if (/^".*"$/.test(t) || /^'.*'$/.test(t)) throw new Problem(422, 'FORMULA', '公式格式不正确：算术处出现字符串');
      if (!/^-?(?:\d+)(?:\.\d+)?$/.test(t)) throw new Problem(422, 'FORMULA', `公式格式不正确：${t}`);
      return Number(t);
    }
    const value = parseExpr();
    if (i < tokens.length) throw new Problem(422, 'FORMULA', '公式格式不正确：多余内容');
    if (!Number.isFinite(value)) throw new Problem(422, 'FORMULA', '公式格式不正确：结果无效');
    return value;
  }
  function tokenize(expr: string): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < expr.length) {
      const ch = expr[i]!;
      if (/\s/.test(ch)) { i += 1; continue; }
      if ('+-*/()'.includes(ch)) { out.push(ch); i += 1; continue; }
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        while (j < expr.length && expr[j] !== ch) j += 1;
        if (j >= expr.length) throw new Problem(422, 'FORMULA', '公式格式不正确：字符串未闭合');
        out.push(expr.slice(i, j + 1));
        i = j + 1;
        continue;
      }
      if (/[0-9.]/.test(ch)) {
        let j = i + 1;
        while (j < expr.length && /[0-9.]/.test(expr[j]!)) j += 1;
        out.push(expr.slice(i, j));
        i = j;
        continue;
      }
      throw new Problem(422, 'FORMULA', `公式格式不正确：非法字符 ${ch}`);
    }
    return out;
  }
  function splitTop(text: string, sep: string): string[] {
    const out: string[] = [];
    let depth = 0, start = 0;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]!;
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (depth === 0 && text.startsWith(sep, i)) {
        out.push(text.slice(start, i));
        i += sep.length - 1;
        start = i + 1;
      }
    }
    out.push(text.slice(start));
    return out.map((s) => s.trim()).filter(Boolean);
  }
  function firstTopComma(text: string): number {
    let depth = 0;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]!;
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (ch === ',' && depth === 0) return i;
    }
    return -1;
  }
  try {
    const n = parse(replaced);
    return Number(n).toFixed(8).replace(/\.?0+$/, (m) => (m.startsWith('.') ? '' : m));
  } catch (error) {
    if (error instanceof Problem) throw error;
    throw new Problem(422, 'FORMULA', `公式格式不正确：${String(error).slice(0, 80)}`);
  }
}

/** numeric(20,8) 读出带 8 位小数，freezeWage/rate 最多 7 位。去尾零后再交给报工冻结。 */
function wageRateText(value: unknown) {
  const raw = String(value ?? '').trim();
  if (/^(?:0|[1-9]\d{0,13})(?:\.\d{1,7})?$/.test(raw)) return raw;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return raw;
  return n.toFixed(7).replace(/\.?0+$/, '') || '0';
}

export async function matchPerformance(sql: Sql, ctx: {
  processName: string;
  pricingMode: string;
  productName: string;
  productCode: string;
  productSpec: string;
  userName: string;
}): Promise<PerfMatch | null> {
  const settings = (await sql.query<{ settings: Record<string, unknown> }>('SELECT settings FROM produce_settings')).rows[0];
  if (settings?.settings?.process_price_formula === true) return null;
  const rules = (await sql.query<{ priority: number; fields: string[] }>("SELECT priority,fields FROM performance_match_rules WHERE status='active' ORDER BY priority")).rows;
  if (!rules.length) return null;
  const rows = (await sql.query<Record<string, unknown>>('SELECT * FROM performance_pay_rows ORDER BY created_at DESC')).rows;
  for (const rule of rules) {
    const hit = rows.find((row) => rule.fields.every((field) => {
      if (field === '工序.工序名') return String(row.process_name) === ctx.processName;
      if (field === '工序.计价方式') return String(row.pricing_mode) === ctx.pricingMode;
      if (field === '商品.商品名称') return String(row.product_name) === ctx.productName;
      if (field === '商品.商品编号') return String(row.product_code) === ctx.productCode;
      if (field === '商品.商品规格') return String(row.product_spec) === ctx.productSpec;
      if (field === '用户.姓名') return String(row.user_name) === ctx.userName;
      return false;
    }));
    if (hit) {
      const formula = (await sql.query<{ expression: string }>('SELECT expression FROM performance_formulas')).rows[0]?.expression ?? DEFAULT_FORMULA;
      return {
        id: String(hit.id),
        wage_rate: wageRateText(hit.wage_rate),
        formula,
        param1: String(hit.param1 ?? ''),
        param2: String(hit.param2 ?? ''),
        param3: String(hit.param3 ?? ''),
        param4: String(hit.param4 ?? ''),
        param5: String(hit.param5 ?? ''),
        priority: rule.priority,
        fields: rule.fields,
      };
    }
  }
  return null;
}

export function applyPerformance(wage: Record<string, unknown>, match: PerfMatch, vars: {
  good: string; defect: string; total: string; seconds: number; pricingMode: string;
}) {
  const env: Record<string, string | number> = {
    '报工.良品数': vars.good,
    '报工.不良品数': vars.defect,
    '报工.报工数': vars.total,
    '报工.报工时长': vars.seconds,
    '报工.工资单价': match.wage_rate,
    '任务.计价方式': vars.pricingMode === 'piece' ? '计件' : vars.pricingMode === 'time' ? '计时' : vars.pricingMode,
    '绩效.参数1': match.param1,
    '绩效.参数2': match.param2,
    '绩效.参数3': match.param3,
    '绩效.参数4': match.param4,
    '绩效.参数5': match.param5,
  };
  const amount = evaluateWageFormula(match.formula, env);
  const cents = Math.round(Number(amount) * 100);
  wage.amount = (cents / 100).toFixed(2);
  wage.amount_cents = String(cents);
  wage.rate = match.wage_rate;
  wage.performance_id = match.id;
  wage.performance_formula = match.formula;
  wage.performance_params = [match.param1, match.param2, match.param3, match.param4, match.param5];
  wage.performance_priority = match.priority;
  wage.performance_amount = wage.amount;
  return wage;
}

export function registerPerformancePay(app: FastifyInstance, services: Services) {
  const read = (request: Parameters<typeof withTenant>[1], work: Parameters<typeof withTenant>[3]) => withTenant(services, request, 'production.read', work);
  const write = (request: Parameters<typeof withTenant>[1], work: Parameters<typeof withTenant>[3]) => withTenant(services, request, 'production.write', work);

  app.get('/api/performance-pay', (request) => read(request, async (sql) => {
    const items = (await sql.query('SELECT r.*, coalesce(u.display_name,\'\') AS creator_name, coalesce(uu.display_name,\'\') AS updater_name FROM performance_pay_rows r LEFT JOIN tenant_team_members u ON u.id=r.created_by LEFT JOIN tenant_team_members uu ON uu.id=r.updated_by ORDER BY r.created_at DESC')).rows;
    return { items };
  }));
  app.post('/api/performance-pay', async (request, reply) => reply.code(201).send(await write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const wage = clean(body.wage_rate, 40, '工资单价(元)', true);
    if (!/^(?:0|[1-9]\d{0,13})(?:\.\d{1,8})?$/.test(wage)) throw new Problem(422, 'RATE', '请填写工资单价(元)');
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date()).replace(/-/g, '');
    const n = (await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM performance_pay_rows WHERE code LIKE $1', [`${day}%`])).rows[0]!.n;
    const code = clean(body.code, 64, '编号') || `${day}${String(Number(n) + 1).padStart(3, '0')}`;
    const id = (await sql.query<{ id: string }>(`INSERT INTO performance_pay_rows(tenant_id,code,process_name,pricing_mode,product_id,product_name,product_code,product_spec,user_name,wage_rate,std_output,std_output_unit,std_hours,param1,param2,param3,param4,param5,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19) RETURNING id`, [
      actor.tenant_id, code, clean(body.process_name, 80, '工序名'), clean(body.pricing_mode, 20, '计价方式'),
      clean(body.product_id, 80, '商品') || null, clean(body.product_name, 80, '商品'), clean(body.product_code, 64, '商品编号'), clean(body.product_spec, 80, '商品规格'),
      clean(body.user_name, 80, '姓名'), wage, body.std_output ?? null, clean(body.std_output_unit, 20, '单位') || '小时', body.std_hours ?? null,
      clean(body.param1, 80, '参数1'), clean(body.param2, 80, '参数2'), clean(body.param3, 80, '参数3'), clean(body.param4, 80, '参数4'), clean(body.param5, 80, '参数5'),
      actor.user_id,
    ])).rows[0]!.id;
    return { id, code };
  })));
  app.delete('/api/performance-pay/:id', (request) => write(request, async (sql) => {
    if (!(await sql.query('DELETE FROM performance_pay_rows WHERE id=$1 RETURNING id', [idOf(request)])).rows[0]) throw new Problem(404, 'NOT_FOUND', '绩效行不存在');
    return { ok: true };
  }));
  app.get('/api/performance-pay/match-rules', (request) => read(request, async (sql) => {
    const active = (await sql.query("SELECT * FROM performance_match_rules WHERE status='active' ORDER BY priority")).rows;
    const draft = (await sql.query("SELECT * FROM performance_match_rules WHERE status='draft' ORDER BY priority")).rows;
    return { active, draft };
  }));
  app.put('/api/performance-pay/match-rules', (request) => write(request, async (sql, actor) => {
    const body = bodyOf(request);
    const status = clean(body.status, 20, '状态') || 'draft';
    const rules = Array.isArray(body.rules) ? body.rules as { fields: string[] }[] : [];
    await sql.query('DELETE FROM performance_match_rules WHERE status=$1', [status]);
    let p = 1;
    for (const rule of rules) {
      await sql.query('INSERT INTO performance_match_rules(tenant_id,status,priority,fields) VALUES($1,$2,$3,$4)', [actor.tenant_id, status, p++, rule.fields ?? []]);
    }
    if (body.apply === true) {
      await sql.query("DELETE FROM performance_match_rules WHERE status='active'");
      await sql.query("UPDATE performance_match_rules SET status='active' WHERE status='draft'");
    }
    return { ok: true };
  }));
  app.get('/api/performance-pay/formula', (request) => read(request, async (sql) => {
    const row = (await sql.query<{ expression: string; scale: number }>('SELECT expression,scale FROM performance_formulas')).rows[0];
    return { expression: row?.expression ?? DEFAULT_FORMULA, scale: row?.scale ?? 2 };
  }));
  app.put('/api/performance-pay/formula', (request) => write(request, async (sql, actor) => {
    const expression = clean(bodyOf(request).expression, 2000, '公式', true);
    try {
      evaluateWageFormula(expression, {
        '报工.良品数': '1', '报工.不良品数': '0', '报工.报工数': '1', '报工.报工时长': 3600,
        '报工.工资单价': '1', '任务.计价方式': '计件',
        '绩效.参数1': '0', '绩效.参数2': '0', '绩效.参数3': '0', '绩效.参数4': '0', '绩效.参数5': '0',
      });
    } catch (error) {
      throw new Problem(422, 'FORMULA', error instanceof Problem ? error.message : `公式格式不正确：${String(error).slice(0, 80)}`);
    }
    await sql.query('INSERT INTO performance_formulas(tenant_id,expression,scale) VALUES($1,$2,$3) ON CONFLICT (tenant_id) DO UPDATE SET expression=$2,scale=$3,updated_at=now()', [actor.tenant_id, expression, Number(bodyOf(request).scale ?? 2) || 2]);
    return { ok: true };
  }));
}

export async function ensureDefaultPerfRules(sql: Sql, actor: Actor) {
  const n = (await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM performance_match_rules')).rows[0]!.n;
  if (Number(n) > 0) return;
  await sql.query("INSERT INTO performance_match_rules(tenant_id,status,priority,fields) VALUES($1,'active',1,$2),($1,'active',2,$3)", [
    actor.tenant_id,
    ['工序.工序名', '商品.商品名称', '用户.姓名'],
    ['工序.工序名', '工序.计价方式'],
  ]);
  await sql.query('INSERT INTO performance_formulas(tenant_id,expression,scale) VALUES($1,$2,2) ON CONFLICT DO NOTHING', [actor.tenant_id, DEFAULT_FORMULA]);
}
