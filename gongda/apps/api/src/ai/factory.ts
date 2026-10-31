import type { Sql } from '../database.js';
import { money } from '../business-common.js';
import { Problem, type Actor } from '../services.js';
import { readAiConfig, type AiConfig } from './config.js';
import { loadKnowledge, searchKnowledge, searchKnowledgeTop } from './knowledge.js';
import { workOrderOverdueSql } from '../progress-calc.js';

export type FactoryIntent =
  | 'progress'
  | 'money'
  | 'wage'
  | 'triple'
  | 'guide'
  | 'refuse_write'
  | 'open';

/** MES 深链：聊天「去处理」打开真实模块（只导航，不写库） */
export const FACTORY_ACTION_PATHS = {
  progress: '/inside_produce_bill/list',
  money: '/customer_financier/list',
  wage: '/work_repoty_record/list',
} as const;

export type FactoryCard = {
  title: string;
  value: string;
  hint?: string;
  action_path?: string;
  action_label?: string;
};
export type FactoryTable = { columns: string[]; rows: string[][] };
export type FactoryBook = {
  intent: 'progress' | 'money' | 'wage';
  title: string;
  answer: string;
  cards?: FactoryCard[];
  action_path: string;
  action_label: string;
};
/** 一屏异常：延期 / 未收风险 / 工资待审（只读，现有表字段） */
export type FactoryAnomaly = {
  kind: 'overdue' | 'receivable_risk' | 'wage_pending';
  title: string;
  value: string;
  hint?: string;
  action_path: string;
  action_label: string;
  severity: 'warn' | 'info';
};
export type FactoryAskResult = {
  answer: string;
  /** 首行核心结论，便于聊天卡加粗展示 */
  conclusion?: string;
  cards?: FactoryCard[];
  table?: FactoryTable;
  intent: FactoryIntent;
  citations?: { id: string; title: string }[];
  provider: string;
  /** 单意图时的「去处理」深链 */
  action_path?: string;
  action_label?: string;
  /** 三本账：进度 / 钱 / 工资 三组只读摘要 */
  books?: FactoryBook[];
  /** 异常摘要（延期、未收、工资待审） */
  anomalies?: FactoryAnomaly[];
};

const EXEC_LABEL: Record<string, string> = {
  not_started: '未开始',
  running: '生产中',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
};

const WRITE_PATTERNS = [
  /(创建|新建|开|下达).*(加工单|销售订单|采购|报工|收货|出库|入库)/,
  /(帮我|替我|请).*(报工|审核|删除|作废|冲销|结算|付款|收款|入库|出库)/,
  /(提交|写入|修改|更新|删除).*(单据|工单|订单|工资)/,
  /写(一[张个]|个)?(单|单据)/,
];

const HOWTO_PATTERNS = [
  /怎么(报工|创建|开单|审核|结算)/,
  /如何(报工|创建|开单|审核|结算)/,
  /(报工|创建销售|创建加工).*(步骤|流程|入口|用法)/,
  /教我(报工|开单)/,
];

const MONEY_PATTERNS = [
  /应收|应付|未收|未付|回款|往来|财务|欠款/,
  /还欠|欠多少|欠款多少|还有多少钱|钱还欠/,
  /(钱|款).*(多少|还有|合计)/,
  /(多少|还有).*(未收|应收|应付|钱|款)/,
  /客户欠|谁欠(我们|钱)|催款|回款怎么样|账上.*(多少|还有)/,
  /超应收|未收风险|应收风险|欠款概况/,
];

const WAGE_PATTERNS = [
  /工资|工价|计件|待审.*工资|工资.*待审|已结.*工资|工资.*已结|结算工资/,
  /工资.*(有没有|有无|吗|没).*(待审)?|待审.*(有没有|吗)/,
  /(发了多少|发多少).*(工资|钱)/,
  /报工待审|有待审吗|工资结了没|工资结清|计件工资|待结算工资/,
  /本月工资|工资概况|工资怎么样/,
];

const PROGRESS_PATTERNS = [
  /进度|在产|生产中/,
  /进度怎么样|做到哪|产线怎么样|生产怎么样/,
  /今天.*(生产|进度)/,
  // 「加工单/工单」单独出现时易与开单 FAQ 混淆：须带问数语气
  /(加工单|工单).*(进度|怎么样|多少|几|概况|在产)/,
  /(多少|几).*(加工单|工单|在产)/,
  /产线忙不忙|在产多少|单子做到哪|有没有延期|延期几[张单]|超期几|延期单/,
  /生产概况|厂里进度|订单进度/,
];

/** 手动查齐三本账 */
const TRIPLE_PATTERNS = [
  /三本账/,
  /查一下三本账|查下三本账|看看三本账/,
  /厂长三本账|盯三本账|厂长看板/,
  /(进度|生产).*(应收|欠款|钱|工资).*(工资|应收|欠款|钱|进度)/,
  /今天(有啥|有什么)?异常|异常摘要|一屏(三本|风险)|今天风险|风险一览/,
];

