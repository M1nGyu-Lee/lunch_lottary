export const DEFAULT_SETTINGS = Object.freeze({ revealThreshold: 14, rerollLimit: 2, minScratch: 2, verifiedOnly: true, excludeRecentMeals: false });
export const DEFAULT_TAGS = ['한식', '중식', '일식', '양식', '분식', '아시안', '국물', '면', '밥', '가벼운 식사'];

export function cleanRestaurant(input) {
  const name = String(input.name || '').trim().slice(0, 80);
  const address = String(input.address || '').trim().slice(0, 180);
  const tags = [...new Set((input.tags || []).map(x => String(x).trim()).filter(Boolean))].slice(0, 12);
  if (!name) throw new Error('음식점 이름을 입력해 주세요.');
  if (!address) throw new Error('위치를 입력해 주세요.');
  if (!tags.length) throw new Error('태그를 하나 이상 선택해 주세요.');
  const zeroPay = ['verified', 'unverified', 'unknown'].includes(input.zeroPay) ? input.zeroPay : 'unknown';
  return {
    id: input.id || crypto.randomUUID(), name, address, tags, zeroPay,
    verifiedAt: zeroPay === 'verified' && Number.isFinite(Date.parse(input.verifiedAt)) ? input.verifiedAt : null,
    createdAt: input.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString()
  };
}

export function isVerificationStale(restaurant, now = Date.now(), ageDays = 90) {
  if (restaurant.zeroPay !== 'verified') return false;
  const checkedAt = Date.parse(restaurant.verifiedAt);
  return !Number.isFinite(checkedAt) || checkedAt > now || now - checkedAt > ageDays * 86_400_000;
}

export function recentlyEatenIds(draws, today, days = 7) {
  const todayTime = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(todayTime)) return new Set();
  return new Set(draws.filter(draw => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draw.eatenOn || '')) return false;
    const diff = todayTime - Date.parse(`${draw.eatenOn}T00:00:00Z`);
    return diff >= 0 && diff < days * 86_400_000;
  }).map(draw => draw.restaurantId));
}

export function eligibleRestaurants(restaurants, filters, verifiedOnly = true) {
  const chosen = new Set(filters || []);
  return restaurants.filter(r => (!verifiedOnly || r.zeroPay === 'verified') &&
    (!chosen.size || r.tags.some(tag => chosen.has(tag))));
}

export function pickRestaurant(restaurants, previousId = null, random = Math.random) {
  if (!restaurants.length) return null;
  const pool = restaurants.length > 1 ? restaurants.filter(r => r.id !== previousId) : restaurants;
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}

export function canReroll({ phase, scratched, rerolls, settings }) {
  return phase === 'normal' && rerolls < settings.rerollLimit &&
    scratched >= settings.minScratch && scratched <= settings.revealThreshold;
}

export function normalizeSettings(value = {}) {
  const revealThreshold = Math.max(3, Math.min(60, Number(value.revealThreshold) || DEFAULT_SETTINGS.revealThreshold));
  const rerollLimit = Math.max(0, Math.min(10, Number.isFinite(Number(value.rerollLimit)) ? Math.floor(Number(value.rerollLimit)) : DEFAULT_SETTINGS.rerollLimit));
  return { ...DEFAULT_SETTINGS, revealThreshold, rerollLimit, verifiedOnly: value.verifiedOnly !== false,
    excludeRecentMeals: value.excludeRecentMeals === true };
}
