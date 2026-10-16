import { DEFAULT_TAGS, cleanRestaurant, eligibleRestaurants, pickRestaurant, canReroll, normalizeSettings, isVerificationStale, recentlyEatenIds } from './core.mjs';
import { db } from './db.mjs';
import { SEED_RESTAURANTS, SEED_VERSION } from './seed.mjs';
import { canonicalSnapshot } from './sync-protocol.mjs';
import { cleanReview, reviewSummary, MAX_REVIEW_PHOTOS, MAX_PHOTO_LENGTH } from './reviews.mjs';
import { AVATARS, AVATAR_STYLES, avatarById, avatarSource } from './avatars.mjs';

const $ = id => document.getElementById(id);
const OFFICIAL_URL = 'https://zeropay.or.kr/UI_HP_009_03.act';
const state = { restaurants: [], draws: [], settings: normalizeSettings(), filters: new Set(), formTags: new Set(), editId: null, visitDrawId: null, currentDrawId: null, phase: 'idle', winner: null, rerolls: 0, scratched: 0, pointer: false, lastPoint: null, drawPending: false, syncMode: 'solo', syncConnected: false, syncRoomId: null, syncEpoch: null, syncRevision: -1, syncHash: '' };
Object.assign(state, { reviews: [], reviewRestaurantId: null, reviewEditId: null, reviewEditVersion: null,
  reviewRating: 0, reviewPhotos: [], reviewPending: false, reviewPhotoBusy: false, reviewFormToken: 0, reviewError: '' });
Object.assign(state, { reviewAvatarId: 'capybara', reviewAvatarStyle: 'illustration', reviewReturnToBoard: false });
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
  state.reviews = await db.reviews();
  state.syncRoomId = envelope.roomId;
  state.syncEpoch = envelope.epoch;
  state.syncRevision = envelope.revision;
  state.syncHash = envelope.hash;
  $('syncRevision').textContent = String(envelope.revision);
  $('syncHash').textContent = envelope.hash.slice(0, 16) + '…';
  renderTags(); renderRestaurants(); renderEligible(); renderHistory(); renderReviews();
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
    renderReviews(); renderReviewControls();
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
  state.reviewError = initial.reviewError || '';
  if (initial.status.mode === 'solo') { state.reviews = initial.localReviews || []; await db.replaceReviews(state.reviews); renderRestaurants(); renderReviews(); }
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
    const summary = reviewSummary(state.reviews, r.id);
    const reviews = create('button', 'review-card-button', summary.count ? `★ ${summary.average.toFixed(1)} · 리뷰 ${summary.count}` : '☆ 별점·리뷰');
    reviews.setAttribute('aria-label', `${r.name} 별점·리뷰`); reviews.onclick = () => openReviews(r.id);
    const edit = create('button', '', '수정'); edit.title = `${r.name} 수정`; edit.onclick = () => openForm(r);
    const remove = create('button', '', '삭제'); remove.title = `${r.name} 삭제`; remove.onclick = () => deleteRestaurant(r);
    edit.disabled = remove.disabled = state.syncMode === 'client' && !state.syncConnected;
    actions.append(reviews, edit, remove); card.append(avatar, detail, badge, actions); list.append(card);
  }
}

function reviewsWritable() { return Boolean(window.lunchSync) && !state.reviewError && !(state.syncMode === 'client' && !state.syncConnected); }

function openReviews(restaurantId) {
  state.reviewRestaurantId = restaurantId; renderReviews(); $('reviewsDialog').showModal();
}

function openPhoto(src) {
  $('reviewLargePhoto').src = src; $('reviewPhotoDialog').showModal();
}

function avatarImage(id, className = 'review-avatar') {
  const avatar = avatarById(id); const image = create('img', `${className} ${avatar.style}`);
  image.src = avatarSource(id); image.alt = avatar.name; return image;
}