/** 经营概况 / 质量 / 今天怎样 → mock 下走今日简报 */
const BRIEFING_PATTERNS = [
  /质量|良品|不良|检验|IQC|抽检|全检/,
  /(今天|本周|这周|当前).*(厂|工厂|整体|经营|概况|情况|怎样|怎么样)/,
  /(厂里|工厂).*(整体|怎样|怎么样|概况|情况)/,
  /今日简报|经营概况|整体怎样/,
];

function compact(text: string) {
  return text.replace(/\s+/g, '');
}

export function detectFactoryIntent(question: string): FactoryIntent {
  const t = compact(question);
  if (!t) return 'guide';
  if (WRITE_PATTERNS.some((re) => re.test(t))) return 'refuse_write';
  // 三本账优先于单本账，避免「查一下三本账」被进度词抢走
  if (TRIPLE_PATTERNS.some((re) => re.test(t))) return 'triple';
  if (MONEY_PATTERNS.some((re) => re.test(t))) return 'money';
  if (WAGE_PATTERNS.some((re) => re.test(t))) return 'wage';
  if (PROGRESS_PATTERNS.some((re) => re.test(t))) return 'progress';
  // howto / 闲聊 / 质量与概况等一律进入开放路径（不再只回罐头 guide）
  if (HOWTO_PATTERNS.some((re) => re.test(t))) return 'open';
  if (BRIEFING_PATTERNS.some((re) => re.test(t))) return 'open';
  return 'open';
}

function withAction(
  result: FactoryAskResult,
  kind: 'progress' | 'money' | 'wage',
): FactoryAskResult {
  const action_path = FACTORY_ACTION_PATHS[kind];
  const action_label = '去处理';
  const cards = (result.cards ?? []).map((card) => ({
    ...card,
    action_path: card.action_path ?? action_path,
    action_label: card.action_label ?? action_label,
  }));
  return { ...result, cards, action_path, action_label };
}

function withConclusion(result: FactoryAskResult, conclusion: string): FactoryAskResult {
  const clean = conclusion.replace(/\s+/g, ' ').trim();
  const body = result.answer.startsWith('【核心结论】')
    ? result.answer
    : `【核心结论】${clean}\n详情：${result.answer}`;
  return { ...result, conclusion: clean, answer: body };
}

