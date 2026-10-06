import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalSnapshot, normalizeSharedSnapshot } from '../app/sync-protocol.mjs';

test('공유 데이터 해시 입력은 레코드와 필드 순서에 영향받지 않는다', () => {
  const first = { restaurants: [{ id: 'b', name: 'B' }, { name: 'A', id: 'a' }], draws: [] };
  const second = { draws: [], restaurants: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] };
  assert.equal(canonicalSnapshot(first), canonicalSnapshot(second));
});

test('공유 데이터 구조와 개수 제한을 검사한다', () => {
  assert.throws(() => normalizeSharedSnapshot({ restaurants: [] }));
  assert.throws(() => normalizeSharedSnapshot({ restaurants: Array(5001).fill({ id: 'a' }), draws: [] }));
});
