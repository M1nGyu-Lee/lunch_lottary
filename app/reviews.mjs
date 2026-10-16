import { AVATARS } from './avatars.mjs';
export const MAX_REVIEW_PHOTOS = 3;
export const MAX_PHOTO_LENGTH = 280_000;

export function cleanReview(raw) {
  if (!raw || typeof raw.id !== 'string' || !raw.id || raw.id.length > 100 ||
      typeof raw.restaurantId !== 'string' || !raw.restaurantId || raw.restaurantId.length > 100) {
    throw new Error('리뷰의 음식점 정보가 올바르지 않습니다.');
  }
  const nickname = String(raw.nickname || '').trim();
  const body = String(raw.body || '').trim();
  const avatarId = raw.avatarId ?? 'capybara';
  if (!AVATARS.some(avatar => avatar.id === avatarId)) throw new Error('목록에서 사용자 아이콘을 선택해 주세요.');
  if (!nickname || nickname.length > 20) throw new Error('닉네임을 1~20자로 입력해 주세요.');
  if (!Number.isInteger(raw.rating) || raw.rating < 1 || raw.rating > 5) throw new Error('별점을 1~5개 선택해 주세요.');
  if (body.length > 1500) throw new Error('리뷰는 1,500자까지 입력할 수 있습니다.');
  if (!Array.isArray(raw.photos) || raw.photos.length > MAX_REVIEW_PHOTOS) throw new Error('사진은 최대 3장까지 올릴 수 있습니다.');
  for (const photo of raw.photos) {
    if (typeof photo !== 'string' || photo.length > MAX_PHOTO_LENGTH ||
        !/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/.test(photo) ||
        !(photo.startsWith('data:image/jpeg;base64,/9j/') || photo.startsWith('data:image/png;base64,iVBORw0KGgo'))) {
      throw new Error('사진 형식이나 크기가 올바르지 않습니다. 사진을 다시 선택해 주세요.');
    }
  }
  if (!Number.isFinite(Date.parse(raw.createdAt)) || !Number.isFinite(Date.parse(raw.updatedAt)) ||
      !Number.isSafeInteger(raw.version) || raw.version < 1) throw new Error('리뷰 기록 정보가 올바르지 않습니다.');
  return { id: raw.id, restaurantId: raw.restaurantId, nickname, avatarId, rating: raw.rating, body,
    photos: [...raw.photos], createdAt: raw.createdAt, updatedAt: raw.updatedAt, version: raw.version };
}

export function reviewSummary(reviews, restaurantId) {
  const items = reviews.filter(review => review.restaurantId === restaurantId);
  return { count: items.length, average: items.length ? items.reduce((sum, review) => sum + review.rating, 0) / items.length : null };
}
