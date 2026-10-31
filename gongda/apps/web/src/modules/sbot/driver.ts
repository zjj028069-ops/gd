// Bot 代操作的执行器：在用户自己的页面里读界面、移动光标、点击、填写、下拉选择。
// 安全：
//  - 只操作 MES 页面本身，Bot 面板（.sbx）和光标层永远不在可操作范围内；
//  - 删除/作废/清空/退出登录等按钮一律拒绝；
//  - 创建/保存/确定/提交/审核/开始……这类会改数据的按钮，先请用户点「允许」才点下去；
//  - 所有请求都是用户自己的页面发出的，权限与传统操作完全一致。
import { primaryMenus, walkMenus } from '../../kgd/menu';
import type { MenuNode } from '../../kgd/menu';
import type { UiAction } from './useSbot';

export type DriverHooks = {
  navigate: (path: string) => void;
  confirm: (text: string) => Promise<boolean>;
  status: (text: string) => void;
};

type Item = { id: number; kind: string; label: string; value?: string; state?: string; disabled?: boolean; el: HTMLElement };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clean = (t?: string | null) => (t ?? '').replace(/\s+/g, ' ').trim();
const tight = (t?: string | null) => (t ?? '').replace(/\s+/g, '');
const short = (t: string, n = 30) => (t.length > n ? t.slice(0, n) + '…' : t);

const BLOCK_RE = /删除|作废|清空|退出登录|注销|重置密码|反审核|解绑|批量删除/;
// 「报工」「导入」「新增」这类按钮只是打开表单，真正提交时（弹窗里的确定/提交）才需要确认
const WRITE_START_RE = /^(确定|保存|提交|确认|完成|审核|结算|开始|暂停|恢复|撤回|发送|生成|下达|取消|关闭单据|终止)/;
const WRITE_ANY_RE = /创建|保存|提交|审核|结算|下达|过账/;
const PICKER_MODAL_RE = /选择|添加|筛选|列配置|查询|设置列|搜索/;

let items: Item[] = [];
let aborted = false;
export function abortDriver() { aborted = true; }

function ignored(el: Element) { return !!el.closest('.sbx, #sbot-cursor, #sbot-ring, [data-sbot-ignore]'); }

function visible(el: HTMLElement) {
  if (ignored(el)) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const s = getComputedStyle(el);
  if (s.visibility === 'hidden' || s.display === 'none') return false;
  return !el.closest('[aria-hidden="true"], .ant-tabs-tabpane-hidden, .ant-select-dropdown-hidden, .ant-picker-dropdown-hidden');
}

function topLayer(): HTMLElement | null {
  const layers = [...document.querySelectorAll<HTMLElement>('.ant-modal-wrap, .ant-drawer-open .ant-drawer-content-wrapper')]
    .filter((l) => !ignored(l) && getComputedStyle(l).display !== 'none' && l.getBoundingClientRect().width > 0);
  return layers.pop() ?? null;
}

function labelOf(el: HTMLElement): string {
  const aria = el.getAttribute('aria-label');
  if (aria && !/^Select (row|all)/i.test(aria) && !/^(down|close|search)$/.test(aria)) return clean(aria);
  const fi = el.closest('.ant-form-item');
  const fl = fi?.querySelector('.ant-form-item-label');
  if (fl) return clean(fl.textContent).replace(/[*：:]\s*$/, '').replace(/^\*\s*/, '');
  let cur: HTMLElement | null = el;
  for (let i = 0; i < 4 && cur; i++) {
    let p = cur.previousElementSibling as HTMLElement | null;
    while (p && !clean(p.textContent)) p = p.previousElementSibling as HTMLElement | null;
    if (p && !p.querySelector('input,textarea,.ant-select,button') && !['INPUT', 'TEXTAREA', 'BUTTON'].includes(p.tagName)) {
      const t = clean(p.textContent);
      if (t && t.length <= 24) return t.replace(/\s*\*\s*$/, '').replace(/[：:]$/, '');
    }
    cur = cur.parentElement;
    if (!cur || cur.classList.contains('kgd-form') || cur.classList.contains('kgd-content')) break;
  }
  const ph = el.getAttribute('placeholder') || el.querySelector('input')?.getAttribute('placeholder')
    || el.querySelector('.ant-select-placeholder,.ant-select-selection-placeholder')?.textContent;
  return clean(ph);
}

