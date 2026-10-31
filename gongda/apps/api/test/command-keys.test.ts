import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandKeys } from '../../web/src/commandKeys.js';

test('响应不确定时相同命令复用请求标识，成功后同输入的新业务操作获得新标识', () => {
  let n = 0;
  const keys = new CommandKeys(() => `command-${++n}`);
  const first = keys.prepare('/api/production-reports', { request_key: 'ui-click-1', task_id: 'task-1', good_qty: '1' });
  const retry = keys.prepare('/api/production-reports', { good_qty: '1', task_id: 'task-1', request_key: 'ui-click-2' });
  assert.equal(retry.request_key, first.request_key);
  keys.complete('/api/production-reports', retry);
  assert.notEqual(keys.prepare('/api/production-reports', retry).request_key, first.request_key);
});
test('换源任务、数量、动作或版本不会误复用上一笔命令', () => {
  let n = 0;
  const keys = new CommandKeys(() => `command-${++n}`);
  const first = keys.prepare('/api/reports/a/actions', { request_key: 'x', action: 'approve', version: 1 });
  for (const [path, action, version] of [['/api/reports/b/actions','approve',1],['/api/reports/a/actions','reject',1],['/api/reports/a/actions','approve',2]] as const) assert.notEqual(keys.prepare(path, { request_key: 'x', action, version }).request_key, first.request_key);
});
test('明细键顺序不影响重试身份，数组顺序和实际数量变化会产生新身份', () => {
  let n = 0;
  const keys = new CommandKeys(() => `command-${++n}`);
  const first = keys.prepare('/api/shipments', { request_key: 'x', lines: [{ product_id: 'a', quantity: '1' }, { product_id: 'b', quantity: '2' }] });
  assert.equal(keys.prepare('/api/shipments', { request_key: 'y', lines: [{ quantity: '1', product_id: 'a' }, { quantity: '2', product_id: 'b' }] }).request_key, first.request_key);
  assert.notEqual(keys.prepare('/api/shipments', { ...first, lines: [...first.lines].reverse() }).request_key, first.request_key);
  assert.notEqual(keys.prepare('/api/shipments', { ...first, lines: [{ product_id: 'a', quantity: '3' }] }).request_key, first.request_key);
});
test('没有幂等键的请求不自动改变合同，陈旧成功响应不清除新业务重试键', () => {
  let n = 0;
  const keys = new CommandKeys(() => `stable-key-${++n}`);
  const raw = { version: 1 };
  assert.equal(keys.prepare('/api/members/a', raw), raw);
  const first = keys.prepare('/api/reports', { request_key: 'x', good_qty: '1' });
  keys.complete('/api/reports', { ...first, request_key: 'older-key' });
  assert.equal(keys.prepare('/api/reports', { ...first, request_key: 'next-click' }).request_key, first.request_key);
});
