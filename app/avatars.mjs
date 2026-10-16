export const AVATAR_STYLES = [
  { id: 'illustration', label: '말랑 일러스트', description: '부드럽고 반짝이는 캐릭터' },
  { id: 'doodle', label: '하찮은 낙서', description: '삐뚤삐뚤, 대충 그린 듯 귀엽게' },
  { id: 'pixel', label: '픽셀 게임', description: '작은 도트 세상의 점심 친구' }
];
export const AVATARS = [
  { id: 'capybara', name: '소풍 카피바라', style: 'illustration' },
  { id: 'fox', name: '마법사 여우', style: 'illustration' },
  { id: 'penguin', name: '우주 펭귄', style: 'illustration' },
  { id: 'robot', name: '로봇 병아리', style: 'illustration' },
  { id: 'doodle-potato', name: '대충 감자', style: 'doodle' },
  { id: 'doodle-frog', name: '멍한 개구리', style: 'doodle' },
  { id: 'pixel-cat', name: '도트 모험냥', style: 'pixel' },
  { id: 'pixel-ghost', name: '도시락 유령', style: 'pixel' }
];
export function avatarById(id) { return AVATARS.find(avatar => avatar.id === id) || AVATARS[0]; }
export function avatarSource(id) { return `./assets/avatars/${avatarById(id).id}.png`; }