function renderAvatarPicker() {
  $('reviewAvatarStyles').replaceChildren(...AVATAR_STYLES.map(style => {
    const button = tagButton(style.label, style.id === state.reviewAvatarStyle, () => { state.reviewAvatarStyle = style.id; renderAvatarPicker(); });
    button.title = style.description; return button;
  }));
  $('reviewAvatarChoices').replaceChildren(...AVATARS.filter(avatar => avatar.style === state.reviewAvatarStyle).map(avatar => {
    const button = create('button', `avatar-choice${avatar.id === state.reviewAvatarId ? ' selected' : ''}`); button.type = 'button';
    button.setAttribute('aria-label', avatar.name); button.setAttribute('aria-pressed', String(avatar.id === state.reviewAvatarId));
    button.append(avatarImage(avatar.id, 'avatar-choice-image'), create('span', '', avatar.name));
    button.onclick = () => { state.reviewAvatarId = avatar.id; renderAvatarPicker(); }; return button;
  }));
  $('reviewProfilePreview').replaceChildren(avatarImage(state.reviewAvatarId), create('div', '', `${$('reviewNickname').value.trim() || '내 닉네임'} · ${avatarById(state.reviewAvatarId).name}`));
}

function renderReviews() {
  renderReviewBoard();
  if (!state.reviewRestaurantId) return;
  const restaurant = state.restaurants.find(r => r.id === state.reviewRestaurantId);
  $('reviewsRestaurantName').textContent = restaurant?.name || '삭제된 음식점';
  const summary = reviewSummary(state.reviews, state.reviewRestaurantId);
  $('reviewsSummary').textContent = summary.count ? `★ ${summary.average.toFixed(1)} / 5 · 리뷰 ${summary.count}개` : '첫 번째 리뷰를 남겨 주세요.';
  $('addReviewButton').disabled = !restaurant || !reviewsWritable();
  $('reviewConnectionNote').textContent = state.reviewError || (!window.lunchSync ? '리뷰 등록·수정은 데스크톱 앱에서 사용할 수 있습니다.' : state.syncMode === 'client' && !state.syncConnected ? '호스트 연결이 끊겨 리뷰를 볼 수만 있어요. 연결 후 등록·수정할 수 있습니다.' : '작성 시 정한 4자리 비밀번호로 자신의 리뷰를 수정·삭제할 수 있어요.');
  const list = $('reviewsList'); list.replaceChildren();
  const items = state.reviews.filter(r => r.restaurantId === state.reviewRestaurantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!items.length) list.append(create('p', 'review-empty', '아직 리뷰가 없어요. 오늘의 한 끼는 어땠나요?'));
  for (const review of items) list.append(reviewCard(review));
}

function reviewCard(review, fromBoard = false) {
    const card = create('article', 'review-card'); card.dataset.reviewId = review.id;
    if (fromBoard) {
      const restaurant = state.restaurants.find(r => r.id === review.restaurantId);
      const place = create('button', 'review-board-place', restaurant?.name || '삭제된 음식점');
      place.type = 'button'; place.disabled = !restaurant;
      place.onclick = () => openReviews(review.restaurantId);
      card.append(place);
    }
    const top = create('div', 'review-card-top');
    const author = create('div', 'review-author');
    author.append(create('strong', '', review.nickname), create('small', '', avatarById(review.avatarId).name));
    const score = create('span', 'review-score', '★'.repeat(review.rating) + '☆'.repeat(5 - review.rating));
    score.setAttribute('aria-label', `별점 ${review.rating}점`);
    top.append(avatarImage(review.avatarId), author, score); card.append(top);
    const dates = create('small', 'review-date', `${formatDate(review.createdAt)} 작성${review.version > 1 ? ` · ${formatDate(review.updatedAt)} 수정` : ''}`);
    if (review.body) card.append(create('p', 'review-text', review.body));
    const photos = create('div', 'review-photos');
    photos.dataset.count = String(review.photos.length);
    for (const [index, src] of review.photos.entries()) {
      const button = create('button', 'review-photo-button'); button.type = 'button'; button.setAttribute('aria-label', `${review.nickname} 사진 ${index + 1} 확대`);
      const image = create('img'); image.src = src; image.alt = `${review.nickname}의 음식점 사진 ${index + 1}`; image.loading = 'lazy';
      button.append(image); button.onclick = () => openPhoto(src); photos.append(button);
    }
    card.append(photos);
    const edit = create('button', 'review-edit', '비밀번호로 수정'); edit.disabled = !reviewsWritable();
    edit.onclick = () => { state.reviewRestaurantId = review.restaurantId; openReviewForm(review, fromBoard); };
    const footer = create('div', 'review-card-footer'); footer.append(dates, edit); card.append(footer);
    return card;
}

