import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWageFormula } from '../src/performance-pay.js';

// 理由：node:test 无全局 describe/it，不改断言，只补导入才能跑 T34。

function piece(qty: string, rate: string) {
  return evaluateWageFormula('case(${任务.计价方式}=="计件",${报工.良品数}*${报工.工资单价};${任务.计价方式}=="计时",${报工.报工时长}/3600*${报工.工资单价})', {
    '任务.计价方式': '计件', '报工.良品数': qty, '报工.工资单价': rate, '报工.报工时长': 0, '报工.不良品数': 0, '报工.报工数': qty,
  });
}
function time(seconds: number, rate: string) {
  return evaluateWageFormula('case(${任务.计价方式}=="计件",${报工.良品数}*${报工.工资单价};${任务.计价方式}=="计时",${报工.报工时长}/3600*${报工.工资单价})', {
    '任务.计价方式': '计时', '报工.良品数': '0', '报工.工资单价': rate, '报工.报工时长': seconds, '报工.不良品数': 0, '报工.报工数': 0,
  });
}

describe('工资回归 默认公式与 priceWage 同算法', () => {
  it('工资回归 计件五组含小数', () => {
    for (const [qty, rate] of [['1', '0.5'], ['100', '0.6'], ['1.234567', '0.3'], ['10.000001', '1.25'], ['0.000001', '9.99']]) {
      const hit = Number(piece(qty, rate));
      const miss = Number(qty) * Number(rate);
      assert.ok(Math.abs(hit - miss) < 1e-8, `${qty}*${rate} ${hit} vs ${miss}`);
    }
  });
  it('工资回归 计时五组', () => {
    for (const [sec, rate] of [[3600, '10'], [1800, '20'], [1, '3600'], [7200, '0.5'], [59, '12.345678']]) {
      const hit = Number(time(sec, rate));
      const miss = sec / 3600 * Number(rate);
      assert.ok(Math.abs(hit - miss) < 1e-6, `${sec}s ${hit} vs ${miss}`);
    }
  });
});