function selectValue(sel: HTMLElement) {
  const tags = [...sel.querySelectorAll('.ant-select-selection-item-content, .ant-select-selection-overflow-item .ant-select-selection-item')].map((t) => clean(t.textContent)).filter(Boolean);
  if (tags.length) return tags.join('、');
  const one = sel.querySelector('.ant-select-selection-item, .ant-select-content-value');
  if (one) return clean(one.getAttribute('title') || one.textContent);
  // antd 6：选中值直接写在 .ant-select-content 上（带 has-value 标记）
  const content = sel.querySelector('.ant-select-content-has-value');
  return content ? clean(content.getAttribute('title') || content.textContent) : '';
}

function rowText(tr: Element) {
  return [...tr.querySelectorAll('td')].filter((td) => !td.classList.contains('ant-table-selection-column')).map((td) => clean(td.textContent)).filter(Boolean).join(' | ');
}

const CONTROL_SEL = 'input, textarea, .ant-select, .ant-picker, .ant-checkbox-wrapper, .ant-radio-wrapper, .ant-switch, button, a[href], [role="tab"], [role="menuitem"], .kgd-link';

/** 下拉菜单、气泡确认框等浮层（挂在 body 上，不在页面主体里） */
function floating(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.ant-dropdown, .ant-popover')]
    .filter((d) => !ignored(d) && !d.className.includes('-hidden') && d.getBoundingClientRect().height > 0);
}

