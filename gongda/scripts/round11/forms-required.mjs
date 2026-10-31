/**
 * T30 58 项表单空提交：读页面第一条报错文案，标红后按顺序补齐再保存。
 * 理由：骨架只覆盖 3 条且用 catch；改为 ≥58 用例。
 * 二字按钮 antd 插空格、+新增 用去空白完整文案点；单条超时记差异并写完报告，不断言改 expect。
 * React 19 受控输入必须用 Playwright fill，evaluate 改 value 不会进 onChange。
 * 新增若是 Dropdown，点「直接创建」否则点第一条菜单（仓库加工单出库等）。
 * 独立 /add 页保存后回对应 /list 再搜，避免在空编辑页找记录。
 * F12 直接打开 /process_routing/add：列表新增被工具栏挡住点不进独立页，expect 仍是请填写名称。
 * 右下角 FloatButton 会挡住弹窗保存，waitReady 里关掉命中。
 * BOM POST 允许 request_key，与路线创建一致，否则名称填上仍 422。
 * 弹窗确定只点最后一个可见 wrap（offsetHeight>0），避免点到 display:none 残留层。
 * 填值打最后一个可见弹窗，避免填到下层弹窗。
 * 保存后按名称类查询条件搜，不填编号框。
 * F25 点「新增扩展字段」对话框内的确定，避免点到外层扩展字段管理层。
 * F12/F13 空明细建档靠 migration 101 放宽 require_complete_header，不改 expect。
 * F25 自定义 footer 的确定用普通 Playwright click（不要 force）；force/DOM/fiber 都可能进不了 antd Button onClick。
 * F49d 新增=申请开票（对齐 pages.json P031），expect 请选择合同。
 * F46 客户弹窗用 dialog getByLabel 填值，避免填到残留层。
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { OUT, openPage, shot, waitReady, WEB, writeReport } from './_lib.mjs';

const cases = JSON.parse(readFileSync('scripts/round11/forms.json', 'utf8'));
const outDir = path.join(OUT, 'forms');
mkdirSync(outDir, { recursive: true });
const submitFallbacks = ['确定', '保存', '提交', '提交申请', '提交审核', '创建生产计划', '创建加工单'];

function firstError(page) {
  return page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.kgd-field-help, .ant-form-item-explain-error, .kgd-banner, .ant-message-error, .ant-message-notice-content, .kgd-field-error')];
    const texts = nodes.map((node) => (node.innerText || '').trim().split('\n')[0]).filter(Boolean);
    const shortPlease = texts.find((text) => /^(请填写|请选择|请至少)/.test(text) && text.length < 40);
    const startPlease = texts.find((text) => text.startsWith('请') && text.length < 40);
    return shortPlease || startPlease || '';
  });
}

async function markPacked(page, trigger, scopeModal, preferRow) {
  return page.evaluate((args) => {
    const want = String(args.trigger).replace(/\s+/g, '');
    function shown(node) {
      let el = node;
      while (el && el !== document.body) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) return false;
        el = el.parentElement;
      }
      return true;
    }
    document.querySelectorAll('[data-r11-click]').forEach((node) => node.removeAttribute('data-r11-click'));
    const wraps = [...document.querySelectorAll('.ant-modal-wrap')].filter((wrap) => {
      if (getComputedStyle(wrap).display === 'none' || wrap.offsetHeight < 8) return false;
      return !!wrap.querySelector('.ant-modal');
    });
    const root = args.scopeModal ? (wraps[wraps.length - 1] || document) : document;
    const nodes = [...root.querySelectorAll('button, .ant-btn, [role="button"], a.ant-btn, .kgd-link')].filter((node) => {
      if (!shown(node)) return false;
      const packed = String(node.innerText || node.getAttribute('aria-label') || '').replace(/\s+/g, '');
      return packed === want || packed === `+${want}`;
    });
    const footerPrimary = nodes.filter((node) => node.closest('.ant-modal-footer, .ant-drawer-footer') && node.classList.contains('ant-btn-primary'));
    const footer = nodes.filter((node) => node.closest('.ant-modal-footer, .ant-drawer-footer'));
    const toolbar = nodes.filter((node) => node.closest('.kgd-toolbar, .kgd-actions'));
    const row = nodes.filter((node) => node.closest('.ant-table, tbody, tr'));
    const hit = footerPrimary[0] || footer[0] || (args.scopeModal ? nodes[0] : (args.preferRow ? (row[0] || toolbar[0] || nodes[0]) : (toolbar[0] || nodes[0])));
    if (!hit) return false;
    hit.setAttribute('data-r11-click', '1');
    return true;
  }, { trigger, scopeModal, preferRow });
}

async function clickPacked(page, trigger, scopeModal = false, preferRow = false) {
  const marked = await markPacked(page, trigger, scopeModal, preferRow);
  if (!marked) return false;
  const loc = page.locator('[data-r11-click="1"]').first();
  if (await loc.count()) {
    await loc.waitFor({ state: 'visible', timeout: 4000 });
    await loc.scrollIntoViewIfNeeded();
    await loc.click({ timeout: 4000 });
    await page.evaluate(() => document.querySelectorAll('[data-r11-click]').forEach((node) => node.removeAttribute('data-r11-click')));
    return true;
  }
  return false;
}

function isEditorPage(url) {
  try {
    const pathName = new URL(url).pathname;
    return /\/(add|edit)(\/|$)/.test(pathName);
  } catch {
    return false;
  }
}

async function clickSubmit(page, submitName, preferPage = false) {
  const names = [];
  if (typeof submitName === 'string') names.push(submitName);
  for (const name of submitFallbacks) {
    if (!names.some((item) => item.replace(/\s+/g, '') === name.replace(/\s+/g, ''))) names.push(name);
  }
  if (!preferPage) {
    const wrapCount = await page.locator('.ant-modal-wrap').count();
    for (let i = wrapCount - 1; i >= 0; i -= 1) {
      const wrap = page.locator('.ant-modal-wrap').nth(i);
      if (!(await wrap.isVisible())) continue;
      const primary = wrap.locator('.ant-modal-footer .ant-btn-primary').first();
      if (await primary.count()) {
        await primary.waitFor({ state: 'visible', timeout: 4000 });
        await primary.scrollIntoViewIfNeeded();
        await primary.click({ timeout: 4000 });
        return true;
      }
    }
    for (const name of names) {
      if (await clickPacked(page, name, true)) return true;
    }
  }
  for (const name of names) {
    if (await clickPacked(page, name, false)) return true;
  }
  return false;
}

async function fillField(page, label, value) {
  const marked = await page.evaluate((want) => {
    function shown(node) {
      let el = node;
      while (el && el !== document.body) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) return false;
        el = el.parentElement;
      }
      return true;
    }
    document.querySelectorAll('[data-r11-fill]').forEach((node) => node.removeAttribute('data-r11-fill'));
    function pick(root) {
      const labels = [...root.querySelectorAll('span, label, .ant-form-item-label, dt, .goods-field label')];
      const hit = labels.find((node) => {
        if (node.closest('.kgd-query, .kgd-query-fields, .kgd-adv')) return false;
        return String(node.innerText || '').replace(/\s+/g, '').includes(want);
      });
      if (!hit) return null;
      const item = hit.closest('.ant-form-item, .goods-field');
      if (item) {
        return item.querySelector('input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), textarea');
      }
      let el = hit.nextElementSibling;
      while (el && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && !el.querySelector?.('input, textarea')) el = el.nextElementSibling;
      if (!el) return null;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el;
      return el.querySelector('input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), textarea');
    }
    const modals = [...document.querySelectorAll('.ant-modal-content')].filter((node) => shown(node) && node.closest('.ant-modal-wrap')?.offsetHeight > 8);
    const pages = [...document.querySelectorAll('.goods-editor, .kgd-form, .kgd-card')].filter((node) => shown(node));
    const roots = modals.length ? [modals[modals.length - 1]] : pages;
    for (const root of roots) {
      const input = pick(root);
      if (input && shown(input)) {
        input.setAttribute('data-r11-fill', '1');
        return true;
      }
    }
    const byPh = [...document.querySelectorAll('.ant-modal-content input, .ant-modal-content textarea, .kgd-form input, .kgd-form textarea')].find((el) => shown(el) && String(el.getAttribute('placeholder') || '').replace(/\s+/g, '').includes(want));
    if (byPh) {
      byPh.setAttribute('data-r11-fill', '1');
      return true;
    }
    return false;
  }, String(label).replace(/\s+/g, ''));
  const loc = page.locator('[data-r11-fill="1"]').first();
  if (marked && await loc.count()) {
    await loc.waitFor({ state: 'visible', timeout: 4000 });
    await loc.scrollIntoViewIfNeeded();
    await loc.click();
    await loc.fill('');
    await loc.fill(value);
    await page.evaluate(() => document.querySelectorAll('[data-r11-fill]').forEach((node) => node.removeAttribute('data-r11-fill')));
    return;
  }
  const box = page.getByLabel(label).or(page.getByPlaceholder(label)).first();
  if (await box.count()) await box.fill(value);
}

async function clickOpenMenu(page) {
  await page.waitForTimeout(280);
  const count = await page.locator('.ant-dropdown:not(.ant-dropdown-hidden) [role="menuitem"], .ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item').count();
  if (!count) return;
  const direct = page.locator('.ant-dropdown:not(.ant-dropdown-hidden)').getByRole('menuitem', { name: '直接创建' });
  if (await direct.count()) {
    const item = direct.first();
    await item.waitFor({ state: 'visible', timeout: 5000 });
    await item.scrollIntoViewIfNeeded();
    await item.click();
  } else {
    const item = page.locator('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item, .ant-dropdown:not(.ant-dropdown-hidden) [role="menuitem"]').first();
    await item.waitFor({ state: 'visible', timeout: 5000 });
    await item.scrollIntoViewIfNeeded();
    await item.click();
  }
  await page.waitForTimeout(400);
}

async function dismissForms(page) {
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);
  }
  await page.evaluate(() => {
    document.querySelectorAll('.ant-modal-close').forEach((node) => {
      const wrap = node.closest('.ant-modal-wrap');
      if (wrap && getComputedStyle(wrap).display !== 'none') node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  });
  await page.waitForTimeout(180);
}

function searchUrl(url) {
  return String(url).replace(/\/add(?:\?.*)?$/, '/list');
}

const { browser, page } = await openPage();
const diffs = [];

try {
for (const item of cases) {
  console.log(item.id, item.url, item.open || '');
  try {
    await page.goto(`${WEB}${item.url}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitReady(page);
    if (/\/goods\/add/.test(item.url)) {
      await page.getByText('新增商品').first().waitFor({ timeout: 5000 });
    }
    const opensByUrl = /\/add/.test(item.url) && !item.open;
    if (!opensByUrl) await dismissForms(page);
    else await page.waitForTimeout(200);
    if (item.open) {
      const before = page.url();
      const rowFirst = /^(收款|付款)$/.test(String(item.open).replace(/\s+/g, ''));
      const clicked = await clickPacked(page, item.open, false, rowFirst);
      if (!clicked) {
        diffs.push(`${item.id} 打不开 ${item.open}`);
        await shot(page, path.join(outDir, `${item.id}-a-empty.png`));
        await shot(page, path.join(outDir, `${item.id}-b-saved.png`));
        continue;
      }
      await clickOpenMenu(page);
      await page.waitForTimeout(200);
      if (!isEditorPage(page.url())) {
        const modalVisible = await page.evaluate(() => [...document.querySelectorAll('.ant-modal-wrap')].some((wrap) => getComputedStyle(wrap).display !== 'none' && wrap.offsetHeight > 8));
        if (!modalVisible && String(item.open).replace(/\s+/g, '') === '新增') {
          const addBtn = page.locator('.kgd-toolbar .ant-btn-primary').filter({ hasText: /新\s*增/ }).first();
          if (await addBtn.count()) {
            await addBtn.waitFor({ state: 'visible', timeout: 5000 });
            await addBtn.scrollIntoViewIfNeeded();
            await addBtn.click();
          }
          await clickOpenMenu(page);
        }
      }
      if (String(item.open).replace(/\s+/g, '') === '扩展字段') {
        await page.waitForTimeout(400);
        await page.getByText('扩展字段管理').first().waitFor({ timeout: 4000 });
        const dlgAdd = page.locator('.ant-modal-wrap').filter({ hasText: '扩展字段管理' }).locator('button.ant-btn-primary').filter({ hasText: /新\s*增/ });
        if (await dlgAdd.count()) {
          const btn = dlgAdd.first();
          await btn.waitFor({ state: 'visible', timeout: 5000 });
          await btn.scrollIntoViewIfNeeded();
          await btn.click();
        } else await clickPacked(page, '新增', true);
        await page.getByText('新增扩展字段').first().waitFor({ timeout: 5000 });
        await page.waitForTimeout(300);
      }
      if (String(item.open).replace(/\s+/g, '') === '付款') {
        await page.getByText('新增采购付款').first().waitFor({ timeout: 4000 });
      }
      if (page.url() !== before) await waitReady(page);
    }
    const submitName = item.submit || /确\s*定|保\s*存|提\s*交|创建/;
    const extDlg = page.locator('.ant-modal-wrap').filter({ hasText: '新增扩展字段' });
    if (await extDlg.count()) {
      const ok = extDlg.last().locator('.ant-modal-footer .ant-btn-primary').first();
      if (await ok.count()) {
        await ok.waitFor({ state: 'visible', timeout: 5000 });
        await ok.scrollIntoViewIfNeeded();
        await ok.click({ timeout: 5000 });
      } else await clickSubmit(page, submitName, isEditorPage(page.url()));
    } else {
      await clickSubmit(page, submitName, isEditorPage(page.url()));
    }
    await page.waitForTimeout(700);
    const err = await firstError(page);
    if (item.expect && !err.includes(item.expect) && !err.replace(/\s+/g, '').includes(item.expect.replace(/\s+/g, ''))) {
      diffs.push(`${item.id} 期望 ${item.expect} 实际 ${err || '(空)'}`);
    }
    const hasRed = await page.locator('.ant-form-item-has-error, .kgd-field-error, .kgd-field-error-label, .ant-input-status-error, .ant-select-status-error, .kgd-banner, .ant-message-error, .ant-message-notice, .kgd-field-help').count();
    if (!hasRed && item.expect) diffs.push(`${item.id} 未标红`);
    await shot(page, path.join(outDir, `${item.id}-a-empty.png`));
    if (item.fill) {
      for (const field of item.fill) {
        if (item.id === 'F46') {
          const dlg = page.getByRole('dialog').filter({ hasText: '新增客户' });
          const box = dlg.getByLabel(field.label).or(dlg.locator('.ant-form-item').filter({ hasText: field.label }).locator('input').first());
          if (await box.count()) await box.first().fill(field.value);
          else await fillField(page, field.label, field.value);
        } else {
          await fillField(page, field.label, field.value);
        }
      }
      if (await extDlg.count()) {
        const ok = extDlg.last().locator('.ant-modal-footer .ant-btn-primary').first();
        if (await ok.count()) {
          await ok.waitFor({ state: 'visible', timeout: 5000 });
          await ok.scrollIntoViewIfNeeded();
          await ok.click({ timeout: 5000 });
        } else await clickSubmit(page, submitName, isEditorPage(page.url()));
      } else if (item.id === 'F46') {
        const ok = page.getByRole('dialog').filter({ hasText: '新增客户' }).locator('.ant-modal-footer .ant-btn-primary').first();
        if (await ok.count()) {
          await ok.waitFor({ state: 'visible', timeout: 5000 });
          await ok.scrollIntoViewIfNeeded();
          await ok.click({ timeout: 5000 });
        } else await clickSubmit(page, submitName, false);
      } else {
        await clickSubmit(page, submitName, isEditorPage(page.url()));
      }
      await page.waitForTimeout(1200);
      await shot(page, path.join(outDir, `${item.id}-b-saved.png`));
      if (item.search) {
        await page.goto(`${WEB}${searchUrl(item.url)}`, { waitUntil: 'domcontentloaded' });
        await waitReady(page);
        await page.waitForTimeout(1000);
        const bodyText = await page.locator('body').innerText();
        let found = bodyText.includes(item.search) || await page.getByText(item.search).count();
        if (!found) {
          const nameBox = page.locator('.kgd-query input[placeholder*="名称"], .kgd-query input[placeholder*="商品名"], .kgd-query input[placeholder*="客户"], .kgd-query-fields input[placeholder*="名称"], .kgd-query-fields input[placeholder*="商品名"]');
          const box = (await nameBox.count()) ? nameBox.first() : page.locator('.kgd-query input, .kgd-query-fields input').first();
          if (await box.count()) {
            await box.fill(item.search);
            await clickPacked(page, '查询', false);
            await page.waitForTimeout(800);
          }
          found = (await page.locator('body').innerText()).includes(item.search) || await page.getByText(item.search).count();
        }
        if (!found) diffs.push(`${item.id} 保存后列表未见 ${item.search}`);
      }
    } else {
      await shot(page, path.join(outDir, `${item.id}-b-saved.png`));
    }
    await dismissForms(page);
  } catch (failure) {
    diffs.push(`${item.id} 脚本异常 ${failure instanceof Error ? failure.message : String(failure)}`);
    await dismissForms(page);
  }
}
} finally {
writeReport('forms-required', diffs);
await browser.close();
}
if (diffs.length) process.exit(1);
if (cases.length < 58) {
  console.error(`用例不足 58，实际 ${cases.length}`);
  process.exit(1);
}
