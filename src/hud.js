// HUD：全部操作 DOM 覆盖层
export class HUD {
  constructor() {
    this.el = {
      hud: document.getElementById('hud'),
      crosshair: document.getElementById('crosshair'),
      hitmarker: document.getElementById('hitmarker'),
      healthnum: document.getElementById('healthnum'),
      hpfill: document.getElementById('hpfill'),
      ammo: document.getElementById('ammo'),
      reloadtip: document.getElementById('reloadtip'),
      weaponname: document.getElementById('weaponname'),
      kills: document.getElementById('kills'),
      killfeed: document.getElementById('killfeed'),
      lockhint: document.getElementById('lockhint'),
      vignette: document.getElementById('vignette'),
      healflash: document.getElementById('healflash'),
      fps: document.getElementById('fps'),
      dmglayer: document.getElementById('dmglayer'),
      scope: document.getElementById('scope'),
      crosshair: document.getElementById('crosshair'),
      dashcd: document.getElementById('dashcd'),
      upgradeScreen: document.getElementById('upgradeScreen'),
      upgradeCards: document.getElementById('upgradeCards'),
      bossbar: document.getElementById('bossbar'),
      bossLabel: document.querySelector('#bossbar .label'),
      bossFill: document.querySelector('#bossbar .fill'),
      tutorial: document.getElementById('tutorial'),
      statsScreen: document.getElementById('statsScreen'),
      stKills: document.getElementById('stKills'),
      stGames: document.getElementById('stGames'),
      stWave: document.getElementById('stWave'),
      killslabel: document.getElementById('killslabel'),
      target: document.getElementById('target'),
      winTitle: document.getElementById('winTitle'),
      start: document.getElementById('startScreen'),
      settings: document.getElementById('settingsScreen'),
      death: document.getElementById('deathScreen'),
      deathTip: document.getElementById('deathTip'),
      win: document.getElementById('winScreen'),
      winStat: document.getElementById('winStat'),
      loadbarwrap: document.getElementById('loadbarwrap'),
      loadbar: document.getElementById('loadbar'),
      loadtext: document.getElementById('loadtext')
    };
    this._feedTimer = null;
    this._lastHp = -1;
  }

  showGame(on) { this.el.hud.classList.toggle('on', on); }

  loadingProgress(p, label) {
    this.el.loadbarwrap.style.visibility = 'visible';
    this.el.loadbar.style.width = Math.round(p * 100) + '%';
    if (label) this.el.loadtext.textContent = '加载中：' + label;
  }

  setHealth(hp) {
    if (hp === this._lastHp) return;
    this._lastHp = hp;
    this.el.healthnum.textContent = hp;
    this.el.hpfill.style.width = hp + '%';
    this.el.hpfill.classList.toggle('low', hp <= 30);
  }

  setAmmo(mag, reserve, reloading, reloadPct) {
    const key = `${mag}|${reserve}|${reloading}`;
    if (key === this._lastAmmoKey) return; // 值没变就不动 DOM
    this._lastAmmoKey = key;
    this.el.ammo.innerHTML = `${mag} <small>/ ${reserve}</small>`;
    this.el.reloadtip.textContent = reloading ? `换弹中 ${Math.round(reloadPct * 100)}%` : (mag === 0 ? '按 R 换弹' : '');
  }

  setKills(k, target) {
    this.el.kills.textContent = k;
    this.el.kills.style.color = k >= target ? '#8fe3ff' : '';
  }

  setCrosshairGap(px) {
    const v = Math.round(px * 2) / 2;
    if (v === this._lastGap) return;
    this._lastGap = v;
    this.el.crosshair.style.setProperty('--gap', v.toFixed(1) + 'px');
  }

  setLockHint(on) {
    this.el.lockhint.style.display = on ? 'block' : 'none';
  }

  setFps(n) {
    this.el.fps.textContent = n + ' FPS';
  }

  showFps(on) {
    this.el.fps.style.display = on ? 'block' : 'none';
  }

  setScope(on) {
    this.el.scope.style.display = on ? 'block' : 'none';
    this.el.crosshair.style.display = on ? 'none' : 'block';
  }

  setDash(text) {
    this.el.dashcd.textContent = text || '';
  }

  // 强化卡三选一：cards 为 upgrades 定义，onPick(i) 回调
  showUpgradeCards(cards, taken, onPick) {
    this._cards = cards;
    this._onPick = onPick;
    const wrap = this.el.upgradeCards;
    wrap.innerHTML = '';
    cards.forEach((u, i) => {
      const div = document.createElement('div');
      div.className = 'ucard ' + u.rarity;
      const stacks = (taken && taken[u.id]) ? `<span style="opacity:.6">（已持 ${taken[u.id]}）</span>` : '';
      div.innerHTML = `
        <span class="ukey">${i + 1}</span>
        <div class="uname">${u.name}</div>
        <div class="udesc">${u.desc}</div>
        <div class="urare">${{ common: '常 见', rare: '稀 有', epic: '史 诗' }[u.rarity] || ''}${stacks}</div>`;
      div.addEventListener('click', () => this.pickCard(i));
      wrap.appendChild(div);
    });
    this.el.upgradeScreen.classList.remove('hidden');
  }

