export function frozenRouteVersionId(bomVersion, fallbackRouteVersionId) {
  if (bomVersion?.route_version_id) return bomVersion.route_version_id;
  if (fallbackRouteVersionId) return fallbackRouteVersionId;
  throw new Error('样例没有可冻结的路线版本');
}

export function findDocument(items, code) {
  if (!Array.isArray(items)) throw new Error('单据列表无法识别');
  return items.find((item) => item?.code === code);
}

export function reusableSales(items, productId) {
  const named = findDocument(items, 'SO000001');
  if (named?.lines?.some((line) => line.product_id === productId)) return named;
  return undefined;
}

export function reusableWorkOrder(items, salesLineId) {
  const named = findDocument(items, 'WO000001');
  if (named && named.sales_line_id === salesLineId && named.execution !== 'cancelled') return named;
  return items.find((item) => item?.sales_line_id === salesLineId && item.execution !== 'cancelled');
}
