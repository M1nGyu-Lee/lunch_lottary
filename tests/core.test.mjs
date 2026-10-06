import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanRestaurant, eligibleRestaurants, pickRestaurant, canReroll, normalizeSettings, isVerificationStale, recentlyEatenIds } from '../app/core.mjs';

const places = [
  { id: 'a', tags: ['한식'], zeroPay: 'verified' },
  { id: 'b', tags: ['일식'], zeroPay: 'verified' },
  { id: 'c', tags: ['한식'], zeroPay: 'unknown' }
];

test('제로페이 확인 완료 매장과 선택한 태그만 추첨한다', () => {
  assert.deepEqual(eligibleRestaurants(places, new Set(['한식'])).map(x => x.id), ['a']);
  assert.equal(eligibleRestaurants(places, new Set()).length, 2);
  assert.deepEqual(eligibleRestaurants(places, new Set(['한식']), false).map(x => x.id), ['a', 'c']);
});

test('재추첨은 조금 긁었을 때와 횟수 상한 내에서만 가능하다', () => {
  const settings = normalizeSettings({ revealThreshold: 14, rerollLimit: 2 });
  assert.equal(canReroll({ phase: 'normal', scratched: 1, rerolls: 0, settings }), false);
  assert.equal(canReroll({ phase: 'normal', scratched: 2, rerolls: 1, settings }), true);
  assert.equal(canReroll({ phase: 'normal', scratched: 15, rerolls: 0, settings }), false);
  assert.equal(canReroll({ phase: 'normal', scratched: 5, rerolls: 2, settings }), false);
  assert.equal(canReroll({ phase: 'final', scratched: 5, rerolls: 0, settings }), false);
  assert.equal(canReroll({ phase: 'ultimate', scratched: 5, rerolls: 0, settings }), false);
});

test('후보가 여러 곳이면 직전 결과를 피한다', () => {
  assert.equal(pickRestaurant(places.slice(0, 2), 'a', () => 0).id, 'b');
  assert.equal(pickRestaurant(places.slice(0, 1), 'a', () => 0).id, 'a');
});

test('음식점 필수 값과 태그를 검증한다', () => {
  assert.throws(() => cleanRestaurant({ name: '가게', address: '', tags: ['한식'] }));
  const item = cleanRestaurant({ name: ' 가게 ', address: ' 서울 ', tags: ['한식', '한식'], zeroPay: 'verified' });
  assert.equal(item.name, '가게'); assert.deepEqual(item.tags, ['한식']); assert.equal(item.verifiedAt, null);
});

test('제로페이 확인 날짜가 없거나 오래되면 재확인을 권한다', () => {
  const now = Date.parse('2026-09-30T00:00:00Z');
  assert.equal(isVerificationStale({ zeroPay: 'verified', verifiedAt: null }, now), true);
  assert.equal(isVerificationStale({ zeroPay: 'verified', verifiedAt: '2026-09-29T00:00:00Z' }, now), false);
  assert.equal(isVerificationStale({ zeroPay: 'verified', verifiedAt: '2026-01-01T00:00:00Z' }, now), true);
  assert.equal(isVerificationStale({ zeroPay: 'unknown', verifiedAt: null }, now), false);
});

test('최근 7일 실제 식사 기록만 후보 제외에 사용한다', () => {
  const draws = [
    { restaurantId: 'a', eatenOn: '2026-09-30' },
    { restaurantId: 'b', eatenOn: '2026-09-24' },
    { restaurantId: 'c', eatenOn: '2026-09-23' },
    { restaurantId: 'd', eatenOn: null },
    { restaurantId: 'e', eatenOn: '2026-10-01' }
  ];
  assert.deepEqual([...recentlyEatenIds(draws, '2026-09-30')].sort(), ['a', 'b']);
});
