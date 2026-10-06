import { DEFAULT_TAGS, cleanRestaurant, eligibleRestaurants, pickRestaurant, canReroll, normalizeSettings, isVerificationStale, recentlyEatenIds } from './core.mjs';
import { db } from './db.mjs';
import { SEED_RESTAURANTS, SEED_VERSION } from './seed.mjs';
import { canonicalSnapshot } from './sync-protocol.mjs';

const $ = id => document.getElementById(id);
const OFFICIAL_URL = 'https://zeropay.or.kr/UI_HP_009_03.act';
const state = { restaurants: [], draws: [], settings: normalizeSettings(), filters: new Set(), formTags: new Set(), editId: null, visitDrawId: null, currentDrawId: null, phase: 'idle', winner: null, rerolls: 0, scratched: 0, pointer: false, lastPoint: null, drawPending: false, syncMode: 'solo', syncConnected: false, syncRoomId: null, syncEpoch: null, syncRevision: -1, syncHash: '' };
let toastTimer;
let syncApplyQueue = Promise.resolve();

function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3200);
}

function create(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function allTags() {
  return [...new Set([...DEFAULT_TAGS, ...state.restaurants.flatMap(r => r.tags), ...state.formTags])];
}

function tagButton(tag, selected, onClick, disabled = false) {
  const button = create('button', `tag-button${selected ? ' selected' : ''}`, tag);
  button.type = 'button';
  button.disabled = disabled;
  button.setAttribute('aria-pressed', String(selected));
  if (disabled) button.title = '현재 추첨 조건에 해당하는 음식점이 없습니다.';
  button.addEventListener('click', onClick);
  return button;
}

function availableDrawTags() {
  return new Set(candidateRestaurants(new Set()).flatMap(r => r.tags));
}

function candidateRestaurants(filters = state.filters) {
  const base = eligibleRestaurants(state.restaurants, filters, state.settings.verifiedOnly);
  if (!state.settings.excludeRecentMeals) return base;
  const eaten = recentlyEatenIds(state.draws, localToday());
  return base.filter(r => !eaten.has(r.id));
}

function renderTags() {
  const available = availableDrawTags();
  for (const tag of [...state.filters]) if (!available.has(tag)) state.filters.delete(tag);
  $('filterTags').replaceChildren(...allTags().map(tag => tagButton(tag, state.filters.has(tag), () => {
    if (state.filters.has(tag)) state.filters.delete(tag); else state.filters.add(tag);
    renderTags(); renderEligible();
  }, !available.has(tag))));
  $('formTags').replaceChildren(...allTags().map(tag => tagButton(tag, state.formTags.has(tag), () => {
    if (state.formTags.has(tag)) state.formTags.delete(tag); else state.formTags.add(tag);
    renderTags();
  })));
}

function renderEligible() {
  const count = candidateRestaurants().length;
  $('eligibleCount').textContent = `대상 ${count}곳`;
  renderPaymentNote();
  if (!count && state.phase === 'idle') {
    const beforeRecentFilter = eligibleRestaurants(state.restaurants, state.filters, state.settings.verifiedOnly).length;
    $('ticketHint').textContent = state.settings.excludeRecentMeals && beforeRecentFilter
      ? '최근 7일 식사 기록을 제외하니 후보가 없어요. 제외 옵션을 꺼보세요.'
      : state.settings.verifiedOnly ? '추첨하려면 제로페이 확인 기록이 있는 음식점을 추가해 주세요.' : '추첨하려면 음식점을 추가해 주세요.';
  }
  else if (state.phase === 'idle') $('ticketHint').textContent = '복권을 받은 뒤 손가락이나 마우스로 긁어보세요.';
  renderActions();
}

function renderPaymentNote() {
  if (!state.settings.verifiedOnly) {
    $('paymentNote').textContent = '제로페이 상태와 관계없이 모든 음식점을 추첨합니다.';
    return;
  }
  const staleCount = state.restaurants.filter(r => isVerificationStale(r)).length;
  $('paymentNote').textContent = staleCount
    ? `제로페이 확인 기록이 있는 매장만 추첨합니다. ${staleCount}곳은 확인한 지 오래돼 재확인이 필요해요.`
    : '제로페이 확인 기록이 있는 매장만 추첨합니다. 결제 가능 여부는 방문 전에 다시 확인해 주세요.';
}

function renderSettings() {
  $('thresholdInput').value = state.settings.revealThreshold;
  $('thresholdValue').textContent = `${state.settings.revealThreshold}%`;
  $('limitValue').textContent = state.settings.rerollLimit;
  $('excludeRecentMeals').checked = state.settings.excludeRecentMeals;
  for (const [id, selected] of [['verifiedMode', state.settings.verifiedOnly], ['allMode', !state.settings.verifiedOnly]]) {
    $(id).classList.toggle('selected', selected); $(id).setAttribute('aria-pressed', String(selected));
  }
  renderPaymentNote();
  renderActions();
}

function renderActions() {
  const active = state.phase !== 'idle';
  const unavailable = state.drawPending || state.syncMode === 'client' && !state.syncConnected;
  $('drawButton').disabled = unavailable || active || candidateRestaurants().length === 0;
  $('rerollButton').disabled = unavailable || !canReroll({ phase: state.phase, scratched: state.scratched, rerolls: state.rerolls, settings: state.settings });
  $('rerollLeft').textContent = `재추첨 ${Math.max(0, state.settings.rerollLimit - state.rerolls)}회 남음`;
  $('finalButton').disabled = unavailable || !active || state.phase !== 'normal';
  $('ultimateButton').disabled = unavailable;
  $('ultimateButton').hidden = state.phase !== 'final';
  $('ateCurrentButton').hidden = !state.currentDrawId || state.scratched < 65 || Boolean(state.draws.find(d => d.id === state.currentDrawId)?.eatenOn);
  $('newSessionButton').hidden = !active || state.scratched < 65;
  $('drawButton').textContent = '✦ 복권 받기';
  if (state.phase === 'ultimate') $('finaleCaption').textContent = '찐찐막 결과가 확정됐어요. 다음 점심에 또 만나요!';
  else if (state.phase === 'final') $('finaleCaption').textContent = '붉은 찐막! 찐찐막을 누르면 마지막 한 번 더 뽑습니다.';
  else $('finaleCaption').textContent = '찐막을 누르면 일반 재추첨은 즉시 종료됩니다.';
}

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '날짜 정보 없음' : new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' }).format(d);
}

