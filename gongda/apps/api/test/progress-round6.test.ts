import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floorPercent, progressLabel, processCountProgress, ringPercent, taskProgressFromTasks, workOrderOverdueSql } from '../src/progress-calc.js';

test('进度百分比向下取整', () => {
  assert.equal(progressLabel('1', '3'), '33% (1/3)');
  assert.equal(progressLabel('510', '600'), '85% (510/600)');
  assert.equal(progressLabel('0', '0'), '0% (0/0)');
});

test('工序进度按完成工序数计数', () => {
  assert.equal(processCountProgress([{ execution: 'completed' }, { execution: 'running' }, { execution: 'not_started' }]), '33% (1/3)');
  assert.equal(processCountProgress([{ execution: 'completed' }, { execution: 'completed' }, { execution: 'completed' }]), '100% (3/3)');
});

test('任务进度按良品/计划汇总', () => {
  assert.equal(taskProgressFromTasks([
    { plan_qty: '100', approved_good: '100' },
    { plan_qty: '100', approved_good: '50' },
    { plan_qty: '100', approved_good: '100' },
  ]), '83% (250/300)');
});

test('圆环百分比封顶 100', () => {
  assert.equal(ringPercent('120', '100'), 100);
  assert.equal(ringPercent('50', '100'), 50);
});

test('逾期 SQL 片段包含计划结束与交货日期', () => {
  const sql = workOrderOverdueSql('w');
  assert.match(sql, /planned_end/);
  assert.match(sql, /due_date/);
});

test('floorPercent 与任务书样例', () => {
  assert.equal(floorPercent(150n, 300n), 50);
  assert.equal(floorPercent(100n, 300n), 33);
});