function collect(): { items: Item[]; text: string } {
  const layer = topLayer();
  const floats = floating();
  const roots: HTMLElement[] = [...floats, ...(layer ? [layer] : [document.querySelector<HTMLElement>('.kgd-sidebar'), document.querySelector<HTMLElement>('.kgd-content')].filter(Boolean) as HTMLElement[])];
  if (!roots.length) roots.push(document.body);
  const out: Item[] = [];
  const taken = new Set<HTMLElement>();
  let id = 1;
  for (const root of roots) {
    for (const el of root.querySelectorAll<HTMLElement>(CONTROL_SEL)) {
      if (out.length >= 160) break;
      if (taken.has(el) || ignored(el)) continue;
      if ([...taken].some((t) => t.contains(el))) continue;
      const tag = el.tagName;
      const disabled = el.matches(':disabled') || el.classList.contains('ant-select-disabled') || el.classList.contains('ant-picker-disabled') || el.getAttribute('aria-disabled') === 'true';
      let item: Omit<Item, 'id'> | null = null;
      if (el.matches('.ant-cascader')) {
        if (!visible(el)) continue;
        item = { kind: '级联选择（值写 省/市/区）', label: labelOf(el), value: selectValue(el) || '未选', el, disabled };
      } else if (el.matches('.ant-select')) {
        if (!visible(el)) continue;
        const multi = el.classList.contains('ant-select-multiple');
        item = { kind: multi ? '多选下拉框' : '下拉框', label: labelOf(el), value: selectValue(el) || '未选', el, disabled };
      } else if (el.matches('.ant-picker')) {
        if (!visible(el)) continue;
        const vals = [...el.querySelectorAll('input')].map((i) => (i as HTMLInputElement).value).filter(Boolean);
        const range = el.classList.contains('ant-picker-range');
        item = { kind: range ? '日期范围（值写 起~止）' : '日期', label: labelOf(el), value: vals.join('~') || '未填', el, disabled };
      } else if (el.matches('.ant-checkbox-wrapper, .ant-radio-wrapper')) {
        if (!visible(el)) continue;
        const input = el.querySelector('input') as HTMLInputElement | null;
        const tr = el.closest('tr');
        const label = tr ? (tr.closest('thead') ? '全选' : rowText(tr)) : clean(el.textContent) || labelOf(el);
        item = { kind: el.matches('.ant-radio-wrapper') ? '单选' : '勾选框', label: short(label, 70), state: input?.checked ? '已选' : '未选', el, disabled };
      } else if (el.matches('.ant-switch')) {
        if (!visible(el)) continue;
        item = { kind: '开关', label: labelOf(el), state: el.getAttribute('aria-checked') === 'true' ? '开' : '关', el, disabled };
      } else if (tag === 'INPUT' || tag === 'TEXTAREA') {
        const input = el as HTMLInputElement;
        if (el.closest('.ant-select, .ant-picker, .ant-checkbox-wrapper, .ant-radio-wrapper, .ant-checkbox, .ant-radio')) continue;
        if (['hidden', 'file', 'checkbox', 'radio', 'submit'].includes(input.type) || !visible(el)) continue;
        item = { kind: '输入框', label: labelOf(el), value: input.value ? `"${short(input.value, 40)}"` : '空', el, disabled };
      } else {
        if (el.closest('.ant-select, .ant-picker, .ant-select-dropdown, .ant-picker-dropdown') || !visible(el)) continue;
        const text = clean(el.innerText) || clean(el.getAttribute('aria-label')) || clean(el.getAttribute('title'));
        if (!text) continue;
        const kind = el.closest('.kgd-sidebar') ? '菜单' : el.getAttribute('role') === 'menuitem' ? '菜单项' : el.getAttribute('role') === 'tab' ? '页签' : tag === 'A' || el.classList.contains('kgd-link') ? '链接' : '按钮';
        item = { kind, label: short(text, 30), el, disabled };
      }
      if (!item) continue;
      taken.add(el);
      out.push({ id: id++, ...item });
    }
  }
  items = out;

  const lines: string[] = [];
  const crumb = clean(document.querySelector('.kgd-top .ant-breadcrumb')?.textContent);
  lines.push(`页面：${crumb || document.title}（${location.pathname.replace(/^\/mes(?=\/)/, '')}）`);
  if (floats.length) lines.push(`浮层菜单已展开：${short(floats.map((f) => clean(f.innerText)).join(' / '), 120)}（下面最前面的元素就是它的选项）`);
  if (layer) lines.push(`弹窗：「${clean(layer.querySelector('.ant-modal-title, .ant-drawer-title, .ant-modal-confirm-title')?.textContent) || '未命名'}」——只列出弹窗里的内容，关掉弹窗后才能操作页面其他地方`);
  const notes = [...document.querySelectorAll<HTMLElement>('.ant-message-notice-content, .ant-message-notice-title, .ant-notification-notice-message, .ant-notification-notice-title, .ant-notification-notice-description, .ant-alert-message, .ant-alert-description, .ant-form-item-explain-error, .kgd-error, .kgd-banner, [role="alert"]')]
    .filter((n) => !ignored(n) && n.getBoundingClientRect().width > 0).map((n) => clean(n.textContent)).filter(Boolean);
  if (notes.length) lines.push(`页面提示：${[...new Set(notes)].slice(0, 6).join('；')}`);
  lines.push('可操作元素：');
  for (const it of out) {
    if (it.kind === '菜单' && layer) continue;
    let line = `[${it.id}] ${it.kind}「${it.label || '无标签'}」`;
    if (it.value !== undefined) line += ` = ${it.value}`;
    if (it.state) line += `（${it.state}）`;
    if (it.disabled) line += '（不可用）';
    lines.push(line);
  }
  const tables = (layer ? [layer] : roots.filter((r) => !r.classList.contains('kgd-sidebar'))).flatMap((r) => [...r.querySelectorAll<HTMLElement>('.ant-table')]).filter(visible);
  tables.slice(0, 3).forEach((t, i) => {
    const head = [...t.querySelectorAll('thead th')].map((th) => clean(th.textContent)).filter(Boolean).join(' | ');
    const rows = [...t.querySelectorAll('tbody tr.ant-table-row')];
    lines.push(`表格${i + 1}（${rows.length} 行）列：${short(head, 300)}`);
    rows.slice(0, 10).forEach((tr, j) => lines.push(`  ${j + 1}. ${short(rowText(tr), 200)}`));
    if (!rows.length) lines.push('  （暂无数据）');
  });
  let text = lines.join('\n');
  if (text.length > 9000) text = text.slice(0, 9000) + '\n…（内容太多已截断）';
  return { items: out, text };
}

