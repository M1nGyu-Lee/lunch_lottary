export const SYNC_SCHEMA = 1;
export const SYNC_PORT = 41781;
export const DISCOVERY_PORT = 41782;
export const DISCOVERY_GROUP = '239.255.42.81';

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortValue(value[key])]));
  }
  return value;
}

export function normalizeSharedSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.restaurants) || !Array.isArray(snapshot.draws)) {
    throw new Error('공유 데이터 형식이 올바르지 않습니다.');
  }
  if (snapshot.restaurants.length > 5000 || snapshot.draws.length > 20000) {
    throw new Error('공유 데이터가 허용 크기를 넘었습니다.');
  }
  return {
    restaurants: [...snapshot.restaurants].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    draws: [...snapshot.draws].sort((a, b) => String(a.id).localeCompare(String(b.id)))
  };
}

export function canonicalSnapshot(snapshot) {
  return JSON.stringify(sortValue(normalizeSharedSnapshot(snapshot)));
}
