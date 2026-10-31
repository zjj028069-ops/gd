import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickByIds, requestKey, uuid } from '../../web/src/requestKey.ts';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function withCrypto(value: Crypto | { getRandomValues?: (bytes: Uint8Array) => Uint8Array; randomUUID?: () => string }, run: () => void) {
  const original = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value });
  try { run(); } finally { Object.defineProperty(globalThis, 'crypto', { configurable: true, value: original }); }
}

test('优先使用 crypto.randomUUID', () => {
  withCrypto({
    randomUUID: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    getRandomValues: () => { throw new Error('不应走到 getRandomValues'); },
  }, () => {
    assert.equal(uuid(), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    assert.equal(requestKey(), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });
});

test('randomUUID 缺失时用 getRandomValues 拼出 UUID', () => {
  withCrypto({
    getRandomValues(bytes: Uint8Array) {
      bytes.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      return bytes;
    },
  }, () => {
    assert.equal(uuid(), '01020304-0506-4708-890a-0b0c0d0e0f10');
  });
});

test('randomUUID 调用抛错时仍走 getRandomValues', () => {
  withCrypto({
    randomUUID: () => { throw new TypeError('crypto.randomUUID is not a function'); },
    getRandomValues(bytes: Uint8Array) {
      bytes.fill(1);
      return bytes;
    },
  }, () => {
    assert.match(uuid(), uuidPattern);
  });
});

test('连 getRandomValues 都没有时仍返回合法 UUID', () => {
  withCrypto({}, () => {
    assert.match(uuid(), uuidPattern);
  });
});

test('选中键与行 id 类型不同仍能命中', () => {
  const rows = [{ id: 7, name: '工序' }, { id: '8', name: '商品' }];
  assert.deepEqual(pickByIds(rows, ['7', 8]).map((row) => row.name), ['工序', '商品']);
  assert.deepEqual(pickByIds(rows, []), []);
});
