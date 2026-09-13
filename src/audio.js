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

  // 环境音：风声（循环噪声+低通）+ 战斗低音 drone（随战斗强度渐入渐出）
  startAmbient() {
    if (!this.ctx || this._ambient) return;
    this._ambient = true;
    // 风声
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const wind = this.ctx.createBufferSource();
    wind.buffer = buf; wind.loop = true;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 320; lp.Q.value = 0.6;
    const windGain = this.ctx.createGain();
    windGain.gain.value = 0.045;
    wind.connect(lp).connect(windGain).connect(this.master);
    wind.start();
    // 战斗 drone：两个失谐低频振荡器
    const droneGain = this.ctx.createGain();
    droneGain.gain.value = 0;
    for (const f of [55, 110.7]) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth'; osc.frequency.value = f;
      const og = this.ctx.createGain(); og.gain.value = 0.5;
      osc.connect(og).connect(droneGain);
      osc.start();
    }
    const droneLp = this.ctx.createBiquadFilter();
    droneLp.type = 'lowpass'; droneLp.frequency.value = 240;
    droneGain.connect(droneLp).connect(this.master);
    this._droneGain = droneGain;
  }

  // 战斗强度 0~1：驱动战斗氛围音量渐变
  setCombat(x) {
    if (this._droneGain && this.ctx) {
      this._droneGain.gain.setTargetAtTime(0.06 * Math.max(0, Math.min(1, x)), this.ctx.currentTime, 1.2);
    }
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