async function verifyEnvelope(envelope) {
  if (!envelope?.snapshot || typeof envelope.hash !== 'string') throw new Error('공유 데이터가 비어 있습니다.');
  const data = new TextEncoder().encode(canonicalSnapshot(envelope.snapshot));
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== envelope.hash) throw new Error('공유 데이터 해시가 일치하지 않아 적용하지 않았습니다.');
}

async function applySharedEnvelope(envelope) {
  await verifyEnvelope(envelope);
  if (state.syncRoomId === envelope.roomId && state.syncEpoch === envelope.epoch) {
    if (envelope.revision < state.syncRevision) return;
    if (envelope.revision === state.syncRevision) {
      if (envelope.hash !== state.syncHash) throw new Error('같은 공유 버전의 해시가 달라 적용하지 않았습니다.');
      return;
    }
  }
  await db.replaceShared(envelope.snapshot);
  state.restaurants = await db.restaurants();
  state.draws = await db.draws();
  state.syncRoomId = envelope.roomId;
  state.syncEpoch = envelope.epoch;
  state.syncRevision = envelope.revision;
  state.syncHash = envelope.hash;
  $('syncRevision').textContent = String(envelope.revision);
  $('syncHash').textContent = envelope.hash.slice(0, 16) + '…';
  renderTags(); renderRestaurants(); renderEligible(); renderHistory();
}

function queueSharedEnvelope(envelope) {
  const task = syncApplyQueue.then(() => applySharedEnvelope(envelope));
  syncApplyQueue = task.catch(error => { $('shareError').textContent = error.message; toast(error.message); });
  return task;
}

function renderSyncStatus(status) {
  const changed = state.syncMode !== status.mode || state.syncConnected !== status.connected;
  state.syncMode = status.mode;
  state.syncConnected = status.connected;
  const title = status.mode === 'host' ? status.connected ? '공유 호스트' : '호스트 준비 필요' : status.mode === 'client'
    ? status.connected ? '호스트와 연결됨' : '호스트 연결 대기 중' : '개인 모드';
  $('syncBadge').textContent = title;
  $('syncStatusTitle').textContent = title;
  $('syncStatusText').textContent = status.mode === 'host'
    ? status.connected ? '이 PC가 교육장 공유 데이터를 보관하고 있습니다.' : '호스트 저장 파일이나 포트 상태를 확인해 주세요.'
    : status.mode === 'client'
      ? status.connected ? '호스트 변경 사항을 자동으로 확인하고 최신화합니다.' : '저장된 목록은 볼 수 있지만 공유 데이터 수정은 잠시 사용할 수 없습니다.'
      : '이 PC의 데이터만 사용하고 있습니다. 교육장 공유를 시작하거나 참여할 수 있습니다.';
  if (status.error) $('shareError').textContent = status.error;
  else if (status.connected) $('shareError').textContent = '';
  $('hostPanel').hidden = status.mode === 'client';
  $('joinPanel').hidden = status.mode === 'host';
  $('startHostButton').disabled = status.mode === 'host' && status.connected;
  $('hostDetails').hidden = status.mode !== 'host';
  $('hostAddress').textContent = status.hostAddress || '네트워크 주소를 찾지 못했습니다.';
  $('hostCode').textContent = status.roomCode || '—';
  $('syncRevision').textContent = status.revision ? String(status.revision) : '—';
  $('syncHash').textContent = status.hash ? status.hash.slice(0, 16) + '…' : '—';
  const picker = $('discoveredHosts');
  const previous = picker.value;
  picker.replaceChildren(new Option('직접 주소 입력', ''));
  for (const host of status.hosts || []) picker.add(new Option(`${host.address} · ${host.roomId.slice(0, 8)}`, host.address));
  picker.value = previous;
  if (changed) {
    $('addRestaurantButton').disabled = status.mode === 'client' && !status.connected;
    $('importButton').disabled = status.mode === 'client' && !status.connected;
    $('fullImportButton').disabled = status.mode === 'client' && !status.connected;
    renderRestaurants(); renderHistory(); renderActions();
  }
}