function renderReviewBoard() {
  $('reviewSideCount').textContent = state.reviews.length;
  const picker = $('reviewBoardRestaurant'); const previous = picker.value;
  const restaurants = [...state.restaurants].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  picker.replaceChildren(new Option('전체 음식점', ''), ...restaurants.map(r => new Option(r.name, r.id)));
  picker.value = restaurants.some(r => r.id === previous) ? previous : '';
  const query = $('reviewBoardSearch').value.trim().toLocaleLowerCase();
  const places = new Map(state.restaurants.map(r => [r.id, r]));
  const items = state.reviews.filter(review => {
    const place = places.get(review.restaurantId);
    return (!picker.value || picker.value === review.restaurantId) &&
      (!query || [review.nickname, review.body, place?.name, place?.address, ...(place?.tags || [])].join(' ').toLocaleLowerCase().includes(query));
  }).sort((a, b) => ($('reviewBoardSort').value === 'rating' ? b.rating - a.rating : 0) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  $('reviewBoardCount').textContent = `게시글 ${items.length}개 · 전체 ${state.reviews.length}개`;
  $('boardWriteButton').disabled = !reviewsWritable() || !restaurants.length;
  $('reviewComposeContinue').disabled = !reviewsWritable() || !restaurants.length;
  $('reviewBoardConnection').textContent = state.reviewError || (!window.lunchSync ? '글쓰기는 데스크톱 앱에서 사용할 수 있어요.' : state.syncMode === 'client' && !state.syncConnected ? '호스트 연결이 끊겨 저장된 글을 보고 있어요.' : state.syncMode === 'solo' ? '개인 모드 · 교육장 공유에 참여하면 팀원 글을 함께 볼 수 있어요.' : '교육장 공유 · 팀원의 새 글이 자동으로 반영돼요.');
  const list = $('reviewBoardList'); list.replaceChildren(...items.map(review => reviewCard(review, true)));
  if (!items.length) {
    const empty = create('div', 'empty-state');
    empty.append(create('span', 'empty-icon', '▧'), create('strong', '', state.reviews.length ? '조건에 맞는 게시글이 없어요' : '아직 게시글이 없어요'), create('p', '', state.reviews.length ? '다른 음식점이나 검색어로 찾아보세요.' : restaurants.length ? '오른쪽 위 리뷰 글쓰기로 첫 이야기를 남겨 주세요.' : '음식점 보관함에 음식점을 등록한 뒤 첫 글을 남겨 주세요.'));
    list.append(empty);
  }
}

function composeBoardReview() {
  if (!reviewsWritable() || !state.restaurants.length) return;
  const restaurants = [...state.restaurants].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const picker = $('reviewComposeRestaurant');
  picker.replaceChildren(...restaurants.map(r => new Option(r.name, r.id)));
  if ($('reviewBoardRestaurant').value) picker.value = $('reviewBoardRestaurant').value;
  $('reviewComposeDialog').showModal();
}

function renderReviewControls() {
  const blocked = !reviewsWritable() || state.reviewPending || state.reviewPhotoBusy;
  $('reviewSaveButton').disabled = $('deleteReviewButton').disabled = blocked;
  $('reviewPhotoInput').disabled = blocked;
  $('reviewSaveButton').textContent = state.reviewPending ? '저장 중…' : state.reviewPhotoBusy ? '사진 준비 중…' : state.reviewEditId ? '리뷰 수정 저장' : '리뷰 올리기';
}

function renderReviewStars() {
  $('reviewStars').replaceChildren(...[1, 2, 3, 4, 5].map(score => {
    const button = create('button', score <= state.reviewRating ? 'selected' : '', '★'); button.type = 'button';
    button.setAttribute('aria-label', `별점 ${score}점`); button.setAttribute('aria-pressed', String(score === state.reviewRating));
    button.onclick = () => { state.reviewRating = score; renderReviewStars(); }; return button;
  }));
  $('reviewRatingLabel').textContent = state.reviewRating ? `${state.reviewRating} / 5점` : '별점을 선택해 주세요.';
}

function renderReviewPhotos() {
  $('reviewPhotoPreviews').replaceChildren(...state.reviewPhotos.map((src, index) => {
    const wrapper = create('div', 'review-photo-preview');
    const photo = create('button', 'review-photo-button'); photo.type = 'button'; photo.setAttribute('aria-label', `첨부 사진 ${index + 1} 확대`);
    const image = create('img'); image.src = src; image.alt = `첨부 사진 ${index + 1}`; photo.append(image); photo.onclick = () => openPhoto(src);
    const remove = create('button', 'review-photo-remove', '×'); remove.type = 'button'; remove.setAttribute('aria-label', `첨부 사진 ${index + 1} 삭제`);
    remove.onclick = () => { if (state.reviewPending || state.reviewPhotoBusy) return; state.reviewPhotos.splice(index, 1); renderReviewPhotos(); };
    wrapper.append(photo, remove); return wrapper;
  }));
}

async function openReviewForm(review = null, fromBoard = false) {
  if (!reviewsWritable()) return;
  state.reviewReturnToBoard = fromBoard;
  state.reviewFormToken++; state.reviewEditId = review?.id || null; state.reviewEditVersion = review?.version || null;
  state.reviewRating = review?.rating || 0; state.reviewPhotos = [...review?.photos || []];
  $('reviewFormTitle').textContent = review ? '리뷰 수정' : '리뷰 쓰기';
  $('reviewPlaceName').textContent = state.restaurants.find(r => r.id === state.reviewRestaurantId)?.name || '음식점';
  $('reviewNickname').value = review?.nickname || await db.meta('reviewNickname') || '';
  state.reviewAvatarId = avatarById(review?.avatarId || await db.meta('reviewAvatarId')).id;
  state.reviewAvatarStyle = avatarById(state.reviewAvatarId).style; renderAvatarPicker();
  $('reviewBody').value = review?.body || ''; $('reviewPin').value = ''; $('reviewPhotoInput').value = ''; $('reviewFormError').textContent = '';
  $('deleteReviewButton').hidden = !review;
  renderReviewStars(); renderReviewPhotos(); renderReviewControls();
  $('reviewsDialog').close(); $('reviewFormDialog').showModal(); $('reviewNickname').focus();
}

function closeReviewForm() {
  if (state.reviewPending || state.reviewPhotoBusy) return;
  state.reviewFormToken++; $('reviewPin').value = ''; $('reviewFormDialog').close();
  renderReviews();
  if (state.reviewReturnToBoard) switchTab('reviews');
  else $('reviewsDialog').showModal();
}

async function compressReviewPhoto(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 12_000_000) throw new Error('12MB 이하의 JPG, PNG, WebP 사진을 선택해 주세요.');
  let image;
  try { image = await createImageBitmap(file); } catch { throw new Error('읽을 수 없는 사진입니다. 다른 사진을 선택해 주세요.'); }
  try {
    if (image.width * image.height > 50_000_000) throw new Error('사진 해상도가 너무 높습니다. 크기를 줄여 선택해 주세요.');
    const canvas = document.createElement('canvas');
    for (const edge of [1280, 960, 640]) {
      const scale = Math.min(1, edge / Math.max(image.width, image.height));
      canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of [.8, .65, .45]) {
        const result = canvas.toDataURL('image/jpeg', quality); if (result.length <= MAX_PHOTO_LENGTH) return result;
      }
    }
    throw new Error('사진을 저장 크기로 줄이지 못했습니다. 다른 사진을 선택해 주세요.');
  } finally { image.close(); }
}