  pickCard(i) {
    if (!this._onPick) return;
    const cb = this._onPick;
    this._onPick = null;
    this.el.upgradeScreen.classList.add('hidden');
    cb(i);
  }

  // 顶部战况（经典=击杀/目标；生存=波次/剩余敌人）
  setTopStat(label, big, sub) {
    if (this.el.killslabel.textContent !== label) this.el.killslabel.textContent = label;
    if (this._lastBig !== big) {
      this._lastBig = big;
      this.el.kills.textContent = big;
    }
    if (this._lastSub !== sub) {
      this._lastSub = sub;
      this.el.target.textContent = sub;
    }
  }

  setWinTitle(t) {
    this.el.winTitle.textContent = t;
  }

  // 伤害飘字：世界坐标投影到屏幕，向上飘散
  spawnDamage(camera, worldPos, amount, head) {
    if (this._dmgs === undefined) this._dmgs = 0;
    const v = worldPos.clone().project(camera);
    if (v.z > 1) return; // 在相机背后
    const x = (v.x * 0.5 + 0.5) * window.innerWidth + (Math.random() - 0.5) * 36;
    const y = (-v.y * 0.5 + 0.5) * window.innerHeight + (Math.random() - 0.5) * 20;
    const el = document.createElement('div');
    el.className = 'dmg' + (head ? ' head' : '');
    el.textContent = head ? amount + '!' : amount;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    this.el.dmglayer.appendChild(el);
    setTimeout(() => el.remove(), 750);
    // 上限保护：超过 24 个时立即清理最老的
    if (++this._dmgs > 24) {
      const old = this.el.dmglayer.firstChild;
      if (old) old.remove();
    }
  }

  hitmarker(kill) {
    const el = this.el.hitmarker;
    el.classList.remove('show', 'kill');
    void el.offsetWidth; // 重启动画
    if (kill) el.classList.add('kill');
    el.classList.add('show');
  }

  damageFlash() {
    const el = this.el.vignette;
    el.style.transition = 'none';
    el.style.opacity = '1';
    void el.offsetWidth;
    el.style.transition = 'opacity .5s';
    el.style.opacity = '0';
  }

  healFlash() {
    const el = this.el.healflash;
    el.style.transition = 'none';
    el.style.opacity = '1';
    void el.offsetWidth;
    el.style.transition = 'opacity .6s';
    el.style.opacity = '0';
  }

  killfeed(text) {
    const el = this.el.killfeed;
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(this._feedTimer);
    this._feedTimer = setTimeout(() => { el.style.opacity = '0'; }, 1800);
  }

  showScreen(name) {
    this.el.start.classList.toggle('hidden', name !== 'start');
    this.el.settings.classList.toggle('hidden', name !== 'settings');
    this.el.statsScreen.classList.toggle('hidden', name !== 'stats');
    this.el.death.classList.toggle('hidden', name !== 'death');
    this.el.win.classList.toggle('hidden', name !== 'win');
  }

  setBossBar(label, pct) {
    if (!label) { this.el.bossbar.style.display = 'none'; return; }
    this.el.bossbar.style.display = 'block';
    if (this._lastBossLabel !== label) {
      this._lastBossLabel = label;
      this.el.bossLabel.textContent = label;
    }
    const v = Math.round(Math.max(0, Math.min(1, pct)) * 100);
    if (v !== this._lastBossPct) {
      this._lastBossPct = v;
      this.el.bossFill.style.width = v + '%';
    }
  }

  setTutorial(text) {
    const el = this.el.tutorial;
    if (!text) { el.style.display = 'none'; return; }
    el.textContent = text;
    el.style.display = 'block';
  }

  showStats(stats) {
    this.el.stKills.textContent = stats.kills;
    this.el.stGames.textContent = stats.games;
    this.el.stWave.textContent = `第 ${stats.bestWave} 波`;
    this.el.statsScreen.classList.remove('hidden');
  }

  setWeapon(name, idx, count) {
    if (this._lastWpn === name) return;
    this._lastWpn = name;
    this.el.weaponname.innerHTML = `${idx + 1}/${count} · ${name} <small>[1 2 3 切换]</small>`;
  }

  deathCountdown(sec) {
    this.el.deathTip.textContent = `${sec} 秒后重新部署…`;
  }

  winStats(text) {
    this.el.winStat.textContent = text;
  }
}