async function mutateShared(operation, localWrite) {
  if (!window.lunchSync || state.syncMode === 'solo') {
    await localWrite();
    return;
  }
  if (state.syncMode === 'client' && !state.syncConnected) throw new Error('호스트 연결을 기다리는 중입니다.');
  const envelope = await window.lunchSync.mutate(operation);
  await queueSharedEnvelope(envelope);
}

async function initSync() {
  if (!window.lunchSync) return;
  window.lunchSync.onStatus(renderSyncStatus);
  window.lunchSync.onSnapshot(envelope => { queueSharedEnvelope(envelope).catch(() => {}); });
  const initial = await window.lunchSync.getState();
  renderSyncStatus(initial.status);
  if (initial.envelope) await queueSharedEnvelope(initial.envelope);
}

function renderHistory() {
  $('historySideCount').textContent = state.draws.length;
  $('drawCount').textContent = state.draws.length;
  $('ateCount').textContent = state.draws.filter(d => d.eatenOn).length;
  const filter = $('historyFilter').value;
  const shown = state.draws.filter(d => filter !== 'eaten' || d.eatenOn).sort((a, b) => String(b.drawnAt).localeCompare(String(a.drawnAt)));
  const list = $('historyList'); list.replaceChildren();
  if (!shown.length) {
    const empty = create('div', 'empty-state');
    empty.append(create('span', 'empty-icon', '◷'), create('strong', '', state.draws.length ? '아직 실제 식사 기록이 없어요' : '아직 추첨 이력이 없어요'), create('p', '', state.draws.length ? '추첨 결과에서 “여기서 먹었어요”를 눌러 날짜를 남겨 주세요.' : '첫 복권을 뽑으면 여기에 결과가 쌓입니다.'));
    list.append(empty); return;
  }
  for (const d of shown) {
    const r = state.restaurants.find(item => item.id === d.restaurantId);
    const card = create('article', 'history-card');
    const icon = create('span', 'history-icon', d.eatenOn ? '✓' : '◈');
    const details = create('div', 'history-details');
    details.append(create('strong', '', d.restaurantName || r?.name || '삭제된 음식점'));
    details.append(create('p', '', `${formatDate(d.drawnAt)} 추첨 · ${d.restaurantAddress || r?.address || '위치 정보 없음'}`));
    const phase = create('span', `phase-badge ${d.phase || 'normal'}`, d.phase === 'ultimate' ? '찐찐막' : d.phase === 'final' ? '찐막' : '일반');
    details.append(phase);
    const right = create('div', 'history-right');
    if (d.eatenOn) right.append(create('span', 'eaten-date', `✓ ${d.eatenOn} 식사`));
    const btn = create('button', 'history-action', d.eatenOn ? '날짜 수정' : '여기서 먹었어요');
    btn.onclick = () => openVisit(d);
    btn.disabled = state.syncMode === 'client' && !state.syncConnected;
    right.append(btn); card.append(icon, details, right); list.append(card);
  }
}

function openVisit(draw) {
  state.visitDrawId = draw.id;
  $('visitRestaurantName').textContent = draw.restaurantName || state.restaurants.find(r => r.id === draw.restaurantId)?.name || '삭제된 음식점';
  $('visitDate').value = draw.eatenOn || localToday();
  $('visitDate').max = localToday();
  $('visitError').textContent = '';
  $('visitDialog').showModal();
}

async function saveVisit(event) {
  event.preventDefault();
  const day = $('visitDate').value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > localToday()) { $('visitError').textContent = '오늘 또는 이전 날짜를 선택해 주세요.'; return; }
  const draw = state.draws.find(d => d.id === state.visitDrawId);
  if (!draw) { $('visitError').textContent = '추첨 기록을 찾지 못했습니다.'; return; }
  try {
    const updated = { ...draw, eatenOn: day };
    await mutateShared({ type: 'saveDraw', draw: updated, expectedEatenOn: draw.eatenOn }, () => db.saveDraw(updated));
    state.draws = state.draws.map(d => d.id === updated.id ? updated : d);
    $('visitDialog').close(); renderHistory(); renderTags(); renderEligible(); toast(`${day} 식사 기록을 저장했어요.`);
  } catch (error) { $('visitError').textContent = error.message || '식사 기록을 저장하지 못했습니다.'; }
}