async function chooseReviewPhotos(event) {
  const files = [...event.target.files || []]; event.target.value = '';
  if (!files.length) return;
  const token = state.reviewFormToken; state.reviewPhotoBusy = true; renderReviewControls(); $('reviewFormError').textContent = '';
  try {
    if (state.reviewPhotos.length + files.length > MAX_REVIEW_PHOTOS) throw new Error('사진은 합쳐서 최대 3장까지 선택해 주세요.');
    const photos = [];
    for (const file of files) photos.push(await compressReviewPhoto(file));
    if (token === state.reviewFormToken) { state.reviewPhotos.push(...photos); renderReviewPhotos(); }
  } catch (error) { if (token === state.reviewFormToken) $('reviewFormError').textContent = error.message; }
  finally { state.reviewPhotoBusy = false; renderReviewControls(); }
}

async function writeReview(operation) {
  if (!reviewsWritable()) throw new Error('호스트에 연결한 후 다시 시도해 주세요.');
  const result = await window.lunchSync.mutate(operation);
  if (state.syncMode === 'solo') { state.reviews = result.reviews; await db.replaceReviews(state.reviews); }
  else await queueSharedEnvelope(result);
  renderRestaurants(); renderReviews();
}

async function saveReview(event) {
  event.preventDefault(); if (state.reviewPending || state.reviewPhotoBusy) return;
  $('reviewFormError').textContent = '';
  try {
    const pin = $('reviewPin').value;
    if (!/^\d{4}$/.test(pin)) throw new Error('비밀번호는 숫자 4자리로 입력해 주세요.');
    if (!state.restaurants.some(r => r.id === state.reviewRestaurantId)) throw new Error('음식점이 삭제되어 리뷰를 올릴 수 없습니다.');
    const now = new Date().toISOString();
    const review = cleanReview({ id: state.reviewEditId || crypto.randomUUID(), restaurantId: state.reviewRestaurantId,
      nickname: $('reviewNickname').value, avatarId: state.reviewAvatarId, rating: state.reviewRating, body: $('reviewBody').value,
      photos: state.reviewPhotos, createdAt: now, updatedAt: now, version: 1 });
    state.reviewPending = true; renderReviewControls();
    await writeReview({ type: state.reviewEditId ? 'updateReview' : 'createReview', review, pin,
      id: state.reviewEditId, expectedVersion: state.reviewEditVersion });
    await db.saveMeta('reviewNickname', review.nickname).catch(() => {});
    await db.saveMeta('reviewAvatarId', review.avatarId).catch(() => {});
    state.reviewPending = false; closeReviewForm(); toast(state.reviewEditId ? '리뷰를 수정했어요.' : '리뷰를 올렸어요.');
  } catch (error) { $('reviewFormError').textContent = error.message || '리뷰를 저장하지 못했습니다.'; }
  finally { state.reviewPending = false; renderReviewControls(); }
}

