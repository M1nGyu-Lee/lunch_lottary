import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cleanReview, reviewSummary } from '../app/reviews.mjs';
import { AVATARS } from '../app/avatars.mjs';
const { createReviewEditor } = createRequire(import.meta.url)('../electron/reviews.cjs');
const draft = { id: 'review-1', restaurantId: 'r1', nickname: '점심친구', avatarId: 'pixel-cat', rating: 4,
  body: '<script>이 문자열은 텍스트로 표시</script>', photos: [], version: 1,
  createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z' };

test('리뷰 별점·닉네임·아이콘·사진 형식과 크기를 검증한다', () => {
  assert.equal(cleanReview(draft).avatarId, 'pixel-cat');
  assert.equal(cleanReview(draft).body, draft.body);
  for (const raw of [ { ...draft, nickname: ' ' }, { ...draft, rating: 4.5 }, { ...draft, rating: 0 },
    { ...draft, avatarId: '../secret' }, { ...draft, photos: ['https://example.com/a.jpg'] },
    { ...draft, photos: ['data:image/svg+xml;base64,AAAA'] }, { ...draft, photos: Array(4).fill('') },
    { ...draft, body: 'a'.repeat(1501) } ]) assert.throws(() => cleanReview(raw));
  assert.equal(new Set(AVATARS.map(a => a.style)).size, 3);
  assert.equal(reviewSummary([draft, { ...draft, id: 'other', rating: 2 }], 'r1').average, 3);
});

test('4자리 비밀번호를 해시로 저장하고 올바른 비밀번호로만 수정·삭제한다', async () => {
  const edit = createReviewEditor();
  const created = await edit({ type: 'createReview', review: draft, pin: '0427' }, [], {});
  const item = created.reviews[0];
  assert.notEqual(item.id, draft.id);
  assert.equal(item.version, 1);
  assert.equal(JSON.stringify(created.reviews).includes('0427'), false);
  assert.match(created.credentials[item.id].hash, /^[a-f0-9]{64}$/);
  await assert.rejects(edit({ type: 'updateReview', id: item.id, pin: '9999', expectedVersion: 1, review: { ...item, rating: 1 } }, created.reviews, created.credentials), /맞지/);
  assert.equal(created.reviews[0].rating, 4);
  const updated = await edit({ type: 'updateReview', id: item.id, pin: '0427', expectedVersion: 1,
    review: { ...item, id: 'fake', restaurantId: 'fake', rating: 5, avatarId: 'doodle-frog' } }, created.reviews, created.credentials);
  assert.equal(updated.reviews[0].restaurantId, 'r1'); assert.equal(updated.reviews[0].version, 2);
  assert.equal(updated.reviews[0].avatarId, 'doodle-frog'); assert.equal(updated.reviews[0].createdAt, item.createdAt);
  await assert.rejects(edit({ type: 'deleteReview', id: item.id, pin: '0427', expectedVersion: 1 }, updated.reviews, updated.credentials), /먼저 수정/);
  const deleted = await edit({ type: 'deleteReview', id: item.id, pin: '0427', expectedVersion: 2 }, updated.reviews, updated.credentials);
  assert.deepEqual(deleted, { reviews: [], credentials: {} });
});

test('틀린 비밀번호 연속 입력을 제한하고 복원한 공개 리뷰는 비밀번호 우회 수정을 막는다', async () => {
  const edit = createReviewEditor();
  const book = await edit({ type: 'createReview', review: draft, pin: '1234' }, [], {});
  const op = { type: 'deleteReview', id: book.reviews[0].id, pin: '0000', expectedVersion: 1 };
  for (let i = 0; i < 5; i++) await assert.rejects(edit(op, book.reviews, book.credentials), /맞지/);
  await assert.rejects(edit({ ...op, pin: '1234' }, book.reviews, book.credentials), /1분/);
  await assert.rejects(createReviewEditor()({ ...op, pin: '1234' }, book.reviews, {}), /원래 작성/);
});