/** 只读异常摘要：延期加工单 / 未收余额 / 报工待审（无信用额字段则不声称「超限」） */
async function queryAnomalies(sql: Sql, actor: Actor): Promise<FactoryAnomaly[]> {
  const out: FactoryAnomaly[] = [];
  if (hasPerm(actor, 'production.read')) {
    try {
      const overdueSql = workOrderOverdueSql('w');
      const row = (
        await sql.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM work_orders w WHERE ${overdueSql}`,
        )
      ).rows[0];
      const n = Number(row?.n ?? '0');
      out.push({
        kind: 'overdue',
        title: '延期加工单',
        value: `${n} 张`,
        hint: n > 0 ? '计划完工/交期早于今天且未完成' : '暂无延期',
        action_path: FACTORY_ACTION_PATHS.progress,
        action_label: '去处理',
        severity: n > 0 ? 'warn' : 'info',
      });
    } catch {
      /* 读失败跳过 */
    }
  }
  if (hasPerm(actor, 'finance.read')) {
    try {
      const debts = (
        await sql.query<{ debt: string; settled: string }>(
          `SELECT coalesce(sum(e.debt_cents),0)::text AS debt,
                  coalesce(sum(e.settled_cents),0)::text AS settled
           FROM financial_events e
           JOIN open_items i ON i.tenant_id=e.tenant_id AND i.id=e.open_item_id
           WHERE i.kind='receivable'`,
        )
      ).rows[0];
      const outstanding = BigInt(debts?.debt ?? '0') - BigInt(debts?.settled ?? '0');
      const amt = money(outstanding < 0n ? 0n : outstanding);
      out.push({
        kind: 'receivable_risk',
        title: '未收余额',
        value: fmtMoney(amt),
        hint: '库内无客户信用额字段，无法判定「超信用」；以未收余额作催收风险提示',
        action_path: FACTORY_ACTION_PATHS.money,
        action_label: '去处理',
        severity: outstanding > 0n ? 'warn' : 'info',
      });
    } catch {
      /* skip */
    }
  }
  if (hasPerm(actor, 'payroll.read')) {
    try {
      const pending = (
        await sql.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM production_reports WHERE approval='pending'`,
        )
      ).rows[0];
      const n = Number(pending?.n ?? '0');
      out.push({
        kind: 'wage_pending',
        title: '报工待审',
        value: `${n} 笔`,
        hint: n > 0 ? '待审核报工会影响工资结算' : '无待审报工',
        action_path: FACTORY_ACTION_PATHS.wage,
        action_label: '去处理',
        severity: n > 0 ? 'warn' : 'info',
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

async function queryTripleBooks(sql: Sql, actor: Actor, question: string): Promise<FactoryAskResult> {
  const snap = await collectSnapshots(sql, actor, question);
  const anomalies = await queryAnomalies(sql, actor);
  const books: FactoryBook[] = [];
  const cards: FactoryCard[] = [];
  const warnBits = anomalies.filter((a) => a.severity === 'warn').map((a) => `${a.title}${a.value}`);
  const conclusion =
    warnBits.length > 0
      ? `今日风险：${warnBits.join('；')}`
      : '今日三本账未见明显异常（延期/未收/待审均为空或零）';
  const parts: string[] = [`【核心结论】${conclusion}`, '【三本账 · 只读摘要】'];

  if (anomalies.length) {
    parts.push(
      '异常一屏：' +
        anomalies.map((a) => `${a.title} ${a.value}${a.hint ? `（${a.hint}）` : ''}`).join('；'),
    );
  }

  if (snap.progress) {
    const ready = withAction(snap.progress, 'progress');
    books.push({
      intent: 'progress',
      title: '生产进度',
      answer: ready.answer,
      cards: ready.cards,
      action_path: FACTORY_ACTION_PATHS.progress,
      action_label: '去处理',
    });
    cards.push(...(ready.cards ?? []).slice(0, 2));
    parts.push(`进度：${ready.answer}`);
  } else {
    parts.push('进度：当前账号无 production.read 或读取失败，已跳过。');
  }
  if (snap.money) {
    const ready = withAction(snap.money, 'money');
    books.push({
      intent: 'money',
      title: '应收欠款',
      answer: ready.answer,
      cards: ready.cards,
      action_path: FACTORY_ACTION_PATHS.money,
      action_label: '去处理',
    });
    cards.push(...(ready.cards ?? []).slice(0, 2));
    parts.push(`钱：${ready.answer}`);
  } else {
    parts.push('钱：当前账号无 finance.read 或读取失败，已跳过。');
  }
  if (snap.wage) {
    const ready = withAction(snap.wage, 'wage');
    books.push({
      intent: 'wage',
      title: '工资待审',
      answer: ready.answer,
      cards: ready.cards,
      action_path: FACTORY_ACTION_PATHS.wage,
      action_label: '去处理',
    });
    cards.push(...(ready.cards ?? []).slice(0, 2));
    parts.push(`工资：${ready.answer}`);
  } else {
    parts.push('工资：当前账号无 payroll.read 或读取失败，已跳过。');
  }
  if (snap.notes.length) parts.push(`说明：${snap.notes.join('；')}`);
  parts.push('点卡片「去处理」仅打开 MES 对应模块，不会替你改数。');

  return {
    answer: parts.join('\n'),
    conclusion,
    cards: cards.slice(0, 8),
    books,
    anomalies,
    intent: 'triple',
    provider: 'rules',
    citations: [
      { id: 'triple_books', title: '厂长三本账（进度/钱/工资）' },
    ],
  };
}

/** 晨报/异常推送接口形状（本冲刺 stub，不真正推送） */
export function factoryBriefingMeta() {
  return {
    supported: ['manual_triple'] as const,
    push: 'reserved' as const,
    channels: ['chat_manual', 'push_reserved'],
    message: '晨报/异常推送接口已预留；本冲刺请用聊天「查一下三本账」手动拉取只读摘要。',
    sample_subscribe: {
      channel: 'push_reserved',
      cron: '0 8 * * 1-6',
      timezone: 'Asia/Shanghai',
      topics: ['progress', 'money', 'wage', 'anomaly'],
    },
  };
}

export function factoryBriefingSubscribe(body: { channel?: unknown; cron?: unknown; topics?: unknown }) {
  const channel = typeof body.channel === 'string' ? body.channel.trim() : 'push_reserved';
  const cron = typeof body.cron === 'string' ? body.cron.trim() : '0 8 * * 1-6';
  const topics = Array.isArray(body.topics)
    ? body.topics.filter((t): t is string => typeof t === 'string').slice(0, 8)
    : ['progress', 'money', 'wage'];
  return {
    ok: true as const,
    status: 'stub' as const,
    channel,
    cron,
    topics,
    message: '已记录订阅意向（stub，不发送推送）。请用「查一下三本账」手动查看。',
  };
}

function extractWorkOrderCode(question: string): string | null {
  const m =
    question.match(/(?:加工单|工单|单号)\s*[：:#]?\s*([A-Za-z]{0,8}\d{3,})/i) ||
    question.match(/\b([A-Z]{2,8}\d{4,})\b/) ||
    question.match(/\b(WO\d+)\b/i);
  return m?.[1]?.trim() ?? null;
}

function fmtMoney(value: string | null | undefined) {
  if (value === null || value === undefined) return '暂无法计价';
  return `¥${value}`;
}

function requirePerm(actor: Actor, permission: string, label: string) {
  if (!actor.permissions.includes(permission)) {
    throw new Problem(403, 'FORBIDDEN', `当前角色没有${label}权限，无法查询相关数据`);
  }
}

function hasPerm(actor: Actor, permission: string) {
  return actor.permissions.includes(permission);
}

async function queryProgress(sql: Sql, question: string): Promise<FactoryAskResult> {
  const code = extractWorkOrderCode(question);
  if (code) {
    const rows = (
      await sql.query<{
        code: string;
        execution: string;
        plan_qty: string;
        product_name: string | null;
      }>(
        `SELECT w.code, w.execution, w.plan_qty::text,
                coalesce(w.product_snapshot->>'name','') AS product_name
         FROM work_orders w
         WHERE w.code ILIKE $1
         ORDER BY w.created_at DESC
         LIMIT 5`,
        [`%${code}%`],
      )
    ).rows;
    if (!rows.length) {
      return {
        answer: `未找到单号含「${code}」的加工单。你可以问「今天生产进度怎么样」，或核对单号后再问。`,
        intent: 'progress',
        provider: 'rules',
        citations: [{ id: 'work_orders', title: '加工单' }],
      };
    }
    const table: FactoryTable = {
      columns: ['单号', '状态', '计划数量', '产品'],
      rows: rows.map((r) => [
        r.code,
        EXEC_LABEL[r.execution] ?? r.execution,
        r.plan_qty,
        r.product_name || '-',
      ]),
    };
    const first = rows[0]!;
    return {
      answer: `查到 ${rows.length} 张相关加工单。例如 ${first.code} 当前状态为「${EXEC_LABEL[first.execution] ?? first.execution}」，计划数量 ${first.plan_qty}${first.product_name ? `，产品 ${first.product_name}` : ''}。`,
      table,
      cards: rows.slice(0, 3).map((r) => ({
        title: r.code,
        value: EXEC_LABEL[r.execution] ?? r.execution,
        hint: r.product_name || undefined,
      })),
      intent: 'progress',
      provider: 'rules',
      citations: [{ id: 'work_orders', title: '加工单' }],
    };
  }

  const statusRows = (
    await sql.query<{ execution: string; n: string }>(
      `SELECT execution, count(*)::text AS n FROM work_orders GROUP BY execution ORDER BY execution`,
    )
  ).rows;
  const total = statusRows.reduce((n, r) => n + Number(r.n), 0);
  const running = Number(statusRows.find((r) => r.execution === 'running')?.n ?? '0');
  const paused = Number(statusRows.find((r) => r.execution === 'paused')?.n ?? '0');
  const notStarted = Number(statusRows.find((r) => r.execution === 'not_started')?.n ?? '0');
  const completed = Number(statusRows.find((r) => r.execution === 'completed')?.n ?? '0');
  const inProd = running + paused;

  const cards: FactoryCard[] = [
    { title: '加工单总数', value: String(total) },
    { title: '在产（生产中+暂停）', value: String(inProd), hint: `生产中 ${running} / 暂停 ${paused}` },
    { title: '未开始', value: String(notStarted) },
    { title: '已完成', value: String(completed) },
  ];
  const table: FactoryTable = {
    columns: ['状态', '数量'],
    rows: statusRows.map((r) => [EXEC_LABEL[r.execution] ?? r.execution, r.n]),
  };
  const conclusion = `在产 ${inProd} 张（生产中 ${running} / 暂停 ${paused}），未开始 ${notStarted}，已完成 ${completed}，共 ${total} 张`;
  return withConclusion(
    {
      answer: `当前共有 ${total} 张加工单，其中在产 ${inProd} 张（生产中 ${running}、暂停 ${paused}），未开始 ${notStarted} 张，已完成 ${completed} 张。`,
      cards,
      table,
      intent: 'progress',
      provider: 'rules',
      citations: [{ id: 'work_orders', title: '加工单执行状态汇总' }],
    },
    conclusion,
  );
}

async function queryMoney(sql: Sql): Promise<FactoryAskResult> {
  const debts = (
    await sql.query<{ kind: string; debt: string; settled: string }>(
      `SELECT i.kind,
              coalesce(sum(e.debt_cents),0)::text AS debt,
              coalesce(sum(e.settled_cents),0)::text AS settled
       FROM financial_events e
       JOIN open_items i ON i.tenant_id=e.tenant_id AND i.id=e.open_item_id
       GROUP BY i.kind`,
    )
  ).rows;
  const cash = (
    await sql.query<{ kind: string; n: string }>(
      `SELECT kind, coalesce(sum(amount_cents),0)::text AS n
       FROM payments WHERE approval='approved' GROUP BY kind`,
    )
  ).rows;
  const legacy = (
    await sql.query<{ missing_trade: string }>(
      `SELECT count(*) FILTER(
         WHERE NOT EXISTS(
           SELECT 1 FROM open_items i
           WHERE i.tenant_id=s.tenant_id AND i.source_type='shipment' AND i.source_id=s.id AND NOT i.reversed
         )
       )::text AS missing_trade
       FROM shipments s WHERE s.approval='approved'`,
    )
  ).rows[0]!;
  const missingTrade = Number(legacy.missing_trade);
  const recvDebt = BigInt(debts.find((r) => r.kind === 'receivable')?.debt ?? '0');
  const recvSettled = BigInt(debts.find((r) => r.kind === 'receivable')?.settled ?? '0');
  const payDebt = BigInt(debts.find((r) => r.kind === 'payable')?.debt ?? '0');
  const paySettled = BigInt(debts.find((r) => r.kind === 'payable')?.settled ?? '0');
  const recvCash = BigInt(cash.find((r) => r.kind === 'receivable')?.n ?? '0');
  const payCash = BigInt(cash.find((r) => r.kind === 'payable')?.n ?? '0');

  const receivable = missingTrade > 0 ? null : money(recvDebt);
  const outstanding = missingTrade > 0 ? null : money(recvDebt - recvSettled);
  const received = money(recvCash);
  const payable = money(payDebt);
  const payableOutstanding = money(payDebt - paySettled);
  const paid = money(payCash);

  const cards: FactoryCard[] = [
    { title: '应收合计', value: fmtMoney(receivable), hint: missingTrade > 0 ? `有 ${missingTrade} 笔发货未挂往来` : undefined },
    { title: '已收', value: fmtMoney(received) },
    { title: '未收', value: fmtMoney(outstanding) },
    { title: '应付合计', value: fmtMoney(payable) },
    { title: '已付', value: fmtMoney(paid) },
    { title: '未付', value: fmtMoney(payableOutstanding) },
  ];
  const table: FactoryTable = {
    columns: ['项目', '金额'],
    rows: cards.map((c) => [c.title, c.value]),
  };
  const answer =
    missingTrade > 0
      ? `应收侧有 ${missingTrade} 笔已审发货尚未挂往来，合计暂无法完整计价。已收 ${fmtMoney(received)}；应付合计 ${fmtMoney(payable)}，未付 ${fmtMoney(payableOutstanding)}。`
      : `应收合计 ${fmtMoney(receivable)}，已收 ${fmtMoney(received)}，未收 ${fmtMoney(outstanding)}；应付合计 ${fmtMoney(payable)}，已付 ${fmtMoney(paid)}，未付 ${fmtMoney(payableOutstanding)}。`;
  const conclusion =
    missingTrade > 0
      ? `应收暂无法完整计价（${missingTrade} 笔发货未挂往来）；已收 ${fmtMoney(received)}`
      : `未收 ${fmtMoney(outstanding)}，已收 ${fmtMoney(received)}，应收合计 ${fmtMoney(receivable)}`;
  return withConclusion(
    {
      answer,
      cards,
      table,
      intent: 'money',
      provider: 'rules',
      citations: [{ id: 'financial_events', title: '往来与收付款汇总' }],
    },
    conclusion,
  );
}

async function queryWage(sql: Sql): Promise<FactoryAskResult> {
  const period = (
    await sql.query<{ total: string }>(
      `SELECT coalesce(sum(amount_cents),0)::text AS total FROM wage_events`,
    )
  ).rows[0]!;
  const pendingApproval = (
    await sql.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM production_reports WHERE approval='pending'`,
    )
  ).rows[0]!;
  const unsettled = (
    await sql.query<{ n: string; amount: string }>(
      `SELECT count(*)::text AS n,
              coalesce(sum((wage_snapshot->>'amount_cents')::numeric) FILTER (WHERE wage_snapshot->>'status'='priced'),0)::text AS amount
       FROM production_reports
       WHERE approval='approved' AND settlement_status='unsettled'`,
    )
  ).rows[0]!;
  const settled = (
    await sql.query<{ n: string; amount: string }>(
      `SELECT count(*)::text AS n,
              coalesce(sum((wage_snapshot->>'amount_cents')::numeric) FILTER (WHERE wage_snapshot->>'status'='priced'),0)::text AS amount
       FROM production_reports
       WHERE approval='approved' AND settlement_status='settled'`,
    )
  ).rows[0]!;

  const periodAmt = money(BigInt(period.total));
  const unsettledAmt = money(BigInt((unsettled.amount ?? '0').split('.')[0] ?? '0'));
  const settledAmt = money(BigInt((settled.amount ?? '0').split('.')[0] ?? '0'));

  const cards: FactoryCard[] = [
    { title: '本期工资源账合计', value: fmtMoney(periodAmt) },
    { title: '报工待审笔数', value: pendingApproval.n },
    { title: '待结（已审未结算）', value: `${unsettled.n} 笔 / ${fmtMoney(unsettledAmt)}` },
    { title: '已结', value: `${settled.n} 笔 / ${fmtMoney(settledAmt)}` },
  ];
  const table: FactoryTable = {
    columns: ['项目', '数值'],
    rows: cards.map((c) => [c.title, c.value]),
  };
  const conclusion = `报工待审 ${pendingApproval.n} 笔；待结 ${unsettled.n} 笔约 ${fmtMoney(unsettledAmt)}；已结 ${settled.n} 笔`;
  return withConclusion(
    {
      answer: `本期工资源账合计 ${fmtMoney(periodAmt)}；报工待审 ${pendingApproval.n} 笔；待结（已审未结算） ${unsettled.n} 笔、约 ${fmtMoney(unsettledAmt)}；已结 ${settled.n} 笔、约 ${fmtMoney(settledAmt)}。`,
      cards,
      table,
      intent: 'wage',
      provider: 'rules',
      citations: [{ id: 'wage_events', title: '工资与报工结算汇总' }],
    },
    conclusion,
  );
}

async function queryQualityBrief(sql: Sql): Promise<{ line: string; cards: FactoryCard[] }> {
  try {
    const iqc = (
      await sql.query<{ pending: string; done: string }>(
        `SELECT
           count(*) FILTER (WHERE state='pending')::text AS pending,
           count(*) FILTER (WHERE state IN ('completed','reversed'))::text AS done
         FROM incoming_inspections`,
      )
    ).rows[0];
    if (iqc) {
      return {
        line: `来料检验：待检 ${iqc.pending} 批，已处理 ${iqc.done} 批。`,
        cards: [
          { title: '来料待检', value: iqc.pending },
          { title: '来料已处理', value: iqc.done },
        ],
      };
    }
  } catch {
    // 表可能不存在于极简库
  }
  return {
    line: '质量侧暂无独立汇总表可读；可问加工单进度，或到「生产管理 → 质检中心 / 供应采购 → 采购检验」查看单据。',
    cards: [{ title: '质量提示', value: '请到质检菜单查看' }],
  };
}

function guideResult(): FactoryAskResult {
  return {
    answer:
      '我是工厂助理，可自由提问三本账（生产进度、应收应付、工资）或经营概况；也可问简单产品用法（我会引用知识库）。不会创建或修改单据；复杂操作步骤请去「赛德瑞克小助手」。例如：「今天生产进度怎么样」「应收还有多少未收」「本周质量怎么样」「今天厂里整体怎样」。',
    intent: 'guide',
    provider: 'rules',
    cards: [
      { title: '可问进度', value: '在产加工单 / 按状态' },
      { title: '可问钱', value: '应收应付概览' },
      { title: '可问工资', value: '本期 / 待审 / 已结' },
      { title: '可问概况', value: '今日简报 / 质量' },
    ],
  };
}

function refuseWriteResult(): FactoryAskResult {
  return {
    answer:
      '工厂助理只读查询，不会创建、审核或修改任何业务单据。若要了解操作步骤，请打开「赛德瑞克小助手」；若要查进度/应收/工资，请直接提问，例如「应收还有多少未收」。',
    intent: 'refuse_write',
    provider: 'rules',
  };
}

async function maybePolish(answer: string, structured: Record<string, unknown>, config: AiConfig): Promise<string> {
  if (config.provider !== 'openai' || !config.apiKey) return answer;
  try {
    const response = await fetch(`${config.openaiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.openaiModel,
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content:
              '你是赛德瑞克工厂助理文案润色器。只能把给定结构化结果改写成通顺中文，禁止增减任何数字或编造未给出的金额/数量。保留原有数字原样。',
          },
          {
            role: 'user',
            content: `结构化结果：${JSON.stringify(structured)}\n草稿：${answer}\n请输出润色后的中文（不要列表标题外的额外段落）。`,
          },
        ],
      }),
    });
    if (!response.ok) return answer;
    const json = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = json.choices?.[0]?.message?.content?.trim();
    return content || answer;
  } catch {
    return answer;
  }
}

type SnapshotBundle = {
  progress?: FactoryAskResult;
  money?: FactoryAskResult;
  wage?: FactoryAskResult;
  quality?: { line: string; cards: FactoryCard[] };
  notes: string[];
};

async function collectSnapshots(sql: Sql, actor: Actor, question: string): Promise<SnapshotBundle> {
  const notes: string[] = [];
  const bundle: SnapshotBundle = { notes };
  if (hasPerm(actor, 'production.read')) {
    try {
      bundle.progress = await queryProgress(sql, question);
    } catch {
      notes.push('生产快照读取失败');
    }
  } else {
    notes.push('无 production.read，已跳过生产快照');
  }
  if (hasPerm(actor, 'finance.read')) {
    try {
      bundle.money = await queryMoney(sql);
    } catch {
      notes.push('财务快照读取失败');
    }
  } else {
    notes.push('无 finance.read，已跳过财务快照');
  }
  if (hasPerm(actor, 'payroll.read')) {
    try {
      bundle.wage = await queryWage(sql);
    } catch {
      notes.push('工资快照读取失败');
    }
  } else {
    notes.push('无 payroll.read，已跳过工资快照');
  }
  if (hasPerm(actor, 'quality.read') || hasPerm(actor, 'production.read')) {
    try {
      bundle.quality = await queryQualityBrief(sql);
    } catch {
      notes.push('质量快照读取失败');
    }
  }
  return bundle;
}

async function openWithOpenai(
  sql: Sql,
  actor: Actor,
  question: string,
  config: AiConfig,
): Promise<FactoryAskResult> {
  const snap = await collectSnapshots(sql, actor, question);
  const kb = searchKnowledgeTop(question, 2);
  const snapshotText = {
    progress: snap.progress
      ? { answer: snap.progress.answer, cards: snap.progress.cards }
      : null,
    money: snap.money ? { answer: snap.money.answer, cards: snap.money.cards } : null,
    wage: snap.wage ? { answer: snap.wage.answer, cards: snap.wage.cards } : null,
    quality: snap.quality ?? null,
    notes: snap.notes,
  };
  const kbText = kb
    .map((h) => `「${h.article.title}」：${h.article.body.slice(0, 1200)}`)
    .join('\n');
  try {
    const response = await fetch(`${config.openaiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.openaiModel,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: [
              '你是赛德瑞克工厂助理，只做只读回答。',
              '禁止编造快照里没有的数字；没有的数据请明确说「快照未提供」。',
              '禁止承诺创建、审核或修改任何单据。',
              '产品操作步骤可简答，并提示去「赛德瑞克小助手」看细节。',
              '用中文简洁回答。',
            ].join('\n'),
          },
          {
            role: 'user',
            content: `用户问题：${question}\n\n只读快照（JSON）：${JSON.stringify(snapshotText)}\n\n可选产品用法参考：\n${kbText || '（无）'}`,
          },
        ],
      }),
    });
    if (!response.ok) throw new Error(`openai_http_${response.status}`);
    const json = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('openai_empty');
    const cards = [
      ...(snap.progress?.cards?.slice(0, 2) ?? []),
      ...(snap.money?.cards?.slice(0, 2) ?? []),
      ...(snap.wage?.cards?.slice(0, 2) ?? []),
      ...(snap.quality?.cards ?? []),
    ].slice(0, 6);
    return {
      answer: content,
      cards: cards.length ? cards : undefined,
      intent: 'open',
      provider: 'openai',
      citations: kb.map((h) => ({ id: h.article.id, title: h.article.title })),
    };
  } catch {
    return openWithMock(sql, actor, question);
  }
}

async function openWithMock(sql: Sql, actor: Actor, question: string): Promise<FactoryAskResult> {
  const t = compact(question);
  loadKnowledge();

  // howto → 知识库用法
  if (HOWTO_PATTERNS.some((re) => re.test(t))) {
    const hit = searchKnowledge(question) ?? searchKnowledgeTop(question, 1)[0] ?? null;
    if (hit) {
      const body = hit.article.body.replace(/^#+\s+/gm, '').trim();
      const short = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).slice(0, 3).join('\n\n');
      return {
        answer: `【用法参考 · ${hit.article.title}】\n\n${short || body}\n\n——\n更细的步骤请打开「赛德瑞克小助手」；查进度/应收/工资可直接继续问我。`,
        intent: 'open',
        provider: 'mock-open',
        citations: [{ id: hit.article.id, title: hit.article.title }],
      };
    }
  }

  // 经营/质量/概况 → 今日简报
  if (BRIEFING_PATTERNS.some((re) => re.test(t)) || /怎样|怎么样|概况|整体|今天|本周/.test(t)) {
    const parts: string[] = ['【今日简报】（有权限的模块才汇总真实数据，不会编造）'];
    const cards: FactoryCard[] = [];
    const citations: { id: string; title: string }[] = [];

    if (hasPerm(actor, 'production.read')) {
      const progress = await queryProgress(sql, question);
      parts.push(`生产：${progress.answer}`);
      cards.push(...(progress.cards ?? []).slice(0, 3));
      citations.push(...(progress.citations ?? []));
    } else {
      parts.push('生产：当前账号无 production.read，已跳过。');
    }
    if (hasPerm(actor, 'finance.read')) {
      const moneyResult = await queryMoney(sql);
      parts.push(`往来：${moneyResult.answer}`);
      cards.push(...(moneyResult.cards ?? []).slice(0, 3));
      citations.push(...(moneyResult.citations ?? []));
    } else {
      parts.push('往来：当前账号无 finance.read，已跳过。');
    }
    if (hasPerm(actor, 'payroll.read')) {
      const wage = await queryWage(sql);
      parts.push(`工资：${wage.answer}`);
      cards.push(...(wage.cards ?? []).slice(0, 2));
      citations.push(...(wage.citations ?? []));
    } else {
      parts.push('工资：当前账号无 payroll.read，已跳过。');
    }
    if (/质量|检验|良品|不良|IQC|抽检|全检/.test(t)) {
      const q = await queryQualityBrief(sql);
      parts.push(`质量：${q.line}`);
      cards.push(...q.cards);
    }
    parts.push('可继续追问「应收还有多少未收」「工资待审多少」；写单据请走业务菜单，用法细节去小助手。');
    return {
      answer: parts.join('\n'),
      cards: cards.slice(0, 8),
      intent: 'open',
      provider: 'mock-open',
      citations: citations.slice(0, 6),
    };
  }

  // 仍像产品用法：弱匹配知识库
  const soft = searchKnowledgeTop(question, 1)[0];
  if (soft && soft.tokenHits >= 1) {
    const body = soft.article.body.replace(/^#+\s+/gm, '').trim();
    const short = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).slice(0, 2).join('\n\n');
    return {
      answer: `不确定是否完全对应，先给最接近的用法「${soft.article.title}」：\n\n${short}\n\n查三本账请直接问进度/应收/工资；复杂操作去「赛德瑞克小助手」。`,
      intent: 'open',
      provider: 'mock-open',
      citations: [{ id: soft.article.id, title: soft.article.title }],
    };
  }

  const guided = guideResult();
  return { ...guided, intent: 'open', provider: 'mock-open' };
}

export async function writeFactoryAudit(
  sql: Sql,
  actor: Actor,
  question: string,
  intent: FactoryIntent,
) {
  const summary = question.replace(/\s+/g, ' ').trim().slice(0, 200);
  await sql.query(
    `INSERT INTO ai_action_log(tenant_id, actor_id, actor_name, action, question_summary, intent, meta)
     VALUES ($1,$2,$3,'factory_ask',$4,$5,$6::jsonb)`,
    [
      actor.tenant_id,
      actor.user_id,
      actor.display_name,
      summary,
      intent,
      JSON.stringify({ question_len: question.length }),
    ],
  );
}

export async function runFactoryAsk(
  sql: Sql,
  actor: Actor,
  questionRaw: string,
  config: AiConfig = readAiConfig(),
): Promise<FactoryAskResult> {
  const question = questionRaw.trim();
  if (!question) {
    const guided = guideResult();
    await writeFactoryAudit(sql, actor, '(empty)', guided.intent);
    return guided;
  }
  if (question.length > 500) {
    throw new Problem(422, 'TOO_LONG', '问题不能超过 500 字');
  }

  const intent = detectFactoryIntent(question);
  // 先写审计再读数/鉴权，保证无权限 403 也有日志且不泄漏数字
  await writeFactoryAudit(sql, actor, question, intent);

  let result: FactoryAskResult;
  if (intent === 'refuse_write') {
    result = refuseWriteResult();
  } else if (intent === 'guide') {
    result = guideResult();
  } else if (intent === 'triple') {
    // 三本账：按权限尽力汇总，无权限模块跳过（不抛 403，便于厂长一键看齐）
    result = await queryTripleBooks(sql, actor, question);
  } else if (intent === 'open') {
    if (config.provider === 'openai' && config.apiKey) {
      result = await openWithOpenai(sql, actor, question, config);
    } else {
      result = await openWithMock(sql, actor, question);
    }
  } else if (intent === 'progress') {
    requirePerm(actor, 'production.read', '生产读取');
    result = withAction(await queryProgress(sql, question), 'progress');
  } else if (intent === 'money') {
    requirePerm(actor, 'finance.read', '财务读取');
    result = withAction(await queryMoney(sql), 'money');
  } else if (intent === 'wage') {
    requirePerm(actor, 'payroll.read', '工资读取');
    result = withAction(await queryWage(sql), 'wage');
  } else {
    result = guideResult();
  }

  if (intent === 'progress' || intent === 'money' || intent === 'wage') {
    const polished = await maybePolish(result.answer, {
      intent: result.intent,
      cards: result.cards,
      table: result.table,
    }, config);
    // 单本账也附带同域异常点，便于卡片「去处理」
    let anomalies: FactoryAnomaly[] | undefined;
    try {
      const all = await queryAnomalies(sql, actor);
      anomalies = all.filter((a) =>
        intent === 'progress'
          ? a.kind === 'overdue'
          : intent === 'money'
            ? a.kind === 'receivable_risk'
            : a.kind === 'wage_pending',
      );
    } catch {
      anomalies = undefined;
    }
    result = {
      ...result,
      answer: polished,
      anomalies,
      provider: config.provider === 'openai' && config.apiKey ? 'openai+rules' : 'rules',
    };
  }

  return result;
}
