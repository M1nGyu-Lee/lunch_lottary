import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { canonicalLegacySnapshot, canonicalSnapshot } from '../app/sync-protocol.mjs';
const { createSyncService } = createRequire(import.meta.url)('../electron/sync.cjs');
const draft = { restaurantId: 'r1', nickname: '공유테스터', avatarId: 'fox', rating: 4, body: '맛있어요', photos: [] };
const port = 48000 + process.pid % 1000;
async function setup(directory) {
  const handlers = new Map();
  const service = await createSyncService({ app: { getPath: () => directory },
    BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    syncPort: port, discoveryPort: port + 1 });
  return { service, invoke: (name, ...args) => handlers.get(name)(null, ...args) };
}

test('기존 호스트 데이터를 보존하고 공유 리뷰의 비밀번호를 네트워크에 노출하지 않는다', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lunch-review-host-'));
  let instance;
  try {
    const snapshot = { restaurants: [{ id: 'r1', name: '기존 식당', address: '서울', tags: ['한식'], zeroPay: 'unknown' }], draws: [] };
    const roomId = 'migration-room', roomCode = 'A1B2C3D4E5F6';
    await writeFile(path.join(directory, 'sync-config.json'), JSON.stringify({ mode: 'host', roomId, roomCode }));
    await writeFile(path.join(directory, 'shared-state.json'), JSON.stringify({ schema: 1, roomId, epoch: 'legacy', revision: 8,
      hash: createHash('sha256').update(canonicalLegacySnapshot(snapshot)).digest('hex'), snapshot }));
    instance = await setup(directory);
    const initial = await instance.invoke('sync:getState');
    assert.equal(initial.envelope.schema, 2); assert.equal(initial.envelope.snapshot.restaurants[0].id, 'r1');
    assert.deepEqual(initial.envelope.snapshot.reviews, []);
    const headers = { 'x-lunch-code': roomCode, 'x-lunch-schema': '2' };
    const url = `http://127.0.0.1:${port}`;
    const post = async operation => {
      const response = await fetch(url + '/operation', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(operation) });
      return { status: response.status, data: await response.json() };
    };
    const created = await post({ type: 'createReview', review: draft, pin: '0427' });
    assert.equal(created.status, 200); const item = created.data.snapshot.reviews[0];
    assert.equal('reviewCredentials' in created.data, false);
    const disk = JSON.parse(await readFile(path.join(directory, 'shared-state.json'), 'utf8'));
    assert.ok(disk.reviewCredentials[item.id]);
    assert.equal(JSON.stringify(created.data).includes(disk.reviewCredentials[item.id].hash), false);
    const state = await fetch(url + '/state', { headers });
    const tag = state.headers.get('etag'); assert.ok(tag);
    assert.equal((await fetch(url + '/state', { headers: { ...headers, 'if-none-match': tag } })).status, 304);
    assert.equal((await fetch(url + '/state', { headers: { 'x-lunch-code': roomCode } })).status, 426);
    assert.equal((await fetch(url + '/state')).status, 401);
    assert.equal((await post({ type: 'updateReview', id: item.id, expectedVersion: 1, pin: '1111', review: { ...item, rating: 1 } })).status, 409);
    instance.service.close(); instance = null;
    instance = await setup(directory);
    const updated = await post({ type: 'updateReview', id: item.id, expectedVersion: 1, pin: '0427', review: { ...item, rating: 5, avatarId: 'pixel-cat' } });
    assert.equal(updated.status, 200); assert.equal(updated.data.snapshot.reviews[0].rating, 5);
    assert.equal(updated.data.hash, createHash('sha256').update(canonicalSnapshot(updated.data.snapshot)).digest('hex'));
    assert.equal((await post({ type: 'deleteReview', id: item.id, expectedVersion: 1, pin: '0427' })).status, 409);
    const deleted = await post({ type: 'deleteReview', id: item.id, expectedVersion: 2, pin: '0427' });
    assert.equal(deleted.status, 200); assert.deepEqual(deleted.data.snapshot.reviews, []);
  } finally { instance?.service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('개인 모드 리뷰도 재시작 후 비밀번호로 수정할 수 있다', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lunch-review-solo-'));
  let instance;
  try {
    instance = await setup(directory);
    const created = await instance.invoke('sync:mutate', { type: 'createReview', review: draft, pin: '0427' });
    const review = created.reviews[0];
    assert.equal('credentials' in created, false);
    instance.service.close(); instance = null;
    instance = await setup(directory);
    const initial = await instance.invoke('sync:getState'); assert.equal(initial.localReviews.length, 1);
    const updated = await instance.invoke('sync:mutate', { type: 'updateReview', id: review.id, expectedVersion: 1, pin: '0427', review: { ...review, rating: 5 } });
    assert.equal(updated.reviews[0].version, 2);
  } finally { instance?.service.close(); await rm(directory, { recursive: true, force: true }); }
});
