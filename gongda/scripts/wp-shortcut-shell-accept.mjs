#!/usr/bin/env node
/**
 * 快捷入口九宫格 / ⋮编辑+刷新 / 多模块目录 / 添加组件左栏壳。
 * 只使用 Playwright。不重建库、不改密码、不跑 seed。
 * 前置：API 3001 与 WEB 5173 已启动，且 .local/dev-credentials.txt 可用。
 */
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const API = process.env.API_BASE ?? 'http://127.0.0.1:3001';
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const artifactDir = path.join(process.cwd(), 'artifacts/wp-shortcut-shell');
const docDir = path.join(process.cwd(), 'docs/verification/wp-shortcut-shell');
const optDir = '/opt/cursor/artifacts/wp-shortcut-shell';
mkdirSync(artifactDir, { recursive: true });
mkdirSync(docDir, { recursive: true });
mkdirSync(optDir, { recursive: true });

const nine = ['customer_add', 'follow_add', 'contract_add', 'invoice_apply', 'work_order_add', 'fg_receipt_add', 'process_add', 'defect_add', 'route_add'];
const nineLabels = ['新增客户', '快捷跟单', '新增合同', '申请开票', '创建加工单', '成品入库', '新增工序', '新增不良品项', '新增工艺路线'];
const groups = ['客户管理', '生产管理', '服务工单', '维保管理', '仓库管理', '其他'];
const shots = [];

function must(ok, message) {
  if (!ok) throw new Error(message);
}

const pass = readFileSync('.local/dev-credentials.txt', 'utf8').match(/admin\.local[\s\S]*?密码：(\S+)/)?.[1];
must(pass, '缺少 .local/dev-credentials.txt 中 admin.local 密码');

async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_slug: 'demo-a', username: 'admin.local', password: pass }),
  });
  const json = await res.json();
  const cookie = res.headers.getSetCookie?.()?.[0]?.split(';')[0] ?? '';
  if (!res.ok || !json.csrf_token) throw new Error(`登录失败 ${res.status}`);
  return { csrf: json.csrf_token, cookie };
}