// ── 光标与高亮 ────────────────────────────────────────────────────────────

function layerEl(id: string, html: string) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.innerHTML = html;
    document.body.appendChild(el);
  }
  return el;
}

const CURSOR_SVG = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 3l15 7.5-6.6 1.9L10 19z" fill="#4184F4" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><span class="sbot-cursor-tag"></span>';

export function showCursor(on: boolean) {
  const c = layerEl('sbot-cursor', CURSOR_SVG);
  c.classList.toggle('is-on', on);
  if (!on) document.getElementById('sbot-ring')?.classList.remove('is-on');
}

async function point(el: HTMLElement, tag: string) {
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  await sleep(220);
  const r = el.getBoundingClientRect();
  const c = layerEl('sbot-cursor', CURSOR_SVG);
  c.classList.add('is-on');
  c.style.transform = `translate(${Math.round(r.left + Math.min(r.width / 2, 48))}px, ${Math.round(r.top + r.height / 2)}px)`;
  const t = c.querySelector('.sbot-cursor-tag');
  if (t) t.textContent = tag;
  const ring = layerEl('sbot-ring', '');
  ring.style.left = `${r.left - 4}px`; ring.style.top = `${r.top - 4}px`;
  ring.style.width = `${r.width + 8}px`; ring.style.height = `${r.height + 8}px`;
  ring.classList.add('is-on');
  await sleep(520);
}

async function press() {
  const c = document.getElementById('sbot-cursor');
  c?.classList.add('press');
  await sleep(140);
  c?.classList.remove('press');
}

function mouse(el: Element, type: string) {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
}

function realClick(el: HTMLElement) {
  mouse(el, 'mousedown'); mouse(el, 'mouseup'); el.click();
}

function setNative(el: HTMLInputElement | HTMLTextAreaElement, v: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function typeInto(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  el.focus();
  setNative(el, '');
  const delay = text.length > 24 ? 12 : 45;
  for (let i = 1; i <= text.length; i++) { setNative(el, text.slice(0, i)); await sleep(delay); }
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function key(el: Element, k: string) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, keyCode: k === 'Enter' ? 13 : 27, bubbles: true }));
}

async function settle() {
  await sleep(450);
  for (let i = 0; i < 15; i++) {
    if (!document.querySelector('.kgd-content .ant-spin-spinning, .ant-modal-wrap .ant-spin-spinning, .ant-btn-loading')) break;
    await sleep(200);
  }
}

// ── 动作 ────────────────────────────────────────────────────────────────

