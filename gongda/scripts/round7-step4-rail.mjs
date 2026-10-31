/**
 * 第4步工人侧栏：`.kgd-rail` 按钮只有图标，文案在 aria-label / Tooltip。
 * 供 round7-accept 与 _prove-round7-step4 共用，避免 innerText 假通过。
 */
export async function countRailCustomerMenu(page) {
  const rail = page.locator('.kgd-rail');
  await rail.waitFor({ state: 'visible', timeout: 15000 });
  return rail.getByRole('button', { name: '客户管理', exact: true }).count();
}
