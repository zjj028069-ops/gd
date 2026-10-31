/**
 * T28 菜单树比对：侧栏一级图标 + 二级树展开后读名称/层级/顺序/落地路径。
 * 理由：原版侧栏不是 ant-menu，是 .kgd-rail / .kgd-sub-item；脚本必须按 DOM 实读。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { api, loadJson, norm, openPage, OUT, shot, waitReady, WEB, writeReport } from './_lib.mjs';

const tree = loadJson('menu-tree.json');

function flattenExpected(nodes, screens) {
  const acc = [];
  function walk(list, level) {
    list.forEach((node, index) => {
      if (node.dynamic) {
        screens.forEach((screen, si) => {
          acc.push({ name: screen.menu_name || screen.name, level, order: index + 1 + si, path: `/_screen/pd/${screen.id}`, dynamic: true });
        });
        return;
      }
      acc.push({
        name: node.name,
        level,
        order: node.order ?? index + 1,
        path: node.path ?? null,
        uncertain: node.uncertain,
        uncertain_reason: node.uncertain_reason || '',
      });
      if (node.children) walk(node.children, level + 1);
    });
  }
  walk(nodes, 1);
  return acc;
}

const { browser, page, session } = await openPage();
await page.goto(`${WEB}/staging/area`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await waitReady(page);
await page.locator('.kgd-rail').waitFor({ state: 'visible', timeout: 15000 });

const screens = (await api(session, 'GET', '/api/data-screens')).items ?? [];
const expected = flattenExpected(tree.tree, screens);
const diffs = [];
const warnings = [];

async function expandAll() {
  for (let i = 0; i < 16; i += 1) {
    const closed = page.locator('.kgd-sub-item', { hasText: '▾' });
    const n = await closed.count();
    if (!n) break;
    await closed.first().click();
    await page.waitForTimeout(80);
  }
}

const actual = [];
const primaries = await page.locator('.kgd-rail button[aria-label]').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
for (const name of primaries) {
  await page.locator(`.kgd-rail button[aria-label="${name}"]`).click();
  await page.waitForTimeout(200);
  await expandAll();
  actual.push({ name, level: 1, path: null });
  const rows = await page.evaluate(() => {
    function depth(el) {
      let n = 2;
      let cur = el.parentElement;
      while (cur) {
        if (cur.classList?.contains('kgd-sub-children')) n += 1;
        if (cur.classList?.contains('kgd-sub')) break;
        cur = cur.parentElement;
      }
      return n;
    }
    return [...document.querySelectorAll('.kgd-sub .kgd-sub-item')].map((el) => ({
      name: (el.querySelector('span')?.textContent || el.textContent || '').replace(/[▴▾]/g, '').trim(),
      level: depth(el),
      leaf: !el.textContent.includes('▾') && !el.textContent.includes('▴'),
    })).filter((row) => row.name);
  });
  for (const row of rows) {
    let pathname = null;
    if (row.leaf) {
      const before = new URL(page.url()).pathname;
      await page.evaluate((label) => {
        const el = [...document.querySelectorAll('.kgd-sub .kgd-sub-item')].find((node) => {
          const name = (node.querySelector('span')?.textContent || node.textContent || '').replace(/[▴▾]/g, '').trim();
          const isLeaf = !node.textContent.includes('▾') && !node.textContent.includes('▴');
          return name === label && isLeaf;
        });
        el?.click();
      }, row.name);
      await page.waitForTimeout(250);
      const after = new URL(page.url()).pathname;
      pathname = after;
      if (after === before && name === '数据大屏' && row.name !== '大屏管理') {
        pathname = null;
      }
    }
    actual.push({ name: row.name, level: row.level, path: pathname });
  }
}

await shot(page, path.join(OUT, 'menu-expanded.png'));

const expPrimary = expected.filter((n) => n.level === 1);
if (primaries.length !== expPrimary.length) diffs.push(`一级数量 期望 ${expPrimary.length} 实际 ${primaries.length}`);
expPrimary.forEach((node, i) => {
  if (norm(primaries[i]) !== norm(node.name)) diffs.push(`一级顺序 期望 ${node.name} 实际 ${primaries[i]}`);
});

function takeExpectedLeaves(primaryName) {
  const idx = expected.findIndex((n) => n.level === 1 && n.name === primaryName);
  if (idx < 0) return [];
  const next = expected.findIndex((n, i) => i > idx && n.level === 1);
  return expected.slice(idx + 1, next < 0 ? undefined : next);
}

let cursor = 0;
for (const primary of primaries) {
  const gotPrimary = actual[cursor];
  cursor += 1;
  const expKids = takeExpectedLeaves(primary);
  for (const node of expKids) {
    const got = actual[cursor];
    cursor += 1;
    if (!got) {
      diffs.push(`少项 期望 ${primary}/${node.name}`);
      continue;
    }
    if (norm(got.name) !== norm(node.name)) {
      if (node.uncertain && /名称/.test(node.uncertain_reason)) warnings.push(`名称 ${node.name} 实际 ${got.name}`);
      else diffs.push(`改名 期望 ${node.name} 实际 ${got.name}`);
    }
    if (got.level !== node.level) diffs.push(`层级 ${node.name} 期望 ${node.level} 实际 ${got.level}`);
    if (node.path && got.path && got.path !== node.path) {
      if (node.uncertain && /路径/.test(node.uncertain_reason)) warnings.push(`路径 ${node.name} 期望 ${node.path} 实际 ${got.path}`);
      else diffs.push(`路径 ${node.name} 期望 ${node.path} 实际 ${got.path}`);
    }
  }
}

writeReport('menu-compare', diffs, warnings);
await browser.close();
if (diffs.length) process.exit(1);
