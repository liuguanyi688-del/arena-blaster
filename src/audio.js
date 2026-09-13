// 音效管理：WebAudio，全部本地 OGG，开始游戏（用户手势）后解锁
export class SoundManager {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.buffers = new Map();
    this._volume = 0.55;
  }

  setVolume(v) {
    this._volume = v;
    if (this.master) this.master.gain.value = v;
  }

  unlock() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = this._volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  async load(name, url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`音效加载失败 ${url}`);
    const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
    this.buffers.set(name, buf);
  }

  // pitch: 1 正常；>1 更尖；volume 0~1
  play(name, { volume = 1, pitch = 1, jitter = 0 } = {}) {
    if (!this.ctx || !this.buffers.has(name)) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers.get(name);
    src.playbackRate.value = pitch * (1 + (Math.random() * 2 - 1) * jitter);
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(this.master);
    src.start();
  }

  // 简易距离衰减：给敌人枪声/死亡用
  playAt(name, distance, base = 0.8, maxDist = 60) {
    const v = base * Math.max(0, 1 - distance / maxDist);
    if (v > 0.01) this.play(name, { volume: v, jitter: 0.06 });
  }
}