function statusLabel(status) { return status === 'verified' ? '✓ 제로페이 확인' : status === 'unverified' ? '가맹점 아님' : '? 확인 필요'; }

function renderRestaurants() {
  const all = state.restaurants;
  $('sideCount').textContent = all.length;
  $('totalCount').textContent = all.length;
  $('verifiedCount').textContent = all.filter(r => r.zeroPay === 'verified').length;
  $('pendingCount').textContent = all.filter(r => r.zeroPay === 'unknown').length;
  const query = $('searchInput').value.trim().toLocaleLowerCase();
  const status = $('statusFilter').value;
  const shown = all.filter(r => (status === 'all' || r.zeroPay === status) &&
    (!query || [r.name, r.address, ...r.tags].join(' ').toLocaleLowerCase().includes(query)));
  const list = $('restaurantList'); list.replaceChildren();
  if (!shown.length) {
    const empty = create('div', 'empty-state');
    empty.append(create('span', 'empty-icon', '✳'), create('strong', '', all.length ? '검색 결과가 없어요' : '아직 등록된 음식점이 없어요'), create('p', '', all.length ? '검색어나 상태를 바꿔 보세요.' : '첫 음식점을 추가해 점심 후보를 만들어 보세요.'));
    if (!all.length) { const btn = create('button', 'button button-primary compact', '+ 음식점 추가'); btn.onclick = () => openForm(); empty.append(btn); }
    list.append(empty); return;
  }
  for (const r of shown.sort((a, b) => a.name.localeCompare(b.name, 'ko'))) {
    const card = create('article', 'restaurant-card');
    const avatar = create('div', 'restaurant-avatar', '✦');
    const detail = create('div', 'restaurant-details');
    detail.append(create('strong', '', r.name), create('p', '', r.address));
    const tags = create('div', 'mini-tags');
    for (const t of r.tags) tags.append(create('span', '', t));
    detail.append(tags);
    const stale = isVerificationStale(r);
    if (r.zeroPay === 'verified') {
      const checked = Number.isFinite(Date.parse(r.verifiedAt)) ? formatDate(r.verifiedAt) : '날짜 정보 없음';
      detail.append(create('small', `verification-date${stale ? ' stale' : ''}`,
        `마지막 직접 확인 ${checked}${stale ? ' · 재확인 권장' : ''}`));
    }
    const badge = create('span', `verification ${r.zeroPay}${stale ? ' stale' : ''}`,
      stale ? '↻ 재확인 권장' : statusLabel(r.zeroPay));
    const actions = create('div', 'card-actions');
    const edit = create('button', '', '수정'); edit.title = `${r.name} 수정`; edit.onclick = () => openForm(r);
    const remove = create('button', '', '삭제'); remove.title = `${r.name} 삭제`; remove.onclick = () => deleteRestaurant(r);
    edit.disabled = remove.disabled = state.syncMode === 'client' && !state.syncConnected;
    actions.append(edit, remove); card.append(avatar, detail, badge, actions); list.append(card);
  }
}

