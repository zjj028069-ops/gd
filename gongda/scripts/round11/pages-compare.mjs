/**
 * T29 页面清单比对：按 pages.json how_to_check 逐页读 DOM。
 * 等待失败即失败，不加 catch 吞错。已知差异只跳过 pages-known-gaps.json 里登记的按钮。
 * 页签写在 URL 括号里（如「商品库存页签」）时先打开路径再点页签；缺查询区记差异，不挂死 innerText。
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fillUrl, loadIds, loadJson, norm, openPage, OUT, shot, waitReady, WEB, writeReport } from './_lib.mjs';

const pack = loadJson('pages.json');
const gaps = JSON.parse(readFileSync('scripts/round11/pages-known-gaps.json', 'utf8'));
const ids = loadIds();
const pages = pack.pages;
void pack.how_to_check;

function splitPageUrl(raw) {
  const text = String(raw || '');
  const matched = text.match(/^(.*?)[（(](.+?)页签[)）]$/);
  if (matched) return { path: matched[1], tab: matched[2] };
  return { path: text, tab: null };
}

function visibleText(page) {
  return page.evaluate(() => document.body.innerText);
}

async function clickNamedTab(page, name) {
  const packed = norm(name);
  const clicked = await page.evaluate((want) => {
    const nodes = [...document.querySelectorAll('.wh-stock-tabs button, .kgd-anchors button, .kgd-views .kgd-view, [role="tab"], .ant-tabs-tab, .ant-tabs-nav .ant-tabs-tab-btn, .kgd-view')];
    const hit = nodes.find((node) => String(node.innerText || '').replace(/\s+/g, '') === want);
    if (!hit) return false;
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  }, packed);
  if (clicked) return true;
  const roleTab = page.getByRole('tab', { name, exact: true }).first();
  if (await roleTab.count()) {
    await roleTab.waitFor({ state: 'visible', timeout: 5000 });
    await roleTab.scrollIntoViewIfNeeded();
    await roleTab.click();
    return true;
  }
  const textTab = page.getByText(name, { exact: true }).first();
  if (await textTab.count()) {
    await textTab.waitFor({ state: 'visible', timeout: 5000 });
    await textTab.scrollIntoViewIfNeeded();
    await textTab.click();
    return true;
  }
  return false;
}

function titleMatches(got, expected) {
  const a = norm(got);
  const b = norm(expected);
  if (a === b) return true;
  if (!b) return true;
  const marked = b
    .replace(/【[^】]*】/g, '【<<<PH>>>】')
    .replace(/\{[^}]+\}|\[[^\]]*\]/g, '<<<PH>>>')
    .replace(/客户名|合同编号/g, '<<<PH>>>');
  const escaped = marked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/<<<PH>>>/g, '.*');
  return new RegExp(`^${escaped}$`).test(a);
}

async function dismissOverlays(page) {
  // 理由：从 DOM 删 .ant-modal-wrap 会弄断 React portal，下一弹窗白屏。只按 Escape。
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    document.querySelectorAll('.ant-modal-close').forEach((node) => {
      const wrap = node.closest('.ant-modal-wrap');
      if (wrap && getComputedStyle(wrap).display !== 'none') {
        node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
    });
  });
  await page.waitForTimeout(150);
}

async function clickPacked(page, trigger, prefer = 'row') {
  // 理由：antd zh_CN 二字按钮插空格；getByRole 子串会点到「未结算」「生成历史」。按去空白后的完整文案点，不是改断言。
  return page.evaluate((args) => {
    const want = String(args.trigger).replace(/\s+/g, '');
    function shown(node) {
      let el = node;
      while (el && el !== document.body) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) return false;
        if (el.classList?.contains('ant-tabs-tabpane-hidden')) return false;
        el = el.parentElement;
      }
      return true;
    }
    const nodes = [...document.querySelectorAll('button, .ant-btn, [role="button"], a.ant-btn, .kgd-link')].filter((node) => {
      if (!shown(node)) return false;
      const packed = String(node.innerText || node.getAttribute('aria-label') || '').replace(/\s+/g, '');
      return packed === want || packed === `+${want}`;
    });
    const row = nodes.filter((node) => node.closest('.ant-table-tbody'));
    const toolbar = nodes.filter((node) => node.closest('.kgd-toolbar, .kgd-actions, .kgd-query'));
    const hit = (args.prefer === 'toolbar' ? (toolbar[0] || row[0] || nodes[0]) : (row[0] || toolbar[0] || nodes[0]));
    if (!hit) return false;
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  }, { trigger, prefer });
}

async function clickTrigger(page, trigger) {
  const prefer = /高级查询|生成|新增/.test(trigger) ? 'toolbar' : 'row';
  const ok = await clickPacked(page, trigger, prefer);
  if (!ok) return false;
  await page.waitForTimeout(200);
  const direct = page.getByRole('menuitem', { name: '直接创建' });
  if (await direct.count()) {
    const item = direct.first();
    await item.waitFor({ state: 'visible', timeout: 5000 });
    await item.scrollIntoViewIfNeeded();
    await item.click();
  }
  return true;
}

function skipButtons(id) {
  return new Set((gaps[id]?.skip_buttons ?? []).map(norm));
}

async function visibleHeaders(page) {
  return page.evaluate(() => {
    function shown(el) {
      if (!el) return false;
      let node = el;
      while (node && node !== document.body) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) return false;
        if (node.classList?.contains('ant-tabs-tabpane-hidden')) return false;
        if (node.classList?.contains('ant-modal-wrap') && style.display === 'none') return false;
        node = node.parentElement;
      }
      return true;
    }
    const active = document.querySelector('.ant-tabs-tabpane-active .ant-table, .ant-tabs-content-holder .ant-tabs-tabpane:not(.ant-tabs-tabpane-hidden) .ant-table');
    const tables = [...document.querySelectorAll('.ant-table')].filter((node) => shown(node) && !node.closest('.ant-modal-wrap'));
    const table = (active && shown(active) && !active.closest('.ant-modal-wrap') ? active : tables[0]);
    if (!table) return [];
    return [...table.querySelectorAll('.ant-table-thead th')].map((el) => (el.innerText || '').replace(/\s+/g, '')).filter((text) => text && text !== 'selection-column' && !/^□$/.test(text));
  });
}

const { browser, page } = await openPage();
const diffs = [];
const warnings = [];
mkdirSync(path.join(OUT, 'pages'), { recursive: true });

try {
for (const item of pages) {
  const id = item.id;
  try {
  const skip = skipButtons(id);
  const parsed = splitPageUrl(item.url || '/staging/area');
  const url = fillUrl(parsed.path, ids);
  console.log(id, url, parsed.tab || '');
  await page.goto(`${WEB}${url}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitReady(page);
  await dismissOverlays(page);
  await page.waitForTimeout(200);
  if (parsed.tab) {
    if (await clickNamedTab(page, parsed.tab)) {
      await page.waitForTimeout(250);
      await waitReady(page);
    } else diffs.push(`${id} 缺页签 ${parsed.tab}`);
  }
  const body = await visibleText(page);
  if (/待建设|待确认|后端缺/.test(body) && !(gaps[id]?.allow_placeholder)) diffs.push(`${id} 出现禁止文案`);
  if (item.breadcrumb) {
    const crumbLoc = page.locator('.ant-breadcrumb').first();
    if (!(await crumbLoc.count())) diffs.push(`${id} 缺面包屑 期望 ${item.breadcrumb.join(' / ')}`);
    else {
      const crumb = await crumbLoc.innerText();
      const got = crumb.split(/\s*\/\s*/).map((s) => s.trim()).filter(Boolean);
      const exp = item.breadcrumb;
      if (got.map(norm).join('/') !== exp.map(norm).join('/')) {
        warnings.push(`${id} 面包屑 期望 ${exp.join(' / ')} 实际 ${got.join(' / ')}`);
        if (norm(got.join('')) !== norm(exp.join(''))) diffs.push(`${id} 面包屑 期望 ${exp.join(' / ')} 实际 ${got.join(' / ')}`);
      }
    }
  } else {
    warnings.push(`${id} 面包屑 原版未采到`);
  }
  if (item.columns && item.columns_mode) {
    const expand = page.getByRole('button', { name: '展开查询' });
    if (await expand.count()) await expand.first().click();
    const cleaned = await visibleHeaders(page);
    const exp = item.columns.map(norm);
    const got = cleaned.map(norm);
    if (item.columns_mode === 'exact') {
      if (got.join('|') !== exp.join('|')) diffs.push(`${id} 列 期望 ${item.columns.join(',')} 实际 ${cleaned.join(',')}`);
    } else if (item.columns_mode === 'prefix') {
      if (got.slice(0, exp.length).join('|') !== exp.join('|')) diffs.push(`${id} 列前缀 期望 ${item.columns.join(',')} 实际 ${cleaned.join(',')}`);
    }
  }
  if (Array.isArray(item.buttons)) {
    const packed = norm(await visibleText(page));
    for (const btn of item.buttons) {
      if (skip.has(norm(btn))) continue;
      if (!packed.includes(norm(btn))) diffs.push(`${id} 缺按钮 ${btn}`);
    }
  }
  if (Array.isArray(item.filters)) {
    const expand = page.getByRole('button', { name: '展开查询' });
    if (await expand.count()) await expand.first().click();
    const queryLoc = page.locator('.kgd-query');
    if (!(await queryLoc.count())) diffs.push(`${id} 缺查询区`);
    else {
      const area = norm(await queryLoc.first().innerText());
      const placeholders = await page.locator('.kgd-query input, .kgd-query textarea, .kgd-query .ant-picker-input input').evaluateAll((els) => els.map((el) => (el.getAttribute('placeholder') || '').replace(/\s+/g, '')));
      const packedPlace = placeholders.join('');
      for (const f of item.filters) {
        const label = typeof f === 'string' ? f : (f.label || f.name || '');
        if (!label) continue;
        const key = norm(label);
        if (!area.includes(key) && !packedPlace.includes(key)) diffs.push(`${id} 缺查询 ${label}`);
      }
    }
  }
  if (Array.isArray(item.summary)) {
    const sum = await page.locator('.kgd-summary').count() ? await page.locator('.kgd-summary').first().innerText() : body;
    for (const s of item.summary) {
      const label = typeof s === 'string' ? s : s.label;
      if (label && !norm(sum).includes(norm(label.replace(/【|】/g, ''))) && !norm(sum).includes(norm(label))) diffs.push(`${id} 缺汇总 ${label}`);
    }
  }
  if (item.pagination?.page_size || item.page_size) {
    const sizeRaw = String(item.pagination?.page_size || item.page_size);
    const size = sizeRaw.replace(/条\/页/g, '').trim();
    const footLoc = page.locator('.kgd-foot');
    const foot = (await footLoc.count()) ? await footLoc.first().innerText() : (await page.locator('.ant-pagination').count() ? await page.locator('.ant-pagination').last().innerText() : body);
    if (!new RegExp(`${size}\\s*条/页`).test(foot) && !foot.includes(`${size} 条/页`) && !foot.includes(`${size}条/页`)) {
      diffs.push(`${id} 分页 期望 ${size} 条/页 实际 ${foot.slice(0, 80)}`);
    }
  }
  if (item.pagination?.total_text || item.total_text) {
    const foot = await page.locator('.kgd-foot').count() ? await page.locator('.kgd-foot').innerText() : body;
    if (!/共\d+条数据/.test(norm(foot)) && !/共\d+条数据/.test(foot.replace(/\s+/g, ''))) diffs.push(`${id} 缺共N条数据`);
  }
  if (Array.isArray(item.row_actions) && await page.locator('.ant-table-tbody tr.ant-table-row').count()) {
    const rowText = await page.locator('.ant-table-tbody tr.ant-table-row').first().innerText();
    for (const act of item.row_actions) {
      if (!norm(rowText).includes(norm(act)) && !await page.locator('.ant-table-tbody tr.ant-table-row').first().getByText(act, { exact: false }).count()) {
        diffs.push(`${id} 行操作缺 ${act}`);
      }
    }
  }
  if (Array.isArray(item.info_fields) && item.info_fields.length) {
    const labels = await page.locator('.kgd-detail-grid dt').evaluateAll((els) => els.map((el) => (el.innerText || '').replace(/\s+/g, '')));
    if (labels.length) {
      const exp = item.info_fields.map(norm);
      const got = labels.map(norm);
      if (got.join('|') !== exp.join('|')) diffs.push(`${id} 信息区 期望 ${item.info_fields.join(',')} 实际 ${labels.join(',')}`);
    } else {
      const text = await visibleText(page);
      for (const label of item.info_fields) {
        if (!norm(text).includes(norm(label))) diffs.push(`${id} 信息区缺 ${label}`);
      }
    }
  }
  if (item.tab_columns && typeof item.tab_columns === 'object') {
    for (const [tab, cols] of Object.entries(item.tab_columns)) {
      await clickNamedTab(page, tab);
      await page.waitForTimeout(200);
      const cleaned = await visibleHeaders(page);
      const colList = Array.isArray(cols) ? cols : [];
      const exp = colList.map(norm);
      const got = cleaned.map(norm);
      if (got.slice(0, exp.length).join('|') !== exp.join('|') && got.join('|') !== exp.join('|')) {
        diffs.push(`${id} 页签${tab}列 期望 ${colList.join(',')} 实际 ${cleaned.join(',')}`);
      }
    }
    const homeTab = Array.isArray(item.tabs) ? item.tabs[0] : null;
    if (homeTab) {
      await clickNamedTab(page, homeTab);
      await page.waitForTimeout(200);
    }
  }
  if (item.tab_buttons && typeof item.tab_buttons === 'object' && !Array.isArray(item.tab_buttons)) {
    for (const [tab, btns] of Object.entries(item.tab_buttons)) {
      await clickNamedTab(page, tab);
      await page.waitForTimeout(150);
      const btnList = Array.isArray(btns) ? btns : [];
      for (const btn of btnList) {
        if (skip.has(norm(btn))) continue;
        if (!norm(await visibleText(page)).includes(norm(btn))) diffs.push(`${id} 页签${tab}缺按钮 ${btn}`);
      }
    }
  }
  if (Array.isArray(item.settings_cards)) {
    for (const card of item.settings_cards) {
      if (card.title && !norm(body).includes(norm(card.title))) diffs.push(`${id} 缺设置卡 ${card.title}`);
      for (const field of card.items || []) {
        if (field.label && !norm(body).includes(norm(field.label))) diffs.push(`${id} 设置项缺 ${field.label}`);
        if (field.desc && !norm(body).includes(norm(field.desc))) diffs.push(`${id} 设置说明缺 ${field.desc}`);
      }
      for (const btn of card.buttons || []) {
        if (!norm(body).includes(norm(btn))) diffs.push(`${id} 设置卡缺按钮 ${btn}`);
      }
    }
  }
  if (Array.isArray(item.side_tables)) {
    for (const title of item.side_tables) {
      const name = typeof title === 'string' ? title : title.title || title.name;
      if (name && !norm(body).includes(norm(name))) diffs.push(`${id} 缺侧表 ${name}`);
    }
  }
  if (Array.isArray(item.step_forms)) {
    for (const step of item.step_forms) {
      if (step.step && !norm(body).includes(norm(step.step))) diffs.push(`${id} 缺步骤 ${step.step}`);
    }
    const first = item.step_forms[0];
    if (first) {
      for (const field of first.fields || []) {
        const label = field.label || field;
        if (label && !norm(body).includes(norm(String(label).replace(/:$/, '')))) diffs.push(`${id} 向导缺字段 ${label}`);
      }
      for (const btn of first.buttons || []) {
        if (!norm(body).includes(norm(btn))) diffs.push(`${id} 向导缺按钮 ${btn}`);
      }
    }
  }
  if (item.adv_search) {
    const opened = await clickPacked(page, '高级查询', 'toolbar');
    if (opened) {
      await page.waitForTimeout(250);
      const spec = item.adv_search;
      const panel = page.locator('.kgd-adv').first();
      if (!(await panel.count())) diffs.push(`${id} 高级查询浮层未展开`);
      const buttons = spec.buttons || [];
      const panelText = (await panel.count()) ? await panel.innerText() : await visibleText(page);
      for (const btn of buttons) {
        if (!norm(panelText).includes(norm(btn))) diffs.push(`${id} 高级查询缺按钮 ${btn}`);
      }
      const options = spec.field_options || [];
      if (options.length) {
        const fieldSelect = page.locator('.kgd-adv .ant-select').first();
        if (await fieldSelect.count()) {
          await fieldSelect.waitFor({ state: 'visible', timeout: 5000 });
          await fieldSelect.scrollIntoViewIfNeeded();
          await fieldSelect.click();
        }
        await page.waitForTimeout(250);
        const fieldList = page.locator('.kgd-adv-field-list');
        const dropItems = page.locator('.ant-select-dropdown:visible, .kgd-adv-drop .ant-select-item');
        const area = [
          panelText,
          (await fieldList.count()) ? (await fieldList.allInnerTexts()).join('\n') : '',
          (await dropItems.count()) ? (await dropItems.allInnerTexts()).join('\n') : '',
        ].join('\n');
        for (const opt of options) {
          if (!norm(area).includes(norm(opt))) diffs.push(`${id} 高级查询缺字段 ${opt}`);
        }
        await page.keyboard.press('Escape');
      }
      const searchBtn = page.locator('.kgd-adv').getByRole('button', { name: '搜 索' }).first();
      if (await searchBtn.count()) {
        await searchBtn.waitFor({ state: 'visible', timeout: 5000 });
        await searchBtn.scrollIntoViewIfNeeded();
        await searchBtn.click();
      }
      await dismissOverlays(page);
    } else diffs.push(`${id} 缺高级查询`);
  }
  if (Array.isArray(item.dialogs)) {
    for (const dlg of item.dialogs) {
      if (!dlg.trigger) continue;
      if (/›|tooltip|齿轮|第\s*\d+\s*步|列「|查看\(n\)/.test(dlg.trigger)) {
        warnings.push(`${id} 弹窗触发跳过 ${dlg.trigger}`);
        continue;
      }
      await dismissOverlays(page);
      const clicked = await clickTrigger(page, dlg.trigger);
      if (!clicked) {
        diffs.push(`${id} 弹窗触发缺失 ${dlg.trigger}`);
        continue;
      }
      await page.waitForTimeout(400);
      const advFloat = page.locator('.kgd-adv').first();
      // 理由：pages.json 高级查询是浮层无标题，how_to_check 认 .kgd-adv，不是 role=dialog。
      if (norm(dlg.trigger) === '高级查询' && await advFloat.count() && await advFloat.isVisible()) {
        const box = await advFloat.innerText();
        for (const btn of dlg.buttons || []) {
          if (!norm(box).includes(norm(btn))) diffs.push(`${id} 弹窗缺按钮 ${btn}`);
        }
        const searchBtn = advFloat.getByRole('button', { name: '搜 索' }).first();
        if (await searchBtn.count()) {
          await searchBtn.waitFor({ state: 'visible', timeout: 5000 });
          await searchBtn.scrollIntoViewIfNeeded();
          await searchBtn.click();
        }
        await dismissOverlays(page);
        await page.waitForTimeout(150);
        continue;
      }
      const dialog = page.getByRole('dialog').filter({ visible: true }).or(page.locator('.ant-modal-wrap:not([style*="display: none"]) .ant-modal-content, .ant-drawer-open .ant-drawer-content')).first();
      try {
        await dialog.waitFor({ state: 'visible', timeout: 8000 });
      } catch {
        diffs.push(`${id} 弹窗未打开 ${dlg.trigger}`);
        await dismissOverlays(page);
        continue;
      }
      const modal = page.locator('.ant-modal-content:visible, .ant-drawer-open .ant-drawer-content, [role="dialog"]:visible').last();
      if (dlg.title) {
        const title = await modal.locator('.ant-modal-title').innerText();
        if (!titleMatches(title, dlg.title)) diffs.push(`${id} 弹窗标题 期望 ${dlg.title} 实际 ${title}`);
      }
      const box = await modal.innerText();
      for (const field of dlg.fields || []) {
        const label = field.label || field;
        if (!norm(box).includes(norm(typeof label === 'string' ? label : label))) diffs.push(`${id} 弹窗缺字段 ${label}`);
        if (field.required === true) {
          const lab = typeof label === 'string' ? label : String(label);
          const requiredItem = await modal.locator('.ant-form-item-required').filter({ hasText: lab }).count();
          const star = requiredItem || await modal.evaluate((el, text) => {
            const packed = (el.innerText || '').replace(/\s+/g, '');
            const n = String(text).replace(/\s+/g, '');
            return packed.includes(`*${n}`) || packed.includes(`${n}*`) || !!el.querySelector('.ant-form-item-required');
          }, lab);
          if (!star) diffs.push(`${id} 字段未标红星 ${lab}`);
        }
      }
      await dismissOverlays(page);
      await page.waitForTimeout(150);
    }
  }
  await shot(page, path.join(OUT, 'pages', `${id}.png`));
  } catch (failure) {
    diffs.push(`${id} 脚本异常 ${failure instanceof Error ? failure.message : String(failure)}`);
    await dismissOverlays(page);
  }
}

} finally {
writeReport('pages-compare', diffs, warnings);
await browser.close();
}
if (diffs.length) process.exit(1);