async function api(session, pathName, method = 'GET', body) {
  const res = await fetch(`${API}${pathName}`, {
    method,
    headers: {
      cookie: session.cookie,
      ...(method !== 'GET' ? { 'x-csrf-token': session.csrf } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${pathName} ${res.status} ${text.slice(0, 400)}`);
  return json;
}

async function asUser(page, session) {
  const raw = session.cookie.split(';')[0];
  const eq = raw.indexOf('=');
  await page.context().addCookies([
    { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: WEB },
    { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: API },
  ]);
}

async function shot(page, name, locator) {
  await page.mouse.move(8, 8);
  const file = path.join(artifactDir, `${name}.png`);
  if (locator) await locator.screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage: false });
  const bytes = readFileSync(file);
  writeFileSync(path.join(optDir, `${name}.png`), bytes);
  writeFileSync(path.join(docDir, `${name}.png`), bytes);
  const md5 = createHash('md5').update(bytes).digest('hex');
  shots.push({ name, file: `artifacts/wp-shortcut-shell/${name}.png`, md5 });
  return md5;
}

async function openWorkplace(page) {
  await page.goto(`${WEB}/staging/area`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid=wp-root]').waitFor({ timeout: 20000 });
  await page.locator('[data-testid=wp-widget-shortcuts]').waitFor({ timeout: 20000 });
}

async function main() {
  const session = await login();
  const before = await api(session, '/api/workplace/config');
  const catalog = before.shortcut_catalog ?? [];
  must(catalog.length >= 26, `shortcut_catalog ${catalog.length} < 26`);
  for (const name of ['创建服务工单', '新增产品', '新增服务项目', '新增设备', '创建维保计划', '新增维保内容', '创建维修工单', '创建采购计划', '创建采购单', '采购入库', '其他入库', '销售出库', '其他出库', '创建调拨单', '库存盘点', '新增商品', '发布公告']) {
    must(catalog.some((item) => item.name === name), `API 目录缺少 ${name}`);
  }
  for (const group of groups) must(catalog.some((item) => item.group === group), `API 目录缺少分组 ${group}`);

  const cards = Array.isArray(before.cards) ? before.cards.map((item) => ({ ...item })) : [];
  if (!cards.some((item) => item.key === 'shortcuts')) cards.unshift({ key: 'shortcuts', visible: true });
  for (const item of cards) if (item.key === 'shortcuts') item.visible = true;
  const layout = Array.isArray(before.layout) ? before.layout.map((item) => ({ ...item })) : [];
  const shortcutLayout = layout.find((item) => item.key === 'shortcuts');
  if (shortcutLayout) {
    shortcutLayout.h = 3;
    shortcutLayout.w = 12;
  }
  const probed = await api(session, '/api/workplace/config', 'PUT', {
    cards,
    shortcuts: nine,
    layout,
    todo_prefs: before.todo_prefs,
    version: before.version,
  });
  const stored = probed.layout.find((item) => item.key === 'shortcuts');
  const storedH = stored?.h;
  const storedW = stored?.w;
  must(storedH >= 5, `写入 h=3 后 API 仍返回快捷入口高度 ${storedH}`);
  must(storedW === 6, `写入 w=12 后快捷入口宽度应为半栏 6，实际 ${storedW}`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let failure = null;
  try {
    await asUser(page, session);
    await openWorkplace(page);
    const widget = page.locator('[data-testid=wp-widget-shortcuts]');
    await widget.scrollIntoViewIfNeeded();
    const grid = await widget.evaluate((node) => {
      const buttons = [...node.querySelectorAll('.wp-shortcuts button')];
      const box = node.getBoundingClientRect();
      const header = node.querySelector('header');
      const rows = new Map();
      const cols = new Map();
      const clipped = [];
      for (const button of buttons) {
        const rect = button.getBoundingClientRect();
        const top = Math.round(rect.top);
        const left = Math.round(rect.left);
        rows.set(top, (rows.get(top) ?? 0) + 1);
        cols.set(left, (cols.get(left) ?? 0) + 1);
        if (rect.top < box.top - 1 || rect.bottom > box.bottom + 1 || rect.left < box.left - 1 || rect.right > box.right + 1 || rect.height < 36) clipped.push(button.getAttribute('data-key'));
      }
      const shortcuts = node.querySelector('.wp-shortcuts');
      const card = node.querySelector('.wp-card');
      const gridBox = shortcuts.getBoundingClientRect();
      const cardBox = card.getBoundingClientRect();
      const board = node.parentElement.getBoundingClientRect();
      const firstRow = buttons.slice(0, 3).map((button) => {
        const icon = button.querySelector('img')?.getBoundingClientRect();
        const rect = button.getBoundingClientRect();
        return {
          buttonLeft: rect.left,
          buttonRight: rect.right,
          center: icon ? icon.left + icon.width / 2 : rect.left + rect.width / 2,
        };
      });
      return {
        count: buttons.length,
        labels: buttons.map((button) => (button.textContent ?? '').trim()),
        rowCount: rows.size,
        colCount: cols.size,
        rowSizes: [...rows.values()],
        clipped,
        textOverflow: buttons.filter((button) => button.scrollWidth > button.clientWidth + 1).map((button) => button.getAttribute('data-key')),
        headerButtons: header ? header.querySelectorAll('button').length : 0,
        headerReload: Boolean(header?.querySelector('.anticon-reload, [aria-label=刷新]')),
        widgetWidth: box.width,
        boardWidth: board.width,
        gridWidth: gridBox.width,
        cardWidth: cardBox.width,
        centers: firstRow.map((item) => item.center - cardBox.left),
        buttonSpan: firstRow[2].buttonRight - firstRow[0].buttonLeft,
      };
    });
    must(grid.count === 9, `快捷入口可见 ${grid.count} ≠ 9`);
    must(JSON.stringify(grid.labels) === JSON.stringify(nineLabels), `九宫格文案 ${grid.labels.join(',')}`);
    must(grid.rowCount === 3 && grid.colCount === 3, `不是 3×3：行 ${grid.rowCount} 列 ${grid.colCount}`);
    must(grid.rowSizes.every((size) => size === 3), `行内个数 ${grid.rowSizes.join(',')}`);
    must(grid.clipped.length === 0, `快捷入口被裁切：${grid.clipped.join(',')}`);
    must(grid.headerButtons === 1, `标题栏按钮 ${grid.headerButtons}，应只有 ⋮`);
    must(grid.headerReload === false, '标题栏出现独立刷新图标');
    const widthRatio = grid.widgetWidth / grid.boardWidth;
    must(widthRatio > 0.42 && widthRatio < 0.55, `快捷入口不是半栏：卡 ${Math.round(grid.widgetWidth)} / 板 ${Math.round(grid.boardWidth)} = ${widthRatio.toFixed(3)}`);
    must(grid.textOverflow.length === 0, `快捷入口文案被裁切：${grid.textOverflow.join(',')}`);
    const targets = [grid.cardWidth * 0.25, grid.cardWidth * 0.5, grid.cardWidth * 0.75];
    const centerErr = grid.centers.map((center, index) => Math.abs(center - targets[index]));
    must(centerErr.every((err) => err < 8), `列中心未贴原版 25/50/75：${grid.centers.map((n) => Math.round(n)).join(',')} 卡 ${Math.round(grid.cardWidth)} 偏差 ${centerErr.map((n) => n.toFixed(1)).join(',')}`);
    must(Math.abs(grid.centers[0] - (grid.cardWidth - grid.centers[2])) < 3, '左右边距不对称');
    const pitch = grid.centers[1] - grid.centers[0];
    const pitchRatio = pitch / grid.cardWidth;
    must(pitch >= 136 && pitch <= 156, `图标中心距 ${pitch.toFixed(1)}px，应在 136–156（列宽 88–100 + 间距 48–56）`);
    must(pitchRatio > 0.22 && pitchRatio < 0.28, `中心距/卡宽 ${pitchRatio.toFixed(3)}，应贴近 0.25`);
    const blockRatio = grid.buttonSpan / grid.cardWidth;
    must(blockRatio > 0.58 && blockRatio < 0.70, `九宫格成块 ${Math.round(grid.buttonSpan)} / 卡 ${Math.round(grid.cardWidth)} = ${blockRatio.toFixed(3)}，应约 0.65`);
    console.log(`密度\t卡${Math.round(grid.cardWidth)} 网格${Math.round(grid.gridWidth)} 中心${grid.centers.map((n) => Math.round(n)).join('/')} 分位${grid.centers.map((n) => (n / grid.cardWidth).toFixed(3)).join('/')} 中心距${pitch.toFixed(1)}`);
    await shot(page, '01-九宫格完整', widget);

    await widget.locator('header .wp-more').click();
    const editItem = page.getByRole('menuitem', { name: '编辑', exact: true });
    const refreshItem = page.getByRole('menuitem', { name: '刷新', exact: true });
    await editItem.waitFor({ state: 'visible', timeout: 5000 });
    await refreshItem.waitFor({ state: 'visible', timeout: 5000 });
    must(await page.locator('[data-testid=wp-menu-edit]').count() === 1, '菜单缺少编辑');
    must(await page.locator('[data-testid=wp-menu-refresh]').count() === 1, '菜单缺少刷新');
    await shot(page, '02-更多菜单编辑刷新');
    const refreshed = page.waitForResponse((response) => response.url().includes('/api/workplace/summary') && response.request().method() === 'GET' && response.ok(), { timeout: 15000 });
    await refreshItem.click();
    const refreshedResponse = await refreshed;
    must(refreshedResponse.ok(), '刷新未重载工作台汇总');
    await editItem.waitFor({ state: 'hidden', timeout: 5000 });

    await widget.locator('header .wp-more').click();
    await page.getByRole('menuitem', { name: '编辑', exact: true }).click();
    const modal = page.locator('.ant-modal').filter({ hasText: '添加快捷入口' }).last();
    await modal.waitFor({ state: 'visible', timeout: 8000 });
    must((await modal.locator('.ant-modal-title').innerText()).trim() === '添加快捷入口', '弹窗标题不是添加快捷入口');
    const groupTitles = (await modal.locator('.wp-shortcut-group-title').allInnerTexts()).map((text) => text.trim());
    must(JSON.stringify(groupTitles) === JSON.stringify(groups), `分组 ${groupTitles.join(',')}`);
    const scroller = modal.locator('[data-testid=shortcut-optional-scroll]');
    const scroll = await scroller.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
    must(scroll.sh > scroll.ch + 24, `可选区不可滚 ${scroll.sh}/${scroll.ch}`);
    const routes = {
      service_order_add: '/service_order/list?add=1',
      service_product_add: '/service_product/list?add=1',
      service_item_add: '/service_item/list?add=1',
      device_add: '/device/list?add=1',
      maint_plan_add: '/inspection_plan/add/1',
      maint_content_add: '/inspection_content/list?add=1',
      repair_order_add: '/device_order/list?add=1',
      purchase_plan_add: '/produce_plan/list?add=1',
      purchase_order_add: '/purchase_order/list?add=1',
      purchase_in_add: '/purchase_stock_in_bill/list?add=1',
      other_in_add: '/else_stock_in_bill/list?add=1',
      sale_out_add: '/sale_stock_out_bill/list?add=1',
      other_out_add: '/else_stock_out_bill/list?add=1',
      transfer_add: '/stock_allocate_bill/list?add=1',
      stock_check_add: '/stock_taking_bill/list?add=1',
      goods_add: '/goods/list?add=1',
      notice_publish: '/notice/add',
    };
    for (const [key, to] of Object.entries(routes)) {
      const node = modal.locator(`[data-key=${key}]`);
      must(await node.count() === 1, `可选区缺少 ${key}`);
      const src = await node.locator('img.wp-shortcut-icon-img').getAttribute('src');
      must(Boolean(src && (/\.svg(\?|$)/i.test(src) || src.startsWith('data:image/svg+xml'))), `${key} 不是 SVG 图标`);
      must(await node.getAttribute('data-to') === to, `${key} 路由 ${await node.getAttribute('data-to')} ≠ ${to}`);
    }
    const noticePick = modal.locator('[data-testid=shortcut-optional-其他] [data-key=notice_publish]');
    const goodsPick = modal.locator('[data-testid=shortcut-optional-其他] [data-key=goods_add]');
    await noticePick.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const placed = await noticePick.evaluate((el) => {
      const scroller = el.closest('[data-testid=shortcut-optional-scroll]');
      const item = el.getBoundingClientRect();
      const box = scroller.getBoundingClientRect();
      return {
        inside: item.top >= box.top - 1 && item.bottom <= box.bottom + 1 && item.height > 24,
        itemTop: Math.round(item.top),
        itemBottom: Math.round(item.bottom),
        boxTop: Math.round(box.top),
        boxBottom: Math.round(box.bottom),
        scrollTop: scroller.scrollTop,
      };
    });
    must(placed.inside, `滚底后发布公告仍不可见 ${JSON.stringify(placed)}`);
    await goodsPick.waitFor({ state: 'visible', timeout: 5000 });
    await noticePick.waitFor({ state: 'visible', timeout: 5000 });
    await shot(page, '03-可选区滚底', modal);
    await noticePick.click();
    const savedNotice = page.waitForResponse((response) => response.url().includes('/api/workplace/config') && response.request().method() === 'PUT' && response.ok(), { timeout: 15000 });
    await modal.getByRole('button', { name: /^确\s*定$/ }).click();
    const noticePut = await savedNotice;
    must((noticePut.request().postDataJSON().shortcuts ?? []).includes('notice_publish'), '确定后未保存发布公告');
    await page.locator('[data-testid=wp-widget-shortcuts] button[data-key=notice_publish]').click();
    await page.waitForURL(/\/notice\/add/, { timeout: 15000 });
    await page.getByPlaceholder('请输入标题').waitFor({ timeout: 15000 });
    await shot(page, '04-发布公告路由');

    await openWorkplace(page);
    await page.locator('[data-testid=wp-widget-shortcuts] button[data-key=customer_add]').click();
    await page.waitForURL(/\/customer\/list/, { timeout: 15000 });
    const customerModal = page.locator('.ant-modal').filter({ hasText: '新增客户' }).last();
    await customerModal.waitFor({ state: 'visible', timeout: 10000 });
    must((await customerModal.locator('.ant-modal-title').innerText()).trim() === '新增客户', '新增客户未打开新增弹窗');
    await customerModal.getByRole('button', { name: /^取\s*消$/ }).click();

    await openWorkplace(page);
    await page.getByRole('button', { name: '配置工作台' }).click();
    await page.locator('[data-testid=wp-root].wp-editing').waitFor({ timeout: 10000 });
    await page.locator('.wp-toolbar').getByRole('button', { name: '添加组件' }).click();
    const picker = page.locator('.ant-modal').filter({ hasText: '添加组件' }).last();
    await picker.waitFor({ state: 'visible', timeout: 10000 });
    const pickerText = await picker.innerText();
    must(!pickerText.includes('原版未采到'), '添加组件弹窗仍有原版未采到');
    must(await picker.locator('.wp-stub-tag').count() === 0, '添加组件弹窗仍有黄标');
    await picker.locator('[data-testid=wp-picker-side]').waitFor();
    await picker.getByPlaceholder('搜索').waitFor();
    for (const [name, count] of [['全部', 18], ['通用', 4], ['工作效率', 2], ['智能报表', 12]]) {
      const nav = picker.locator(`[data-testid=wp-tab-${name}]`);
      const label = (await nav.innerText()).replace(/\s+/g, '');
      must(label === `${name}·${count}`, `左栏 ${name}「${label}」≠「${name}·${count}」`);
    }
    must(await picker.locator('[data-testid=wp-widget-card]').count() === 18, '组件卡不是 18');
    await page.waitForFunction(() => {
      const el = document.querySelector('.ant-modal-wrap:not([style*="display: none"]) .wp-preview');
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return rect.width >= 120 && rect.height >= 60;
    }, null, { timeout: 5000 });
    const side = await picker.locator('[data-testid=wp-picker-side]').boundingBox();
    const list = await picker.locator('[data-testid=wp-picker-grid]').boundingBox();
    const preview = await picker.locator('.wp-preview').first().boundingBox();
    must(side && list && side.x + side.width <= list.x + 4, '左栏不在预览左侧');
    must(preview && preview.width >= 120 && preview.height >= 60, `大预览过小 ${preview ? `${preview.width}x${preview.height}` : 'missing'}`);
    const ok = picker.locator('.ant-modal-footer').getByRole('button', { name: /^确\s*定$/ });
    must(await ok.isDisabled(), '未选择组件时确定仍可点');
    await shot(page, '05-添加组件左栏', picker);
    await picker.locator('[data-testid=wp-picker-search]').fill('库存预警');
    await page.waitForFunction(() => {
      const visible = [...document.querySelectorAll('[data-testid=wp-widget-card]')].filter((el) => getComputedStyle(el).display !== 'none');
      return visible.length === 1 && visible[0].getAttribute('data-key') === 'stock_alert';
    }, null, { timeout: 5000 });
    const searched = picker.locator('[data-testid=wp-widget-card]:visible');
    must(await searched.count() === 1, `搜索库存预警可见 ${await searched.count()}`);
    must(await searched.first().getAttribute('data-key') === 'stock_alert', '搜索结果不是库存预警');
    must((await searched.first().innerText()).includes('库存数量超出报警线范围的商品种类数量'), '库存预警描述丢失');
    await picker.locator('[data-testid=wp-picker-search]').fill('');
    await picker.locator('[data-testid=wp-tab-智能报表]').click();
    const smart = picker.locator('[data-testid=wp-widget-card]:visible');
    must(await smart.count() === 12, `智能报表可见 ${await smart.count()} ≠ 12`);
    const smartCats = await smart.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-category')));
    must(smartCats.every((item) => item === '智能报表'), '智能报表左栏混入其他分类');
    await picker.locator('.ant-modal-footer').getByRole('button', { name: /^取\s*消$/ }).click();
    await picker.waitFor({ state: 'hidden', timeout: 8000 });
    await page.locator('.wp-toolbar').getByRole('button', { name: /^取\s*消$/ }).click();
    const confirm = page.locator('.ant-modal').filter({ hasText: '确认退出' }).last();
    await confirm.waitFor({ state: 'visible', timeout: 8000 });
    await confirm.getByRole('button', { name: /^确\s*定$/ }).click();
    await page.locator('[data-testid=wp-root].wp-editing').waitFor({ state: 'detached', timeout: 8000 });
  } catch (error) {
    failure = error;
  } finally {
    await browser.close();
    const current = await api(session, '/api/workplace/config');
    await api(session, '/api/workplace/config', 'PUT', {
      cards: before.cards,
      shortcuts: before.shortcuts,
      layout: before.layout,
      todo_prefs: before.todo_prefs,
      version: current.version,
    });
  }
  if (failure) throw failure;

  const md5s = new Set(shots.map((item) => item.md5));
  must(md5s.size === shots.length, `截图 MD5 重复：${shots.map((item) => item.md5).join(',')}`);
  must(shots.length === 5, `截图 ${shots.length} ≠ 5`);
  writeFileSync(path.join(artifactDir, 'md5.json'), `${JSON.stringify(shots, null, 2)}\n`);
  writeFileSync(path.join(docDir, 'md5.json'), `${JSON.stringify(shots, null, 2)}\n`);
  console.log('通过\t快捷入口九宫格与添加组件左栏');
  for (const item of shots) console.log(`截图\t${item.file}\t${item.md5}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