function switchTab(tab) {
  $('lotteryTab').hidden = tab !== 'lottery';
  $('restaurantsTab').hidden = tab !== 'restaurants';
  $('historyTab').hidden = tab !== 'history';
  $('shareTab').hidden = tab !== 'share';
  $('fireOverlay').classList.toggle('active', tab === 'lottery' && ['final', 'ultimate'].includes(state.phase));
  document.querySelectorAll('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
}

function openForm(r = null) {
  state.editId = r?.id || null;
  state.formTags = new Set(r?.tags || []);
  $('dialogTitle').textContent = r ? '음식점 수정' : '음식점 추가';
  $('restaurantName').value = r?.name || '';
  $('restaurantAddress').value = r?.address || '';
  $('formError').textContent = '';
  $('customTagInput').value = '';
  document.querySelector(`input[name="zeroPay"][value="${r?.zeroPay || 'unknown'}"]`).checked = true;
  $('verificationConfirm').checked = false;
  renderVerificationConfirm();
  renderTags(); $('restaurantDialog').showModal(); $('restaurantName').focus();
}

function renderVerificationConfirm() {
  const selected = document.querySelector('input[name="zeroPay"]:checked').value;
  $('verificationCheckRow').hidden = selected !== 'verified';
  $('verificationCheckText').textContent = state.editId && state.restaurants.find(r => r.id === state.editId)?.zeroPay === 'verified'
    ? '공식 검색에서 매장명과 주소를 다시 확인했어요. 체크하면 확인 날짜가 갱신됩니다.'
    : '공식 검색에서 매장명과 주소가 일치하는 것을 확인했어요.';
}

async function saveRestaurant(event) {
  event.preventDefault();
  try {
    const old = state.restaurants.find(r => r.id === state.editId);
    const status = document.querySelector('input[name="zeroPay"]:checked').value;
    const identityChanged = old && (old.name !== $('restaurantName').value.trim() || old.address !== $('restaurantAddress').value.trim());
    const newlyVerified = status === 'verified' && (!old || old.zeroPay !== 'verified' || identityChanged);
    const checkedNow = status === 'verified' && $('verificationConfirm').checked;
    if (newlyVerified && !checkedNow) throw new Error('공식 검색에서 매장명과 주소를 확인한 뒤 체크해 주세요.');
    const item = cleanRestaurant({ ...old, name: $('restaurantName').value, address: $('restaurantAddress').value, tags: [...state.formTags], zeroPay: status,
      verifiedAt: checkedNow ? new Date().toISOString() : old?.zeroPay === 'verified' ? old.verifiedAt : null });
    const duplicate = state.restaurants.find(r => r.id !== item.id && r.name.toLocaleLowerCase() === item.name.toLocaleLowerCase() && r.address.toLocaleLowerCase() === item.address.toLocaleLowerCase());
    if (duplicate) throw new Error('같은 이름과 위치의 음식점이 이미 있습니다.');
    await mutateShared({ type: 'saveRestaurant', restaurant: item, expectedUpdatedAt: old?.updatedAt || null }, () => db.saveRestaurant(item));
    state.restaurants = await db.restaurants();
    $('restaurantDialog').close(); renderTags(); renderRestaurants(); renderEligible(); toast(old ? '음식점을 수정했어요.' : '음식점을 추가했어요.');
  } catch (error) { $('formError').textContent = error.message || '저장하지 못했습니다.'; }
}

async function deleteRestaurant(r) {
  if (!confirm(`“${r.name}”을 보관함에서 삭제할까요?`)) return;
  try {
    await mutateShared({ type: 'deleteRestaurant', id: r.id, expectedUpdatedAt: r.updatedAt }, () => db.deleteRestaurant(r.id));
    state.restaurants = await db.restaurants();
    renderTags(); renderRestaurants(); renderEligible(); toast('음식점을 삭제했어요.');
  } catch (error) { toast(error.message || '음식점을 삭제하지 못했습니다.'); }
}

function addCustomTag() {
  const value = $('customTagInput').value.trim().slice(0, 20);
  if (!value) return;
  state.formTags.add(value); $('customTagInput').value = ''; renderTags();
}

async function persistSettings() { await db.saveSettings(state.settings); renderSettings(); }

async function resetTicket(phase, previousId = null) {
  if (state.drawPending) return false;
  const candidates = candidateRestaurants();
  const picked = pickRestaurant(candidates, previousId);
  if (!picked) { toast('현재 추첨 조건에 맞는 음식점이 없어요. 조건을 바꿔 주세요.'); return false; }
  const draw = { id: crypto.randomUUID(), restaurantId: picked.id, restaurantName: picked.name, restaurantAddress: picked.address, phase, drawnAt: new Date().toISOString(), eatenOn: null };
  state.drawPending = true;
  renderActions();
  try {
    await mutateShared({ type: 'saveDraw', draw }, () => db.saveDraw(draw));
  } catch (error) {
    toast(error.message || '추첨 이력을 저장하지 못했습니다.');
    return false;
  } finally {
    state.drawPending = false;
    renderActions();
  }
  state.winner = picked; state.phase = phase; state.scratched = 0; state.lastPoint = null;
  state.currentDrawId = draw.id;
  if (!state.draws.some(item => item.id === draw.id)) state.draws.push(draw);
  $('winnerName').textContent = picked.name;
  $('winnerMeta').textContent = `${picked.address} · ${picked.tags.slice(0, 2).join(' / ')}`;
  $('ticketPlaceholder').hidden = true;
  $('scratchPercent').textContent = '0%'; $('progressFill').style.width = '0%';
  $('ticketHint').textContent = '복권을 살짝 긁으면 재추첨 버튼이 열려요.';
  document.body.classList.remove('quake');
  const overlay = $('fireOverlay');
  overlay.classList.toggle('active', phase !== 'normal');
  overlay.classList.toggle('blue', phase === 'ultimate');
  paintScratch(); renderActions(); renderHistory();
  return true;
}

function paintScratch() {
  const canvas = $('scratchCanvas');
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(rect.width * ratio); canvas.height = Math.round(rect.height * ratio);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const grad = ctx.createLinearGradient(0, 0, rect.width, rect.height);
  grad.addColorStop(0, '#c8b5c3'); grad.addColorStop(.5, '#e7d9df'); grad.addColorStop(1, '#b8a7ba');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, rect.width, rect.height);
  ctx.fillStyle = '#9c8498'; ctx.textAlign = 'center';
  ctx.font = '900 15px system-ui'; ctx.fillText('✦  긁어서 확인하세요  ✦', rect.width / 2, rect.height / 2 - 3);
  ctx.font = '11px system-ui'; ctx.fillText('SCRATCH TO REVEAL', rect.width / 2, rect.height / 2 + 22);
}

