import { useState, type ReactNode } from 'react';

const rankColors = ['#f6e27a', '#fff3c4', '#5ee0d0'];
const defectColors = ['#3dce7c', '#f5c518', '#2ec8e6'];
const restColor = '#3aa0ff';
export const pieColors = ['#6a78e8', '#8b93f2', '#d4e36a', '#5dcc6a', '#f0d35a', '#f08a3a', '#e25b5b', '#9b6bff', '#4ec8e0', '#7fd0a4'];

export function ScreenIcon() {
  return (
    <svg className="s-icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M1 11.5h12" fill="none" stroke="#3dce7c" strokeWidth="1.2" />
      <path d="M2 9.2 5 6.4l2.1 1.8L11.2 3" fill="none" stroke="#3dce7c" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8.6 3H11.2V5.6" fill="none" stroke="#3dce7c" strokeWidth="1.5" />
    </svg>
  );
}

export function ScreenPanel({ title, range, module, children, chart, className }: { title: string; range?: boolean; module: string; children: ReactNode; chart?: boolean; className?: string }) {
  return (
    <section className={`kgd-screen-panel ${className ?? ''}`} data-module={module}>
      <i className="kgd-corner tl" aria-hidden="true" />
      <i className="kgd-corner tr" aria-hidden="true" />
      <i className="kgd-corner bl" aria-hidden="true" />
      <i className="kgd-corner br" aria-hidden="true" />
      <div className="kgd-screen-module-title"><ScreenIcon /><span>{title}</span>{range ? <span className="sub">最近30天</span> : null}</div>
      <div className={`kgd-screen-panel-body ${chart ? 'is-chart' : ''}`}>{children}</div>
    </section>
  );
}

export function Wings() {
  return (
    <span className="kgd-screen-wing" aria-hidden="true">
      <i /><i /><i /><i />
    </span>
  );
}

const tones = ['gold', 'cyan', 'green', 'plain', 'red', 'red', 'cyan', 'orange', 'orange'] as const;

export function kpiTone(index: number) {
  return tones[index] ?? 'plain';
}

export function KpiBoard({ cards }: { cards: { label: string; value: string; extra?: string; tone?: string }[] }) {
  return (
    <div className="kgd-screen-kpi" data-panel="kpi">
      <i className="kgd-corner tl" aria-hidden="true" />
      <i className="kgd-corner tr" aria-hidden="true" />
      <i className="kgd-corner bl" aria-hidden="true" />
      <i className="kgd-corner br" aria-hidden="true" />
      {cards.map((card, index) => (
        <div key={card.label} className={`kgd-screen-metric is-${card.tone ?? kpiTone(index)}`}>
          <span className="kgd-metric-wing" aria-hidden="true"><i /><i /><i /></span>
          <div className="label">{card.label}</div>
          <div className="value-row">
            <div className="value">{card.value}</div>
            {card.extra ? <div className="delta">{card.extra}</div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

export function hBarOption(items: { name: string; value: number }[], mode: 'rank' | 'defect') {
  const sorted = [...items].sort((a, b) => mode === 'rank' ? b.value - a.value : a.value - b.value);
  const colors = mode === 'rank' ? rankColors : defectColors;
  return {
    backgroundColor: 'transparent',
    grid: { left: 8, right: 56, top: 8, bottom: 4, containLabel: true },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: { type: 'value', splitLine: { show: false }, axisLabel: { show: false } },
    yAxis: {
      type: 'category',
      inverse: true,
      data: sorted.map((item) => item.name),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: '#d6e8ff', fontSize: 12 },
    },
    series: [{
      type: 'bar',
      barWidth: 8,
      data: sorted.map((item, index) => ({
        value: item.value,
        itemStyle: { color: index < 3 ? colors[index] : restColor, borderRadius: 8 },
      })),
      label: {
        show: true,
        position: 'right',
        color: '#d6e8ff',
        fontSize: 12,
        formatter: (params: { value?: number }) => mode === 'defect' ? `${params.value ?? 0}%` : String(params.value ?? 0),
      },
    }],
  };
}

export function pieOption(rows: { name?: string; value?: number; qty?: string }[], legend = true) {
  return {
    backgroundColor: 'transparent',
    color: pieColors,
    tooltip: { trigger: 'item' },
    legend: legend ? { orient: 'vertical', right: 0, top: 'middle', textStyle: { color: '#cfe3ff', fontSize: 11 } } : undefined,
    series: [{
      type: 'pie',
      radius: ['46%', '68%'],
      center: legend ? ['38%', '50%'] : ['50%', '50%'],
      label: { color: '#d6e8ff', fontSize: 11, formatter: '{b}\n{d}%' },
      labelLine: { length: 8, length2: 8 },
      data: rows.map((row) => ({ name: row.name ?? '', value: Number(row.value ?? row.qty ?? 0) })),
    }],
  };
}

const avatarColors = ['#3d7dff', '#3dce7c', '#f5c518', '#ff7a45', '#a06bff', '#2ec8e6', '#ff5d8f', '#7fd0a4'];

export type PeopleCard = { name: string; today: string; week: string; month: string };

export function PeopleCards({ rows }: { rows: PeopleCard[] }) {
  const pageSize = 6;
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, pages - 1);
  const slice = rows.slice(safePage * pageSize, safePage * pageSize + pageSize);
  return (
    <div className="kgd-people">
      <div className="kgd-people-grid">
        {slice.map((row, index) => {
          const week = Number(String(row.week).replace(/[^\d.-]/g, '')) || 0;
          const month = Number(String(row.month).replace(/[^\d.-]/g, '')) || 0;
          return (
            <article key={`${row.name}-${index}`} className="kgd-people-card">
              <span className="kgd-avatar" data-avatar="initial" style={{ background: avatarColors[(safePage * pageSize + index) % avatarColors.length] }}>{Array.from(row.name)[0] || '人'}</span>
              <div>
                <div className="kgd-people-name">{row.name}</div>
                <div>今日报工数：<b>{row.today || '0'}</b></div>
                <div>本周不良品数：<b className={week > 0 ? 'is-bad' : ''}>{row.week || '0'}</b></div>
                <div>本月不良品数：<b className={month > 0 ? 'is-bad' : ''}>{row.month || '0'}</b></div>
              </div>
            </article>
          );
        })}
        {!slice.length ? <div className="kgd-screen-empty">暂无数据</div> : null}
      </div>
      {pages > 1 ? (
        <div className="kgd-people-dots">
          {Array.from({ length: pages }, (_, index) => (
            <button key={index} type="button" aria-label={`第${index + 1}页`} className={index === safePage ? 'on' : ''} onClick={() => setPage(index)} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function statusTone(status: string) {
  if (status === '维修中') return 'warn';
  if (status === '运行中') return 'run';
  if (status === '正常') return 'ok';
  return 'muted';
}

export function StatusLabel({ status }: { status: string }) {
  return <span className={`kgd-status-dot is-${statusTone(status)}`}>{status || '-'}</span>;
}

export function PriorityPill({ text }: { text: string }) {
  const tone = text === '加急' ? 'urgent' : text === '延期' ? 'delayed' : 'none';
  return <span className={`kgd-pri is-${tone}`}>{text || '无'}</span>;
}