function find(target: string): Item {
  const t = target.trim();
  if (/^\d+$/.test(t)) {
    const it = items.find((x) => x.id === Number(t));
    if (it && it.el.isConnected) return it;
    throw new Error(`编号 ${t} 已失效（页面变了），请先 ui_look 看最新清单`);
  }
  const want = tight(t).replace(/[「」"]/g, '');
  const pick = (list: Item[]) => list.find((x) => tight(x.label) === want) ?? list.find((x) => tight(x.label).includes(want)) ?? list.find((x) => want.includes(tight(x.label)) && tight(x.label).length >= 2);
  const it = pick(items.filter((x) => x.el.isConnected && x.kind !== '菜单')) ?? pick(items.filter((x) => x.el.isConnected));
  if (it) return it;
  collect();
  const again = pick(items.filter((x) => x.kind !== '菜单')) ?? pick(items);
  if (again) return again;
  throw new Error(`页面上找不到「${t}」`);
}

function needsConfirm(el: HTMLElement, text: string) {
  if (el.closest('.kgd-sidebar') || el.getAttribute('role') === 'tab') return false;
  // 浮层菜单项：「直接创建」之类只是打开表单；「开始/完成/取消」之类会直接改数据
  if (el.getAttribute('role') === 'menuitem') return WRITE_START_RE.test(text);
  const layer = el.closest('.ant-modal-wrap, .ant-drawer, .ant-popover');
  const title = clean(layer?.querySelector('.ant-modal-title, .ant-drawer-title')?.textContent);
  if (layer && /^(取消|关闭|返回|否)$/.test(text)) return false;
  if (layer && /^确定$/.test(text) && PICKER_MODAL_RE.test(title)) return false;
  // 弹窗里的主按钮（蓝色）或带「报工/入库/出库」的按钮，通常就是提交
  if (layer && !PICKER_MODAL_RE.test(title) && (el.classList.contains('ant-btn-primary') || /报工|入库|出库/.test(text))) return true;
  return WRITE_START_RE.test(text) || WRITE_ANY_RE.test(text);
}

async function doClick(it: Item, hooks: DriverHooks) {
  const text = tight(it.el.innerText || it.el.getAttribute('aria-label') || it.label);
  if (BLOCK_RE.test(text)) throw new Error(`代操作不允许点「${it.label}」（删除/作废类操作请用户自己点）`);
  if (it.disabled) throw new Error(`「${it.label}」现在不可用（可能有必填项没填）`);
  const href = it.el.closest('a')?.getAttribute('href');
  if (href && !href.startsWith('#')) {
    const url = new URL(href, location.href);
    if (url.origin !== location.origin) throw new Error(`「${it.label}」是外部链接，代操作只在本系统内操作`);
  }
  if (it.el.closest('.kgd-top') && !it.el.closest('.ant-breadcrumb')) throw new Error('顶栏（账号、外观、模式切换）不在代操作范围内');
  await point(it.el, `点击「${short(it.label, 12)}」`);
  if (needsConfirm(it.el, text)) {
    hooks.status(`等你允许：点击「${it.label}」`);
    const ok = await hooks.confirm(it.label);
    if (!ok) throw new Error(`用户没有允许点击「${it.label}」`);
  }
  await press();
  for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter']) mouse(it.el, t);
  realClick(it.el);
  // 悬停展开的下拉菜单：给它一点时间出现
  await sleep(350);
}

async function doFill(it: Item, value: string) {
  if (it.el.classList.contains('ant-picker-range')) {
    const [a, b] = value.split(/\s*[~～至到]\s*|\s+-\s+/);
    const inputs = [...it.el.querySelectorAll('input')] as HTMLInputElement[];
    if (!a || !b || inputs.length < 2) throw new Error(`「${it.label}」是日期范围，值写成 2026-01-01~2026-01-31`);
    await point(it.el, `填写「${short(it.label, 12)}」`);
    for (const [input, v] of [[inputs[0], a], [inputs[1], b]] as const) {
      realClick(input);
      await sleep(150);
      await typeInto(input, v);
      key(input, 'Enter');
      await sleep(200);
    }
    key(inputs[1], 'Escape');
    return;
  }
  if (it.el.classList.contains('ant-picker')) {
    const input = it.el.querySelector('input') as HTMLInputElement;
    await point(it.el, `填写「${short(it.label, 12)}」`);
    realClick(input);
    await sleep(200);
    await typeInto(input, value);
    key(input, 'Enter');
    await sleep(250);
    if (input.value !== value) key(input, 'Escape');
    if (tight(input.value) !== tight(value)) throw new Error(`「${it.label}」没填进去，日期请写成 YYYY-MM-DD`);
    return;
  }
  const input = (['INPUT', 'TEXTAREA'].includes(it.el.tagName) ? it.el : it.el.querySelector('input, textarea')) as HTMLInputElement | null;
  if (!input) throw new Error(`「${it.label}」不是输入框，下拉框请用 select`);
  if (it.disabled) throw new Error(`「${it.label}」现在不可编辑`);
  await point(input, `填写「${short(it.label, 12)}」`);
  await typeInto(input, value);
  input.blur();
}

function openDropdown(selector: string) {
  return [...document.querySelectorAll<HTMLElement>(selector)].filter((d) => !d.className.includes('-hidden') && d.getBoundingClientRect().height > 0).pop() ?? null;
}

/** 级联选择（省/市/区 这类）：逐级点开 */
async function doCascade(it: Item, value: string) {
  const parts = value.split(/[/／>＞→\s,，、]+/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error(`「${it.label}」要写成 省/市/区 这样的路径`);
  await point(it.el, `选择「${short(it.label, 12)}」`);
  await press();
  mouse(it.el.querySelector('.ant-select-content, .ant-select-selector') ?? it.el, 'mousedown');
  it.el.click();
  for (let level = 0; level < parts.length; level++) {
    let items: HTMLElement[] = [];
    for (let i = 0; i < 10 && !items.length; i++) {
      await sleep(200);
      const dd = openDropdown('.ant-cascader-dropdown, .ant-select-dropdown');
      const menus = dd ? [...dd.querySelectorAll<HTMLElement>('.ant-cascader-menu')] : [];
      items = menus[level] ? [...menus[level].querySelectorAll<HTMLElement>('.ant-cascader-menu-item')] : [];
    }
    const want = tight(parts[level]);
    const textOf = (o: HTMLElement) => tight(o.getAttribute('title') || o.textContent);
    const hit = items.find((o) => textOf(o) === want) ?? items.find((o) => textOf(o).startsWith(want) || want.startsWith(textOf(o).replace(/[省市区县]$/, '')));
    if (!hit) {
      key(document.activeElement ?? it.el, 'Escape');
      throw new Error(`「${it.label}」第 ${level + 1} 级没有「${parts[level]}」。可选：${items.slice(0, 20).map((o) => clean(o.textContent)).join('、') || '（没有选项）'}`);
    }
    await point(hit, `选「${clean(hit.textContent)}」`);
    mouse(hit, 'mousedown'); hit.click();
    await sleep(300);
  }
  // 没有更深一级时下拉会自动关闭；如果还开着说明路径不完整
  const dd = openDropdown('.ant-cascader-dropdown, .ant-select-dropdown');
  const menus = dd ? dd.querySelectorAll('.ant-cascader-menu').length : 0;
  if (menus > parts.length) {
    const next = [...dd!.querySelectorAll<HTMLElement>('.ant-cascader-menu')][parts.length];
    const opts = [...next.querySelectorAll('.ant-cascader-menu-item')].slice(0, 15).map((o) => clean(o.textContent)).join('、');
    throw new Error(`「${it.label}」还要选下一级：${opts}`);
  }
  return selectValue(it.el) || parts.join('/');
}

async function doSelect(it: Item, value: string) {
  if (it.el.classList.contains('ant-cascader')) return doCascade(it, value);
  if (!it.el.classList.contains('ant-select')) throw new Error(`「${it.label}」不是下拉框`);
  if (it.disabled) throw new Error(`「${it.label}」现在不可选`);
  await point(it.el, `选择「${short(it.label, 12)}」`);
  await press();
  mouse(it.el.querySelector('.ant-select-selector, .ant-select-content') ?? it.el, 'mousedown');
  await sleep(250);
  const input = it.el.querySelector('input') as HTMLInputElement | null;
  const searchable = it.el.classList.contains('ant-select-show-search');
  if (searchable && input && value) await typeInto(input, value);
  const want = tight(value);
  let options: HTMLElement[] = [];
  for (let i = 0; i < 12; i++) {
    await sleep(200);
    const dd = [...document.querySelectorAll<HTMLElement>('.ant-select-dropdown')].filter((d) => !d.classList.contains('ant-select-dropdown-hidden') && d.getBoundingClientRect().height > 0).pop();
    // 普通下拉的选项，或树形下拉（TreeSelect）的节点
    options = dd ? [...dd.querySelectorAll<HTMLElement>('.ant-select-item-option, .ant-select-tree-node-content-wrapper')] : [];
    if (options.length && (!searchable || options.some((o) => tight(o.getAttribute('title') || o.textContent).includes(want)))) break;
  }
  const textOf = (o: HTMLElement) => tight(o.getAttribute('title') || o.textContent);
  let hit = options.find((o) => textOf(o) === want) ?? options.find((o) => textOf(o).includes(want)) ?? options.find((o) => want.includes(textOf(o)) && textOf(o).length >= 2);
  if (!hit && searchable && input) {
    setNative(input, '');
    await sleep(500);
    const dd = [...document.querySelectorAll<HTMLElement>('.ant-select-dropdown')].filter((d) => !d.classList.contains('ant-select-dropdown-hidden')).pop();
    options = dd ? [...dd.querySelectorAll<HTMLElement>('.ant-select-item-option, .ant-select-tree-node-content-wrapper')] : [];
    hit = options.find((o) => textOf(o).includes(want));
  }
  if (!hit) {
    const avail = options.slice(0, 15).map((o) => clean(o.getAttribute('title') || o.textContent)).join('、');
    if (input) key(input, 'Escape');
    throw new Error(`「${it.label}」里没有「${value}」。${avail ? `可选：${avail}` : '下拉里没有任何选项（可能要先建资料）'}`);
  }
  await point(hit, `选「${short(clean(hit.textContent), 12)}」`);
  await press();
  mouse(hit, 'mousedown'); hit.click();
  await sleep(250);
  if (it.el.classList.contains('ant-select-multiple') && input) key(input, 'Escape');
  const now = selectValue(it.el);
  if (!now) throw new Error(`「${it.label}」点了选项但没有选上`);
  return now;
}

async function doCheck(it: Item, want: boolean) {
  if (it.el.matches('.ant-switch')) {
    if ((it.el.getAttribute('aria-checked') === 'true') === want) return;
    await point(it.el, want ? '打开' : '关闭');
    await press();
    it.el.click();
    return;
  }
  const input = it.el.querySelector('input') as HTMLInputElement | null;
  if (!input) throw new Error(`「${it.label}」不是勾选框/单选/开关`);
  if (input.checked === want) return;
  if (!want && input.type === 'radio') throw new Error('单选不能取消，请直接选另一个选项');
  await point(it.el, want ? '勾选' : '取消勾选');
  await press();
  input.click();
}

function findMenu(name: string): { node: MenuNode | { label: string; path?: string }; primaryKey: string } | null {
  const parts = name.split(/[/>＞→\\]/).map(tight).filter(Boolean);
  const leaf = parts[parts.length - 1];
  let best: { node: MenuNode | { label: string; path?: string }; primaryKey: string; score: number } | null = null;
  for (const p of primaryMenus) {
    if (p.path && tight(p.label) === leaf) best ??= { node: p, primaryKey: p.key, score: 1 };
    walkMenus(p.children ?? [], (node, parents) => {
      if (!node.path) return;
      const chain = [p.label, ...parents.map((x) => x.label), node.label].map(tight);
      if (chain[chain.length - 1] !== leaf && !(chain[chain.length - 1].includes(leaf) && leaf.length >= 2)) return;
      const score = (chain[chain.length - 1] === leaf ? 10 : 5) + parts.filter((x) => chain.includes(x)).length;
      if (!best || score > best.score) best = { node, primaryKey: p.key, score };
    });
  }
  return best;
}

async function doOpen(menu: string, hooks: DriverHooks) {
  const found = findMenu(menu);
  if (!found?.node.path) throw new Error(`菜单里没有「${menu}」。请用说明书里的菜单名，或先 ui_look 看左侧菜单`);
  const label = found.node.label;
  const sidebar = document.querySelector<HTMLElement>('.kgd-sidebar');
  const leafBtn = () => [...document.querySelectorAll<HTMLElement>('.kgd-sidebar [data-label]')].find((b) => b.getAttribute('data-label') === label && visible(b));
  if (sidebar && !sidebar.classList.contains('is-collapsed')) {
    if (!leafBtn()) {
      const prim = document.querySelector<HTMLElement>(`.kgd-sidebar [data-primary="${found.primaryKey}"]`);
      if (prim && visible(prim) && prim.getAttribute('aria-expanded') !== 'true') {
        await point(prim, `打开「${clean(prim.getAttribute('aria-label') || prim.textContent)}」`);
        await press();
        realClick(prim);
        await sleep(450);
      }
    }
    const btn = leafBtn();
    if (btn && !btn.matches(':disabled')) {
      await point(btn, `打开「${label}」`);
      await press();
      realClick(btn);
      await settle();
      if (location.pathname.endsWith(found.node.path)) return;
    }
  }
  hooks.navigate(found.node.path);
  await settle();
}

const VERB: Record<string, string> = { click: '点', fill: '填写', select: '选择', check: '勾选', uncheck: '取消勾选' };

// 开发环境下方便调试：在控制台用 __sbotDriver.look() / __sbotDriver.run({...}) 直接驱动
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__sbotDriver = {
  look: () => collect().text,
  run: (action: UiAction) => runUiAction(action, { navigate: (p) => history.pushState(null, '', p), confirm: async () => true, status: () => undefined }),
};

export async function runUiAction(action: UiAction, hooks: DriverHooks): Promise<string> {
  aborted = false;
  const log: string[] = [];
  try {
    if (action.type === 'open') {
      hooks.status(`正在打开「${action.menu}」`);
      await doOpen(action.menu, hooks);
      await sleep(500);
      log.push(`已打开「${action.menu}」`);
    } else if (action.type === 'do') {
      if (!items.length) collect();
      for (const [i, s] of action.steps.entries()) {
        if (aborted) { log.push('已停止'); break; }
        const n = `第${i + 1}步 ${VERB[s.do] ?? s.do}「${s.target}」${s.value ? `=${s.value}` : ''}`;
        hooks.status(`${VERB[s.do] ?? s.do}「${s.target}」${s.value ? ' → ' + s.value : ''}`);
        try {
          const it = find(s.target);
          let note = '';
          if (s.do === 'click') await doClick(it, hooks);
          else if (s.do === 'fill') await doFill(it, s.value ?? '');
          else if (s.do === 'select') note = `（已选中：${await doSelect(it, s.value ?? '')}）`;
          else await doCheck(it, s.do === 'check');
          await settle();
          log.push(n + ' ✓' + note);
        } catch (e) {
          log.push(`${n} ✗ ${(e as Error).message}`);
          log.push(i < action.steps.length - 1 ? '后面的步骤没有执行。' : '');
          break;
        }
      }
    }
  } catch (e) {
    log.push(`✗ ${(e as Error).message}`);
  } finally {
    hooks.status('');
  }
  await sleep(250);
  const snap = collect().text;
  return (log.filter(Boolean).length ? log.filter(Boolean).join('\n') + '\n\n' : '') + snap;
}