function scratchPoint(event) {
  const canvas = $('scratchCanvas'); const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function scratch(event) {
  if (!state.pointer || state.phase === 'idle' || state.scratched >= 65) return;
  const canvas = $('scratchCanvas');
  const ratio = canvas.width / canvas.getBoundingClientRect().width;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const point = scratchPoint(event);
  ctx.save(); ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.globalCompositeOperation = 'destination-out';
  ctx.lineWidth = 24; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(state.lastPoint?.x ?? point.x, state.lastPoint?.y ?? point.y); ctx.lineTo(point.x, point.y); ctx.stroke();
  ctx.beginPath(); ctx.arc(point.x, point.y, 12, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  state.lastPoint = point;
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let transparent = 0, total = 0;
  for (let i = 3; i < pixels.length; i += 64) { total++; if (pixels[i] < 64) transparent++; }
  state.scratched = Math.round(transparent / total * 100);
  $('scratchPercent').textContent = `${state.scratched}%`;
  $('progressFill').style.width = `${state.scratched}%`;
  if (state.phase === 'ultimate') {
    document.body.classList.add('quake');
    document.body.style.setProperty('--quake-size', `${Math.min(10, 2 + state.scratched / 8)}px`);
    document.body.style.setProperty('--quake-speed', `${Math.max(0.055, .16 - state.scratched / 700)}s`);
  }
  if (state.scratched >= 65) { canvas.style.opacity = '0'; $('ticketHint').textContent = '오늘의 점심이 공개됐어요!'; }
  else if (state.phase === 'normal' && state.scratched > state.settings.revealThreshold) $('ticketHint').textContent = '재추첨 가능한 노출률을 넘었어요. 결과를 확인해 보세요!';
  else if (state.phase === 'normal' && state.scratched >= state.settings.minScratch) $('ticketHint').textContent = '지금은 재추첨할 수 있어요. 계속 긁어도 좋아요!';
  renderActions();
}

async function beginDraw() {
  $('scratchCanvas').style.opacity = '1';
  state.rerolls = 0; await resetTicket('normal');
}

function newSession() {
  if (!confirm('새 점심 추첨을 시작할까요? 현재 결과는 이력에 남습니다.')) return;
  state.phase = 'idle'; state.winner = null; state.currentDrawId = null; state.rerolls = 0; state.scratched = 0;
  $('ticketPlaceholder').hidden = false;
  $('scratchCanvas').style.opacity = '1';
  $('scratchPercent').textContent = '0%'; $('progressFill').style.width = '0%';
  $('fireOverlay').classList.remove('active', 'blue');
  $('ticketHint').textContent = '복권을 받은 뒤 손가락이나 마우스로 긁어보세요.';
  renderEligible();
}

async function reroll() {
  if (!canReroll({ phase: state.phase, scratched: state.scratched, rerolls: state.rerolls, settings: state.settings })) return;
  $('scratchCanvas').style.opacity = '1';
  if (await resetTicket('normal', state.winner?.id)) {
    state.rerolls++;
    renderActions();
    toast('새로운 복권을 받았어요!');
  }
}

async function finale(phase) {
  if (phase === 'final' && state.phase !== 'normal') return;
  if (phase === 'ultimate' && state.phase !== 'final') return;
  $('scratchCanvas').style.opacity = '1';
  if (await resetTicket(phase, state.winner?.id))
    toast(phase === 'final' ? '🔥 찐막 추첨! 복권을 긁어 보세요.' : '🧊 찐찐막! 진짜 마지막 복권입니다.');
}

function downloadJson(payload, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  const a = create('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportRestaurants() {
  const payload = { format: 'lunch-lottery-restaurants', version: 1, exportedAt: new Date().toISOString(), restaurants: state.restaurants };
  downloadJson(payload, `점심복권-음식점-${new Date().toISOString().slice(0, 10)}.json`);
  toast(`음식점 ${state.restaurants.length}개만 내보냈어요. 추첨·식사 이력은 포함되지 않습니다.`);
}

function exportFullBackup() {
  const payload = { format: 'lunch-lottery-backup', version: 3, exportedAt: new Date().toISOString(), restaurants: state.restaurants, draws: state.draws, settings: state.settings };
  downloadJson(payload, `점심복권-전체백업-${new Date().toISOString().slice(0, 10)}.json`);
  toast('음식점, 추첨·식사 이력, 설정을 전체 백업했어요.');
}

async function importRestaurants(file) {
  if (!file) return;
  try {
    if (file.size > 5_000_000) throw new Error('5MB 이하의 JSON 파일을 선택해 주세요.');
    const data = JSON.parse(await file.text());
    const validRestaurantFile = data.format === 'lunch-lottery-restaurants' && data.version === 1;
    const legacyBackup = data.format === 'lunch-lottery-backup' && [1, 2, 3].includes(data.version);
    if ((!validRestaurantFile && !legacyBackup) || !Array.isArray(data.restaurants)) throw new Error('점심복권 음식점 파일이 아닙니다.');
    const before = state.restaurants.length;
    const restaurants = data.restaurants.slice(0, 5000).map(raw => cleanRestaurant({ ...raw, id: typeof raw.id === 'string' ? raw.id : undefined }));
    await mutateShared({ type: 'mergeRestaurants', restaurants }, async () => {
      for (const item of restaurants) {
        const exists = state.restaurants.some(r => r.id === item.id || (r.name === item.name && r.address === item.address));
        if (!exists) { await db.saveRestaurant(item); state.restaurants.push(item); }
      }
    });
    state.restaurants = await db.restaurants(); renderTags(); renderRestaurants(); renderEligible();
    toast(`음식점 ${state.restaurants.length - before}개를 가져왔어요. 추첨·식사 이력은 가져오지 않았습니다.`);
  } catch (error) { toast(error.message || '음식점 파일을 읽지 못했습니다.'); }
  $('importFile').value = '';
}

async function importFullBackup(file) {
  if (!file) return;
  try {
    if (file.size > 5_000_000) throw new Error('5MB 이하의 백업 파일을 선택해 주세요.');
    const data = JSON.parse(await file.text());
    if (data.format !== 'lunch-lottery-backup' || ![1, 2, 3].includes(data.version) || !Array.isArray(data.restaurants)) throw new Error('점심복권 전체 백업 파일이 아닙니다.');
    const beforeRestaurants = state.restaurants.length;
    const beforeDraws = state.draws.length;
    const restaurants = data.restaurants.slice(0, 5000).map(raw => cleanRestaurant({ ...raw, id: typeof raw.id === 'string' ? raw.id : undefined }));
    const draws = (Array.isArray(data.draws) ? data.draws : []).slice(0, 20000)
      .filter(raw => typeof raw?.id === 'string' && typeof raw.restaurantId === 'string' && ['normal', 'final', 'ultimate'].includes(raw.phase) && !Number.isNaN(Date.parse(raw.drawnAt)))
      .map(raw => ({ id: raw.id, restaurantId: raw.restaurantId, restaurantName: String(raw.restaurantName || '').slice(0, 80), restaurantAddress: String(raw.restaurantAddress || '').slice(0, 180), phase: raw.phase, drawnAt: raw.drawnAt, eatenOn: /^\d{4}-\d{2}-\d{2}$/.test(raw.eatenOn || '') ? raw.eatenOn : null }));
    await mutateShared({ type: 'mergeFull', restaurants, draws }, async () => {
      for (const item of restaurants) {
        if (!state.restaurants.some(r => r.id === item.id || (r.name === item.name && r.address === item.address))) {
          await db.saveRestaurant(item); state.restaurants.push(item);
        }
      }
      for (const draw of draws) {
        if (!state.draws.some(d => d.id === draw.id)) { await db.saveDraw(draw); state.draws.push(draw); }
      }
    });
    if (data.version >= 3 && data.settings && typeof data.settings === 'object') {
      state.settings = normalizeSettings(data.settings); await db.saveSettings(state.settings);
    }
    state.restaurants = await db.restaurants(); state.draws = await db.draws();
    renderSettings(); renderTags(); renderRestaurants(); renderEligible(); renderHistory();
    toast(`전체 백업에서 음식점 ${state.restaurants.length - beforeRestaurants}개, 추첨 이력 ${state.draws.length - beforeDraws}개를 가져왔어요.`);
  } catch (error) { toast(error.message || '전체 백업 파일을 읽지 못했습니다.'); }
  $('fullImportFile').value = '';
}

function attachEvents() {
  document.querySelectorAll('.nav-item').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
  $('discoveredHosts').onchange = event => { if (event.target.value) $('joinAddress').value = event.target.value; };
  $('startHostButton').onclick = async () => {
    if (!window.lunchSync) { $('shareError').textContent = '교육장 공유는 데스크톱 앱에서 사용할 수 있습니다.'; return; }
    $('startHostButton').disabled = true;
    try {
      const result = await window.lunchSync.startHost({ restaurants: state.restaurants, draws: state.draws });
      renderSyncStatus(result.status);
      await queueSharedEnvelope(result.envelope);
      toast('이 PC가 교육장 공유 호스트가 됐어요.');
    } catch (error) { $('shareError').textContent = error.message; $('startHostButton').disabled = false; }
  };
  $('joinHostButton').onclick = async () => {
    if (!window.lunchSync) { $('shareError').textContent = '교육장 공유는 데스크톱 앱에서 사용할 수 있습니다.'; return; }
    $('joinHostButton').disabled = true;
    try {
      if (!$('joinAddress').value.trim() || !$('joinCode').value.trim()) throw new Error('호스트 주소와 공유 코드를 입력해 주세요.');
      exportFullBackup();
      const result = await window.lunchSync.joinHost({ address: $('joinAddress').value, code: $('joinCode').value });
      renderSyncStatus(result.status);
      await queueSharedEnvelope(result.envelope);
      toast('호스트와 연결됐어요. 이후에는 자동으로 최신화합니다.');
    } catch (error) { $('shareError').textContent = error.message; }
    finally { $('joinHostButton').disabled = false; }
  };
  $('addRestaurantButton').onclick = () => openForm();
  $('closeDialog').onclick = () => $('restaurantDialog').close();
  $('cancelDialog').onclick = () => $('restaurantDialog').close();
  $('restaurantForm').addEventListener('submit', saveRestaurant);
  document.querySelectorAll('input[name="zeroPay"]').forEach(input => input.addEventListener('change', renderVerificationConfirm));
  $('visitForm').addEventListener('submit', saveVisit);
  $('closeVisitDialog').onclick = () => $('visitDialog').close();
  $('cancelVisitDialog').onclick = () => $('visitDialog').close();
  $('ateCurrentButton').onclick = () => { const draw = state.draws.find(d => d.id === state.currentDrawId); if (draw) openVisit(draw); };
  $('historyFilter').onchange = renderHistory;
  $('addTagButton').onclick = addCustomTag;
  $('customTagInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addCustomTag(); } });
  $('searchInput').oninput = renderRestaurants;
  $('statusFilter').onchange = renderRestaurants;
  $('exportButton').onclick = exportRestaurants;
  $('importButton').onclick = () => $('importFile').click();
  $('importFile').onchange = e => importRestaurants(e.target.files[0]);
  $('fullExportButton').onclick = exportFullBackup;
  $('fullImportButton').onclick = () => $('fullImportFile').click();
  $('fullImportFile').onchange = e => importFullBackup(e.target.files[0]);
  $('thresholdInput').oninput = e => { state.settings.revealThreshold = Number(e.target.value); persistSettings(); };
  $('limitMinus').onclick = () => { state.settings.rerollLimit = Math.max(0, state.settings.rerollLimit - 1); persistSettings(); };
  $('limitPlus').onclick = () => { state.settings.rerollLimit = Math.min(10, state.settings.rerollLimit + 1); persistSettings(); };
  $('verifiedMode').onclick = () => { state.settings.verifiedOnly = true; persistSettings(); renderTags(); renderEligible(); };
  $('allMode').onclick = () => { state.settings.verifiedOnly = false; persistSettings(); renderTags(); renderEligible(); };
  $('excludeRecentMeals').onchange = event => { state.settings.excludeRecentMeals = event.target.checked; persistSettings(); renderTags(); renderEligible(); };
  $('drawButton').onclick = beginDraw;
  $('newSessionButton').onclick = newSession;
  $('rerollButton').onclick = reroll;
  $('finalButton').onclick = () => finale('final');
  $('ultimateButton').onclick = () => finale('ultimate');
  const canvas = $('scratchCanvas');
  canvas.addEventListener('pointerdown', e => { if (state.phase === 'idle') return; state.pointer = true; state.lastPoint = null; canvas.setPointerCapture(e.pointerId); scratch(e); });
  canvas.addEventListener('pointermove', scratch);
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(name, () => { state.pointer = false; state.lastPoint = null; document.body.classList.remove('quake'); });
  window.addEventListener('resize', () => { if (state.phase !== 'idle' && state.scratched === 0) paintScratch(); });
  document.querySelector('.official-link').addEventListener('click', async () => {
    const name = $('restaurantName').value.trim();
    if (name && navigator.clipboard?.writeText) { try { await navigator.clipboard.writeText(name); toast('음식점 이름을 복사했어요. 공식 사이트에서 지역 선택 후 붙여넣으세요.'); } catch { /* browser may deny clipboard */ } }
  });
}


async function seedDefaultRestaurants() {
  const seededVersion = Number(await db.meta('seedVersion') || 0);
  if (seededVersion >= SEED_VERSION) return;
  const existing = await db.restaurants();
  if (existing.length === 0) {
    for (const raw of SEED_RESTAURANTS) {
      await db.saveRestaurant({ ...raw });
    }
  }
  await db.saveMeta('seedVersion', SEED_VERSION);
}

async function init() {
  const date = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  $('todayDate').textContent = date; $('libraryDate').textContent = date; $('historyDate').textContent = date; $('shareDate').textContent = date;
  attachEvents();
  try { await seedDefaultRestaurants(); state.restaurants = await db.restaurants(); state.draws = await db.draws(); state.settings = normalizeSettings(await db.settings()); }
  catch (error) { toast('저장소를 열지 못했습니다. 앱을 다시 실행해 주세요.'); console.error(error); }
  renderTags(); renderRestaurants(); renderSettings(); renderEligible(); renderHistory();
  try { await initSync(); } catch (error) { $('shareError').textContent = error.message; }
}

init();
