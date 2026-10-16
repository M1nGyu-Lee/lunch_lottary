const { scrypt, randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const derive = promisify(scrypt);

function pinValue(pin) {
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) throw new Error('비밀번호는 숫자 4자리로 입력해 주세요.');
  return pin;
}

async function protectPin(pin) {
  const salt = randomBytes(16).toString('hex');
  const digest = await derive(pinValue(pin), salt, 32);
  return { salt, hash: digest.toString('hex') };
}

async function matchesPin(pin, credential) {
  pinValue(pin);
  if (!credential || !/^[a-f0-9]{32}$/.test(credential.salt) || !/^[a-f0-9]{64}$/.test(credential.hash)) {
    throw new Error('이 리뷰의 수정 비밀번호 정보가 없습니다. 원래 작성한 호스트 또는 PC에서 수정해 주세요.');
  }
  const digest = await derive(pin, credential.salt, 32);
  return timingSafeEqual(digest, Buffer.from(credential.hash, 'hex'));
}

function createReviewEditor() {
  const attempts = new Map();
  async function authorize(id, pin, credential) {
    const now = Date.now();
    const previous = attempts.get(id);
    if (previous && previous.until > now && previous.count >= 5) throw new Error('비밀번호를 5회 틀렸습니다. 1분 뒤 다시 시도해 주세요.');
    if (!await matchesPin(pin, credential)) {
      const item = previous?.until > now ? previous : { count: 0, until: now + 60_000 };
      item.count++; attempts.set(id, item);
      if (attempts.size > 2000) for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
      throw new Error('리뷰 비밀번호가 맞지 않습니다.');
    }
    attempts.delete(id);
  }
  return async function edit(op, reviews, credentials) {
    const { cleanReview } = await import('../app/reviews.mjs');
    const nextReviews = structuredClone(reviews);
    const nextCredentials = structuredClone(credentials);
    if (op.type === 'createReview') {
      const now = new Date().toISOString();
      const item = cleanReview({ ...op.review, id: randomUUID(), version: 1, createdAt: now, updatedAt: now });
      nextCredentials[item.id] = await protectPin(op.pin);
      nextReviews.push(item);
    } else if (op.type === 'updateReview' || op.type === 'deleteReview') {
      const item = nextReviews.find(review => review.id === op.id);
      if (!item) throw new Error('리뷰가 삭제됐거나 찾을 수 없습니다.');
      await authorize(item.id, op.pin, nextCredentials[item.id]);
      if (item.version !== op.expectedVersion) throw new Error('다른 PC에서 먼저 수정했습니다. 리뷰를 다시 열어 주세요.');
      const index = nextReviews.indexOf(item);
      if (op.type === 'deleteReview') { nextReviews.splice(index, 1); delete nextCredentials[item.id]; }
      else nextReviews[index] = cleanReview({ ...op.review, id: item.id, restaurantId: item.restaurantId,
        createdAt: item.createdAt, updatedAt: new Date().toISOString(), version: item.version + 1 });
    } else throw new Error('지원하지 않는 리뷰 요청입니다.');
    if (nextReviews.length > 1500 || Buffer.byteLength(JSON.stringify(nextReviews)) > 40_000_000) {
      throw new Error('리뷰 저장 한도에 도달했습니다. 사용하지 않는 리뷰나 사진을 정리해 주세요.');
    }
    return { reviews: nextReviews, credentials: nextCredentials };
  };
}

module.exports = { createReviewEditor, protectPin, matchesPin };
