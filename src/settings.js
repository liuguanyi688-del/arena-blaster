// 玩家设置：localStorage 持久化
const KEY = 'ab_settings';

export const settings = {
  sens: 1,        // 鼠标灵敏度倍率
  volume: 0.55,   // 主音量
  fov: 75,        // 视场角
  invertY: false, // 反转Y轴
  fps: true       // 显示帧率
};

export function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    for (const k of Object.keys(settings)) {
      if (s[k] !== undefined) settings[k] = s[k];
    }
  } catch (e) { /* 忽略损坏的存档 */ }
  return settings;
}

export function saveSettings() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) { /* 隐身模式等场景 */ }
}