async function deleteReview() {
  if (state.reviewPending || state.reviewPhotoBusy || !state.reviewEditId) return;
  $('reviewFormError').textContent = '';
  if (!/^\d{4}$/.test($('reviewPin').value)) { $('reviewFormError').textContent = '작성 시 정한 4자리 비밀번호를 입력해 주세요.'; return; }
  if (!confirm('이 리뷰와 사진을 삭제할까요?')) return;
  state.reviewPending = true; renderReviewControls();
  try {
    await writeReview({ type: 'deleteReview', id: state.reviewEditId, pin: $('reviewPin').value, expectedVersion: state.reviewEditVersion });
    state.reviewPending = false; closeReviewForm(); toast('리뷰를 삭제했어요.');
  } catch (error) { $('reviewFormError').textContent = error.message; }
  finally { state.reviewPending = false; renderReviewControls(); }
}

function switchTab(tab) {
  $('lotteryTab').hidden = tab !== 'lottery';
  $('restaurantsTab').hidden = tab !== 'restaurants';
  $('reviewsTab').hidden = tab !== 'reviews';
  $('historyTab').hidden = tab !== 'history';
  $('shareTab').hidden = tab !== 'share';
  $('fireOverlay').classList.toggle('active', tab === 'lottery' && ['final', 'ultimate'].includes(state.phase));
  document.querySelectorAll('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  if (tab === 'reviews') renderReviewBoard();
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
  const payload = { format: 'lunch-lottery-backup', version: 4, exportedAt: new Date().toISOString(), restaurants: state.restaurants, draws: state.draws, reviews: state.reviews, settings: state.settings };
  downloadJson(payload, `점심복권-전체백업-${new Date().toISOString().slice(0, 10)}.json`);
  toast('음식점, 식사 이력, 리뷰·사진과 설정을 백업했어요. 리뷰 비밀번호는 원래 PC에만 보관됩니다.');
}

async function importRestaurants(file) {
  if (!file) return;
  try {
    if (file.size > 45_000_000) throw new Error('45MB 이하의 JSON 파일을 선택해 주세요.');
    const data = JSON.parse(await file.text());
    const validRestaurantFile = data.format === 'lunch-lottery-restaurants' && data.version === 1;
    const legacyBackup = data.format === 'lunch-lottery-backup' && [1, 2, 3, 4].includes(data.version);
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
    if (file.size > 45_000_000) throw new Error('45MB 이하의 백업 파일을 선택해 주세요.');
    const data = JSON.parse(await file.text());
    if (data.format !== 'lunch-lottery-backup' || ![1, 2, 3, 4].includes(data.version) || !Array.isArray(data.restaurants)) throw new Error('점심복권 전체 백업 파일이 아닙니다.');
    const beforeRestaurants = state.restaurants.length;
    const beforeDraws = state.draws.length;
    const restaurants = data.restaurants.slice(0, 5000).map(raw => cleanRestaurant({ ...raw, id: typeof raw.id === 'string' ? raw.id : undefined }));
    const draws = (Array.isArray(data.draws) ? data.draws : []).slice(0, 20000)
      .filter(raw => typeof raw?.id === 'string' && typeof raw.restaurantId === 'string' && ['normal', 'final', 'ultimate'].includes(raw.phase) && !Number.isNaN(Date.parse(raw.drawnAt)))
      .map(raw => ({ id: raw.id, restaurantId: raw.restaurantId, restaurantName: String(raw.restaurantName || '').slice(0, 80), restaurantAddress: String(raw.restaurantAddress || '').slice(0, 180), phase: raw.phase, drawnAt: raw.drawnAt, eatenOn: /^\d{4}-\d{2}-\d{2}$/.test(raw.eatenOn || '') ? raw.eatenOn : null }));
    const reviews = (data.version >= 4 ? data.reviews || [] : []).map(cleanReview).filter(review => restaurants.some(r => r.id === review.restaurantId));
    if (reviews.length > 1500) throw new Error('리뷰는 최대 1,500개까지 가져올 수 있습니다.');
    await mutateShared({ type: 'mergeFull', restaurants, draws, reviews }, async () => {
      for (const item of restaurants) {
        if (!state.restaurants.some(r => r.id === item.id || (r.name === item.name && r.address === item.address))) {
          await db.saveRestaurant(item); state.restaurants.push(item);
        }
      }
      for (const draw of draws) {
        if (!state.draws.some(d => d.id === draw.id)) { await db.saveDraw(draw); state.draws.push(draw); }
      }
      if (reviews.length) {
        if (!window.lunchSync) throw new Error('리뷰 백업은 데스크톱 앱에서 가져와 주세요.');
        const result = await window.lunchSync.mutate({ type: 'mergeReviews', reviews });
        state.reviews = result.reviews; await db.replaceReviews(state.reviews);
      }
    });
    if (data.version >= 3 && data.settings && typeof data.settings === 'object') {
      state.settings = normalizeSettings(data.settings); await db.saveSettings(state.settings);
    }
    state.restaurants = await db.restaurants(); state.draws = await db.draws();
    renderSettings(); renderTags(); renderRestaurants(); renderEligible(); renderHistory();
    renderReviews();
    toast(`음식점 ${state.restaurants.length - beforeRestaurants}개, 추첨 이력 ${state.draws.length - beforeDraws}개를 가져왔어요.${reviews.length ? ' 리뷰·사진도 가져왔습니다. 수정은 원래 PC의 비밀번호 정보가 필요합니다.' : ''}`);
  } catch (error) { toast(error.message || '전체 백업 파일을 읽지 못했습니다.'); }
  $('fullImportFile').value = '';
}

function attachEvents() {
  $('boardWriteButton').onclick = composeBoardReview;
  $('reviewBoardSearch').oninput = renderReviewBoard;
  $('reviewBoardRestaurant').onchange = $('reviewBoardSort').onchange = renderReviewBoard;
  $('closeReviewCompose').onclick = () => $('reviewComposeDialog').close();
  $('reviewComposeContinue').onclick = () => {
    const id = $('reviewComposeRestaurant').value;
    if (!reviewsWritable() || !state.restaurants.some(r => r.id === id)) return;
    state.reviewRestaurantId = id; $('reviewComposeDialog').close(); openReviewForm(null, true);
  };
  $('openShareButton').onclick = () => switchTab('share');
  $('copyConnectionButton').onclick = async () => { try { await window.lunchSync.copyInvite(); toast('호스트 주소와 공유 코드를 복사했어요.'); } catch (error) { toast(error.message); } };
  $('closeReviewsDialog').onclick = () => $('reviewsDialog').close();
  $('addReviewButton').onclick = () => openReviewForm();
  $('closeReviewForm').onclick = $('cancelReviewForm').onclick = closeReviewForm;
  $('reviewFormDialog').addEventListener('cancel', event => { event.preventDefault(); closeReviewForm(); });
  $('reviewForm').addEventListener('submit', saveReview);
  $('reviewPhotoInput').onchange = chooseReviewPhotos;
  $('reviewNickname').oninput = renderAvatarPicker;
  $('deleteReviewButton').onclick = deleteReview;
  $('closeReviewPhoto').onclick = () => { $('reviewPhotoDialog').close(); $('reviewLargePhoto').removeAttribute('src'); };
  document.querySelectorAll('.nav-item').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
  $('discoveredHosts').onchange = event => { if (event.target.value) $('joinAddress').value = event.target.value; };
  $('startHostButton').onclick = async () => {
    if (!window.lunchSync) { $('shareError').textContent = '교육장 공유는 데스크톱 앱에서 사용할 수 있습니다.'; return; }
    $('startHostButton').disabled = true;
    try {
      const result = await window.lunchSync.startHost({ restaurants: state.restaurants, draws: state.draws, reviews: state.reviews });
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
  try { await seedDefaultRestaurants(); state.restaurants = await db.restaurants(); state.draws = await db.draws(); state.reviews = await db.reviews(); state.settings = normalizeSettings(await db.settings()); }
  catch (error) { toast('저장소를 열지 못했습니다. 앱을 다시 실행해 주세요.'); console.error(error); }
  renderTags(); renderRestaurants(); renderSettings(); renderEligible(); renderHistory(); renderReviews();
  try { await initSync(); } catch (error) { $('shareError').textContent = error.message; }
}

init();
