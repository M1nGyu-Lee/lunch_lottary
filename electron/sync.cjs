const http = require('node:http');
const dgram = require('node:dgram');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash, randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { createReviewEditor } = require('./reviews.cjs');

async function createSyncService({ app, BrowserWindow, ipcMain, syncPort, discoveryPort }) {
  const { canonicalSnapshot, canonicalLegacySnapshot, normalizeSharedSnapshot, SYNC_SCHEMA, SYNC_PORT: defaultSyncPort, DISCOVERY_PORT: defaultDiscoveryPort, DISCOVERY_GROUP } =
    await import('../app/sync-protocol.mjs');
  const SYNC_PORT = syncPort || defaultSyncPort;
  const DISCOVERY_PORT = discoveryPort || defaultDiscoveryPort;
  const { cleanRestaurant } = await import('../app/core.mjs');
  const configPath = path.join(app.getPath('userData'), 'sync-config.json');
  const statePath = path.join(app.getPath('userData'), 'shared-state.json');
  const backupPath = `${statePath}.bak`;
  const soloReviewsPath = path.join(app.getPath('userData'), 'reviews-private.json');
  const editReview = createReviewEditor();
  let reviewCredentials = {};
  let soloBook = { reviews: [], credentials: {} };
  let soloReviewError = '';
  try {
    const stored = await readJson(soloReviewsPath);
    const book = { reviews: stored.reviews, credentials: stored.credentials };
    if (stored.hash !== privateHash(book)) throw new Error('개인 리뷰 저장 파일의 해시가 일치하지 않습니다.');
    normalizeSharedSnapshot({ restaurants: [], draws: [], reviews: book.reviews });
    soloBook = book;
  } catch (error) { if (error.code !== 'ENOENT') soloReviewError = error.message; }
  let config = await readJson(configPath).catch(() => null) || { mode: 'solo' };
  let envelope = null;
  let server = null;
  let beacon = null;
  let beaconTimer = null;
  let discovery = null;
  let pollTimer = null;
  let polling = false;
  let connected = false;
  let lastError = '';
  let operationQueue = Promise.resolve();
  let hostStateInvalid = false;
  const foundHosts = new Map();

  function hash(snapshot) {
    return createHash('sha256').update(canonicalSnapshot(snapshot)).digest('hex');
  }

  function privateHash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

  function checkEnvelope(value, roomId = null) {
    if (value?.schema !== SYNC_SCHEMA) throw new Error('호스트와 참여 PC 모두 점심복권 0.3.0 이상으로 업데이트해 주세요.');
    if (!value || value.schema !== SYNC_SCHEMA || typeof value.epoch !== 'string' || !value.epoch ||
        !Number.isSafeInteger(value.revision) || value.revision < 0) {
      throw new Error('공유 데이터 버전이 올바르지 않습니다.');
    }
    if (roomId && value.roomId !== roomId) throw new Error('다른 교육장 공유 데이터입니다.');
    const snapshot = normalizeSharedSnapshot(value.snapshot);
    if (value.hash !== hash(snapshot)) throw new Error('공유 데이터 해시가 일치하지 않습니다. 데이터를 적용하지 않았습니다.');
    return { schema: SYNC_SCHEMA, roomId: value.roomId, epoch: value.epoch,
      revision: value.revision, hash: value.hash, snapshot };
  }

  function status() {
    return {
      mode: config.mode,
      connected,
      roomId: config.roomId || '',
      roomCode: config.mode === 'host' ? config.roomCode : '',
      hostAddress: config.mode === 'host' ? localAddresses().join(', ') : config.hostAddress || '',
      port: SYNC_PORT,
      revision: envelope?.revision ?? 0,
      hash: envelope?.hash || '',
      error: lastError,
      hosts: [...foundHosts.values()].filter(item => Date.now() - item.seenAt < 15_000)
    };
  }

  function emit(channel, value) {
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(channel, value);
  }

  function publishState() { emit('sync:status', status()); }
  function publishSnapshot() { if (envelope) emit('sync:snapshot', envelope); publishState(); }

  async function saveConfig() {
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
  }

  async function loadHostState() {
    const errors = [];
    for (const file of [statePath, backupPath]) {
      try {
        let raw = await readJson(file);
        const migrating = raw.schema === 1;
        if (migrating) {
          if (raw.hash !== createHash('sha256').update(canonicalLegacySnapshot(raw.snapshot)).digest('hex')) throw new Error('이전 공유 데이터 해시가 일치하지 않습니다.');
          raw = { ...raw, schema: SYNC_SCHEMA, snapshot: normalizeSharedSnapshot(raw.snapshot) };
          raw.hash = hash(raw.snapshot);
        }
        const data = checkEnvelope(raw, config.roomId);
        const credentials = raw.reviewCredentials || {};
        if (raw.reviewCredentials && raw.reviewCredentialsHash !== privateHash(credentials)) throw new Error('리뷰 비밀번호 저장 파일 검증에 실패했습니다.');
        reviewCredentials = credentials;
        if (file === backupPath || migrating) {
          if (file === backupPath) await fs.copyFile(backupPath, statePath);
          const recovered = { ...data, epoch: randomUUID(), revision: data.revision + 1 };
          await saveHostState(recovered);
          if (file === backupPath) lastError = '손상된 호스트 파일을 이전 백업에서 복구했습니다.';
          return recovered;
        }
        return data;
      } catch (error) { errors.push(error); }
    }
    if (errors.every(error => error.code === 'ENOENT')) return null;
    throw new Error(`호스트 저장 파일을 검증하지 못했습니다: ${errors.find(error => error.code !== 'ENOENT')?.message || '알 수 없는 오류'}`);
  }

  async function saveHostState(next, credentials = reviewCredentials) {
    const file = `${statePath}.${process.pid}.tmp`;
    await fs.writeFile(file, JSON.stringify({ ...next, reviewCredentials: credentials, reviewCredentialsHash: privateHash(credentials) }), 'utf8');
    try { await fs.copyFile(statePath, backupPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rename(file, statePath);
    envelope = next;
    reviewCredentials = credentials;
    connected = Boolean(server?.listening);
    lastError = '';
    publishSnapshot();
  }

  function validateRestaurant(raw) {
    if (!raw || typeof raw.id !== 'string' || raw.id.length > 100 || !raw.id) throw new Error('음식점 ID가 올바르지 않습니다.');
    return cleanRestaurant(raw);
  }

  function validateDraw(raw) {
    if (!raw || typeof raw.id !== 'string' || !raw.id || raw.id.length > 100 ||
        typeof raw.restaurantId !== 'string' || !raw.restaurantId || raw.restaurantId.length > 100 ||
        !['normal', 'final', 'ultimate'].includes(raw.phase) || !Number.isFinite(Date.parse(raw.drawnAt))) {
      throw new Error('추첨 이력 형식이 올바르지 않습니다.');
    }
    const eatenOn = /^\d{4}-\d{2}-\d{2}$/.test(raw.eatenOn || '') ? raw.eatenOn : null;
    return {
      id: raw.id, restaurantId: raw.restaurantId,
      restaurantName: String(raw.restaurantName || '').slice(0, 80),
      restaurantAddress: String(raw.restaurantAddress || '').slice(0, 180),
      phase: raw.phase, drawnAt: raw.drawnAt, eatenOn
    };
  }

  function samePlace(a, b) {
    return a.name.trim().toLocaleLowerCase() === b.name.trim().toLocaleLowerCase() &&
      a.address.trim().toLocaleLowerCase() === b.address.trim().toLocaleLowerCase();
  }

  async function applyOperation(op) {
    if (!envelope) throw new Error('호스트 데이터가 준비되지 않았습니다.');
    if (!op || typeof op !== 'object') throw new Error('공유 변경 요청이 올바르지 않습니다.');
    const snapshot = structuredClone(envelope.snapshot);
    let credentials = reviewCredentials;
    if (op.type === 'saveRestaurant') {
      const item = validateRestaurant(op.restaurant);
      const old = snapshot.restaurants.find(r => r.id === item.id);
      if ((old?.updatedAt || null) !== (op.expectedUpdatedAt || null)) throw new Error('다른 PC에서 먼저 수정했습니다. 최신 목록을 확인해 주세요.');
      if (snapshot.restaurants.some(r => r.id !== item.id && samePlace(r, item))) throw new Error('같은 이름과 위치의 음식점이 이미 있습니다.');
      snapshot.restaurants = snapshot.restaurants.filter(r => r.id !== item.id);
      snapshot.restaurants.push(item);
    } else if (op.type === 'deleteRestaurant') {
      const old = snapshot.restaurants.find(r => r.id === op.id);
      if (!old || old.updatedAt !== op.expectedUpdatedAt) throw new Error('다른 PC에서 먼저 수정했습니다. 최신 목록을 확인해 주세요.');
      snapshot.restaurants = snapshot.restaurants.filter(r => r.id !== op.id);
      for (const review of snapshot.reviews.filter(r => r.restaurantId === op.id)) {
        credentials = { ...credentials }; delete credentials[review.id];
      }
      snapshot.reviews = snapshot.reviews.filter(r => r.restaurantId !== op.id);
    } else if (op.type === 'saveDraw') {
      const draw = validateDraw(op.draw);
      const old = snapshot.draws.find(d => d.id === draw.id);
      if (old && (old.eatenOn || null) !== (op.expectedEatenOn || null)) throw new Error('다른 PC에서 식사 기록을 수정했습니다.');
      if (!old && !snapshot.restaurants.some(r => r.id === draw.restaurantId)) throw new Error('음식점이 삭제되어 추첨할 수 없습니다.');
      snapshot.draws = snapshot.draws.filter(d => d.id !== draw.id);
      snapshot.draws.push(draw);
    } else if (['createReview', 'updateReview', 'deleteReview'].includes(op.type)) {
      if (op.type === 'createReview' && !snapshot.restaurants.some(r => r.id === op.review?.restaurantId)) throw new Error('음식점이 삭제되어 리뷰를 올릴 수 없습니다.');
      const result = await editReview(op, snapshot.reviews, credentials);
      snapshot.reviews = result.reviews; credentials = result.credentials;
    } else if (op.type === 'mergeRestaurants' || op.type === 'mergeFull') {
      if (!Array.isArray(op.restaurants) || op.restaurants.length > 5000) throw new Error('가져올 음식점 목록이 올바르지 않습니다.');
      for (const raw of op.restaurants) {
        const item = validateRestaurant(raw);
        if (!snapshot.restaurants.some(r => r.id === item.id || samePlace(r, item))) snapshot.restaurants.push(item);
      }
      if (op.type === 'mergeFull') {
        if (!Array.isArray(op.draws) || op.draws.length > 20000) throw new Error('가져올 추첨 이력이 올바르지 않습니다.');
        for (const raw of op.draws) {
          const draw = validateDraw(raw);
          if (!snapshot.draws.some(d => d.id === draw.id)) snapshot.draws.push(draw);
        }
        const { cleanReview } = await import('../app/reviews.mjs');
        if (!Array.isArray(op.reviews || []) || (op.reviews || []).length > 1500) throw new Error('가져올 리뷰 목록이 올바르지 않습니다.');
        for (const raw of op.reviews || []) {
          const review = cleanReview(raw);
          if (snapshot.restaurants.some(r => r.id === review.restaurantId) && !snapshot.reviews.some(r => r.id === review.id)) snapshot.reviews.push(review);
        }
      }
    } else {
      throw new Error('지원하지 않는 공유 변경 요청입니다.');
    }
    const normalized = normalizeSharedSnapshot(snapshot);
    const next = { schema: SYNC_SCHEMA, roomId: config.roomId, epoch: envelope.epoch, revision: envelope.revision + 1,
      hash: hash(normalized), snapshot: normalized };
    await saveHostState(next, credentials);
    return next;
  }

  function enqueueOperation(op) {
    const next = operationQueue.then(() => applyOperation(op));
    operationQueue = next.catch(() => {});
    return next;
  }

  function authorized(req) {
    const candidate = String(req.headers['x-lunch-code'] || '');
    const expected = String(config.roomCode || '');
    const a = Buffer.from(candidate);
    const b = Buffer.from(expected);
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
  }

  async function handleRequest(req, res) {
    if (!authorized(req)) return sendJson(res, 401, { error: '공유 코드가 다릅니다.' });
    if (req.headers['x-lunch-schema'] !== String(SYNC_SCHEMA)) return sendJson(res, 426, { error: '호스트와 참여 PC 모두 점심복권 0.3.0 이상으로 업데이트해 주세요.' });
    if (req.method === 'GET' && req.url === '/state') {
      const tag = `"${envelope.epoch}:${envelope.revision}:${envelope.hash}"`;
      res.setHeader('etag', tag);
      if (req.headers['if-none-match'] === tag) { res.writeHead(304); res.end(); return; }
      return sendJson(res, 200, envelope);
    }
    if (req.method === 'POST' && req.url === '/operation') {
      try {
        const op = await readRequestJson(req);
        const next = await enqueueOperation(op);
        return sendJson(res, 200, next);
      } catch (error) { return sendJson(res, 409, { error: error.message }); }
    }
    return sendJson(res, 404, { error: '요청 경로가 없습니다.' });
  }

  function stopHost() {
    if (beaconTimer) clearInterval(beaconTimer);
    beaconTimer = null;
    if (beacon) beacon.close();
    beacon = null;
    if (server) server.close();
    server = null;
  }

  async function startHostServer() {
    if (server) return;
    server = http.createServer((req, res) => { handleRequest(req, res).catch(error => sendJson(res, 500, { error: error.message })); });
    try { await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(SYNC_PORT, '0.0.0.0', resolve);
    }); } catch (error) {
      server = null;
      connected = false;
      lastError = error.code === 'EADDRINUSE'
        ? '공유 포트를 다른 앱이 사용 중입니다. 이미 실행한 점심복권의 공유 화면을 확인해 주세요.'
        : `공유 서버를 열지 못했습니다: ${error.message}`;
      publishState();
      throw new Error(lastError);
    }
    connected = true;
    try {
      beacon = dgram.createSocket('udp4');
      beacon.on('error', error => { lastError = `자동 검색 알림 실패: ${error.message}`; publishState(); });
      const sendBeacon = () => {
        const message = Buffer.from(JSON.stringify({ kind: 'lunch-lottery-host', schema: SYNC_SCHEMA, roomId: config.roomId, port: SYNC_PORT }));
        beacon.send(message, DISCOVERY_PORT, DISCOVERY_GROUP, () => {});
      };
      sendBeacon();
      beaconTimer = setInterval(sendBeacon, 2500);
    } catch (error) {
      lastError = `자동 검색 알림 실패: ${error.message}`;
      if (beacon) beacon.close();
      beacon = null;
    }
    publishState();
  }

  function startDiscovery() {
    if (discovery) return;
    discovery = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    discovery.on('message', (buffer, info) => {
      try {
        const value = JSON.parse(buffer.toString('utf8'));
        if (value.kind !== 'lunch-lottery-host' || value.schema !== SYNC_SCHEMA || typeof value.roomId !== 'string') return;
        foundHosts.set(value.roomId, { roomId: value.roomId, address: info.address, port: value.port, seenAt: Date.now() });
        if (config.mode === 'client' && config.roomId === value.roomId && config.hostAddress !== info.address) {
          config.hostAddress = info.address;
          saveConfig().catch(() => {});
          pollClient().catch(() => {});
        }
        publishState();
      } catch {}
    });
    discovery.on('error', error => { lastError = `자동 검색 실패: ${error.message}`; publishState(); });
    discovery.bind(DISCOVERY_PORT, () => {
      try { discovery.addMembership(DISCOVERY_GROUP); } catch (error) { lastError = `자동 검색 실패: ${error.message}`; publishState(); }
    });
  }

  async function requestHost(address, code, route, op = null, conditional = false) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`http://${address}:${SYNC_PORT}${route}`, {
        method: op ? 'POST' : 'GET',
        headers: { 'x-lunch-code': code, 'x-lunch-schema': String(SYNC_SCHEMA),
          ...(conditional && envelope ? { 'if-none-match': `"${envelope.epoch}:${envelope.revision}:${envelope.hash}"` } : {}),
          ...(op ? { 'content-type': 'application/json' } : {}) },
        body: op ? JSON.stringify(op) : undefined,
        signal: controller.signal
      });
      if (response.status === 304 && conditional && envelope) return envelope;
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `호스트 응답 오류 (${response.status})`);
      return checkEnvelope(data, config.mode === 'client' ? config.roomId : null);
    } finally { clearTimeout(timer); }
  }

  async function pollClient() {
    if (config.mode !== 'client' || polling || !config.hostAddress) return;
    polling = true;
    try {
      const next = await requestHost(config.hostAddress, config.roomCode, '/state', null, true);
      if (!envelope || next.epoch !== envelope.epoch || next.revision > envelope.revision || next.hash !== envelope.hash) {
        envelope = next;
        publishSnapshot();
      }
      connected = true;
      lastError = '';
      publishState();
    } catch (error) {
      connected = false;
      lastError = `호스트 연결 대기 중: ${error.message}`;
      publishState();
    } finally { polling = false; }
  }

  function startClientLoop() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => { pollClient().catch(() => {}); }, 2500);
    pollClient().catch(() => {});
  }

  async function startHost(initialSnapshot) {
    if (config.mode === 'client') throw new Error('참여 중인 PC는 먼저 공유 연결을 해제해 주세요.');
    if (hostStateInvalid) throw new Error('저장 파일 검증이 실패했습니다. 백업 파일을 확인해 주세요.');
    if (config.mode !== 'host') {
      const snapshot = normalizeSharedSnapshot(initialSnapshot);
      reviewCredentials = Object.fromEntries(Object.entries(soloBook.credentials).filter(([id]) => snapshot.reviews.some(r => r.id === id)));
      config = { mode: 'host', roomId: randomUUID(), roomCode: randomBytes(6).toString('hex').toUpperCase() };
      const next = { schema: SYNC_SCHEMA, roomId: config.roomId, epoch: randomUUID(), revision: 1, hash: hash(snapshot), snapshot };
      await saveHostState(next);
      await saveConfig();
    } else if (!envelope) {
      const snapshot = normalizeSharedSnapshot(initialSnapshot);
      const next = { schema: SYNC_SCHEMA, roomId: config.roomId, epoch: randomUUID(), revision: 1, hash: hash(snapshot), snapshot };
      await saveHostState(next);
    }
    await startHostServer();
    return { status: status(), envelope };
  }

  async function joinHost(input) {
    if (config.mode === 'host') throw new Error('이 PC는 공유 호스트입니다.');
    const address = String(input.address || '').trim();
    const code = String(input.code || '').trim().toUpperCase();
    if (!/^[a-zA-Z0-9.-]{1,253}$/.test(address) || !/^[A-F0-9]{12}$/.test(code)) throw new Error('호스트 주소와 12자리 공유 코드를 확인해 주세요.');
    const next = await requestHost(address, code, '/state');
    config = { mode: 'client', roomId: next.roomId, roomCode: code, hostAddress: address };
    await saveConfig();
    envelope = next;
    connected = true;
    lastError = '';
    startClientLoop();
    publishSnapshot();
    return { status: status(), envelope };
  }

  async function mutate(op) {
    if (config.mode === 'host') return enqueueOperation(op);
    if (config.mode === 'solo') {
      const task = operationQueue.then(async () => {
        if (soloReviewError) throw new Error(soloReviewError);
        let next;
        if (op.type === 'mergeReviews') {
          const { cleanReview } = await import('../app/reviews.mjs');
          if (!Array.isArray(op.reviews) || op.reviews.length > 1500) throw new Error('가져올 리뷰 목록이 올바르지 않습니다.');
          const reviews = [...soloBook.reviews];
          for (const raw of op.reviews) { const item = cleanReview(raw); if (!reviews.some(r => r.id === item.id)) reviews.push(item); }
          normalizeSharedSnapshot({ restaurants: [], draws: [], reviews });
          next = { reviews, credentials: soloBook.credentials };
        } else next = await editReview(op, soloBook.reviews, soloBook.credentials);
        const temporary = `${soloReviewsPath}.${process.pid}.tmp`;
        await fs.writeFile(temporary, JSON.stringify({ ...next, hash: privateHash(next) }), 'utf8');
        await fs.rename(temporary, soloReviewsPath); soloBook = next;
        return { reviews: next.reviews };
      });
      operationQueue = task.catch(() => {}); return task;
    }
    if (config.mode !== 'client') throw new Error('공유 모드가 아닙니다.');
    if (!connected) throw new Error('호스트와 연결되지 않았습니다. 연결 후 다시 시도해 주세요.');
    try {
      const next = await requestHost(config.hostAddress, config.roomCode, '/operation', op);
      envelope = next;
      publishSnapshot();
      return next;
    } catch (error) {
      await pollClient();
      throw error;
    }
  }

  ipcMain.handle('sync:getState', () => ({ status: status(), envelope, localReviews: soloBook.reviews, reviewError: config.mode === 'solo' ? soloReviewError : '' }));
  ipcMain.handle('sync:startHost', (_event, snapshot) => startHost(snapshot));
  ipcMain.handle('sync:joinHost', (_event, input) => joinHost(input));
  ipcMain.handle('sync:mutate', (_event, op) => mutate(op));
  ipcMain.handle('sync:copyInvite', () => {
    if (config.mode !== 'host' || !connected) throw new Error('먼저 이 PC를 호스트로 설정해 주세요.');
    require('electron').clipboard.writeText(`점심복권 0.3.0 교육장 공유\n호스트 주소: ${localAddresses().join(', ')}\n공유 코드: ${config.roomCode}\n앱의 교육장 공유 → 호스트에 참여하기에서 주소 하나와 코드를 입력하세요.`);
    return true;
  });

  startDiscovery();
  if (config.mode === 'host') {
    try {
      envelope = await loadHostState();
    } catch (error) { connected = false; hostStateInvalid = true; lastError = error.message; }
    if (envelope && !hostStateInvalid) {
      try { await startHostServer(); } catch { /* The sharing screen can retry after the port is available. */ }
    } else if (!hostStateInvalid) {
      connected = false;
      lastError = '공유 데이터 파일이 없습니다. 공유 화면에서 다시 시작해 주세요.';
    }
  } else if (config.mode === 'client') {
    startClientLoop();
  }

  return {
    close() {
      if (pollTimer) clearInterval(pollTimer);
      stopHost();
      if (discovery) discovery.close();
    }
  };
}

async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }

function sendJson(res, status, value) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readRequestJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 45_000_000) throw new Error('공유 변경 요청이 너무 큽니다.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function localAddresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
  }
  return addresses;
}

module.exports = { createSyncService };
