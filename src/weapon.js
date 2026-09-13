import * as THREE from 'three';

// ================= 武器配置 =================
export const WEAPON_CONFIGS = [
  {
    name: '脉冲步枪', model: 'blaster-c', sound: 'shot', yaw: Math.PI,
    rpm: 550, dmg: 34, mag: 30, reserve: 90, auto: true,
    spreadHip: 0.017, spreadAds: 0.005, bloom: 0.0075, recoil: 0.011,
    adsZoom: 0.69, flashInt: 2.4, tracer: 0xffe08a
  },
  {
    name: '蜂刺冲锋枪', model: 'blaster-f', sound: 'shotSMG', yaw: 0,
    rpm: 900, dmg: 20, mag: 40, reserve: 120, auto: true,
    spreadHip: 0.026, spreadAds: 0.010, bloom: 0.005, recoil: 0.006,
    adsZoom: 0.78, flashInt: 1.8, tracer: 0xa8e6ff
  },
  {
    name: '重击狙击', model: 'blaster-r', sound: 'shotSniper', yaw: 0,
    rpm: 70, dmg: 95, mag: 8, reserve: 24, auto: false,
    spreadHip: 0.05, spreadAds: 0.0012, bloom: 0.02, recoil: 0.05,
    adsZoom: 0.42, flashInt: 4.5, tracer: 0xff9d6c
  }
];

const RELOAD_TIME = 1.6;
const SWITCH_TIME = 0.4;
const MOVE_SPREAD = 0.011;
const BLOOM_MAX = 0.05;
const BLOOM_DECAY = 0.10;
const HEADSHOT_DMG = 100;
const VM_POS_HIP = new THREE.Vector3(0.26, -0.22, -0.48);
const VM_POS_ADS = new THREE.Vector3(0, -0.155, -0.34);
const BLASTER_YAW = Math.PI;

// 构建一个居中、长度归一化的第一人称枪模型组（yaw 修正不同枪模的自身朝向）
function buildViewModel(gunScene, yaw = Math.PI) {
  const gunInner = gunScene.clone(true);
  const normBox = new THREE.Box3().setFromObject(gunInner);
  const normSize = normBox.getSize(new THREE.Vector3());
  gunInner.scale.setScalar(0.55 / Math.max(normSize.x, normSize.y, normSize.z));
  const rawBox = new THREE.Box3().setFromObject(gunInner);
  const rawCenter = rawBox.getCenter(new THREE.Vector3());
  gunInner.position.sub(rawCenter);

  const vm = new THREE.Group();
  vm.add(gunInner);
  vm.rotation.y = yaw;

  vm.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(vm);
  const bc = box.getCenter(new THREE.Vector3());
  const muzzle = new THREE.Object3D();
  muzzle.position.set(bc.x, bc.y, box.min.z + 0.02);
  vm.add(muzzle);
  vm.userData.muzzle = muzzle;
  vm.userData.yaw = yaw;
  return vm;
}

export class Weapon {
  // gunScenes: { blaster-c: scene, blaster-f: scene, blaster-r: scene }
  constructor(camera, gunScenes, effects, sound) {
    this.camera = camera;
    this.effects = effects;
    this.sound = sound;
    this.player = null;
    this.onHit = null;
    this.onShotFired = null;
    this.idx = 0;
    this.switchT = 0;        // 切枪动作剩余时间
    this.pendingIdx = -1;
    this.kick = 0;
    this.kickRot = 0;
    this.swayX = 0; this.swayY = 0;
    this.cooldown = 0;
    this.bloom = 0;
    this.adsActive = false;
    this.runMods = null;     // main 注入的局内成长属性（肉鸽强化）
    this._prevFire = false;
    this._dir = new THREE.Vector3();
    this._ray = new THREE.Raycaster();

    this.weapons = WEAPON_CONFIGS.map(cfg => {
      const vm = buildViewModel(gunScenes[cfg.model], cfg.yaw);
      vm.visible = false;
      camera.add(vm);
      return {
        cfg, vm, muzzle: vm.userData.muzzle,
        ammo: cfg.mag, reserve: cfg.reserve,
        reloading: false, reloadT: 0
      };
    });
    this.cur().vm.visible = true;
  }

  cur() { return this.weapons[this.idx]; }

  // 当前武器的弹匣上限（扩容强化生效）
  magSize() {
    const w = this.cur();
    return Math.round(w.cfg.mag * (this.runMods ? this.runMods.magMult : 1));
  }

  switchTo(i) {
    if (i === this.idx || i < 0 || i >= this.weapons.length) return;
    if (this.switchT > 0) return;
    this.pendingIdx = i;
    this.switchT = SWITCH_TIME;
    this.sound.play('reload', { volume: 0.45, pitch: 1.3 });
  }

  cycle(dir) {
    this.switchTo((this.idx + dir + this.weapons.length) % this.weapons.length);
  }

  magSizeFor(w) {
    return Math.round(w.cfg.mag * (this.runMods ? this.runMods.magMult : 1));
  }

  startReload() {
    const w = this.cur();
    const max = this.magSizeFor(w);
    if (w.reloading || w.ammo >= max || w.reserve <= 0) return;
    w.reloading = true;
    w.reloadT = RELOAD_TIME / (this.runMods ? this.runMods.reloadMult : 1);
    this.sound.play('reload', { volume: 0.7 });
  }

  resetAmmo() {
    for (const w of this.weapons) {
      w.ammo = this.magSizeFor(w);
      w.reserve = w.cfg.reserve;
      w.reloading = false;
      w.reloadT = 0;
    }
    this.bloom = 0;
    this.cooldown = 0;
  }

  get spread() {
    const w = this.cur();
    const base = this.adsActive ? w.cfg.spreadAds : w.cfg.spreadHip;
    const sprint = this.player && this.player.sprinting ? 0.022 : 0; // 奔跑时精度骤降
    return base + this.bloom + sprint;
  }

  crosshairGap() {
    return 5 + this.spread * 240;
  }

  tryFire(targets) {
    const w = this.cur();
    const mods = this.runMods || { dmgMult: 1, rpmMult: 1, critChance: 0, pierce: 0 };
    if (this.cooldown > 0 || w.reloading || this.switchT > 0) return;
    if (w.ammo <= 0) { this.startReload(); return; }
    this.cooldown = 60 / (w.cfg.rpm * mods.rpmMult);
    w.ammo--;
    this.onShotFired && this.onShotFired();

    // 弹道：视线 + 散布
    this.camera.getWorldDirection(this._dir);
    const sp = this.spread;
    this._dir.x += (Math.random() - 0.5) * 2 * sp;
    this._dir.y += (Math.random() - 0.5) * 2 * sp;
    this._dir.z += (Math.random() - 0.5) * 2 * sp;
    this._dir.normalize();

    this._ray.set(this.camera.getWorldPosition(new THREE.Vector3()), this._dir);
    this._ray.far = 200;
    const hits = this._ray.intersectObjects(targets, false);
    if (window.__shotDbg !== undefined) {
      const h0 = hits[0];
      window.__shotDbg = `h${hits.length}${h0 ? (h0.object.userData.enemyRef ? 'E' : 'W') : ''}`;
    }

    // 穿透弹：最多命中 1+pierce 名敌人才被阻挡（墙体始终阻挡）
    const allowEnemies = 1 + (mods.pierce || 0);
    let applied = 0;
    let end = this._ray.ray.origin.clone().addScaledVector(this._dir, 120);
    let worldHit = null;
    this.camera.updateMatrixWorld(true);
    const mz = w.muzzle.getWorldPosition(new THREE.Vector3());

    for (const h of hits) {
      const enemy = h.object.userData.enemyRef;
      if (enemy && enemy.alive) {
        const crit = Math.random() < (mods.critChance || 0);
        const head = !!h.object.userData.head;
        let dmg = head ? HEADSHOT_DMG : w.cfg.dmg;
        dmg *= mods.dmgMult;
        if (crit) dmg *= 2;
        dmg = Math.round(dmg);
        const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : null;
        this.effects.sparks(h.point, n);
        this.onHit && this.onHit({ type: 'enemy', enemy, point: h.point, normal: n, damage: dmg, head, crit });
        applied++;
        if (applied >= allowEnemies) { end = h.point; worldHit = h; break; }
      } else {
        end = h.point; worldHit = h; break; // 墙体/道具阻挡
      }
    }

    this.effects.tracer(mz, end, w.cfg.tracer);
    this.effects.flash(mz, w.cfg.flashInt, w.cfg.flashInt > 3 ? 9 : 6, 0.05);
    if (worldHit) {
      const n = worldHit.face ? worldHit.face.normal.clone().transformDirection(worldHit.object.matrixWorld) : null;
      this.effects.sparks(end, n);
    }

    this.player && this.player.applyRecoil(w.cfg.recoil + this.bloom * 0.05);
    this.kick = Math.min(this.kick + 0.055, 0.12);
    this.kickRot = Math.min(this.kickRot + 0.09, 0.22);
    this.bloom = Math.min(this.bloom + w.cfg.bloom, BLOOM_MAX);

    this.sound.play(w.cfg.sound, { pitch: 1 + (Math.random() - 0.5) * 0.12, volume: 0.85 });
    if (w.ammo <= 0) this.startReload();
  }

  update(dt, input, targets) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.bloom = Math.max(0, this.bloom - BLOOM_DECAY * dt);

    const w = this.cur();

    // 切枪动作
    if (this.switchT > 0) {
      this.switchT -= dt;
      if (this.switchT <= SWITCH_TIME / 2 && this.pendingIdx >= 0) {
        this.cur().vm.visible = false;
        this.idx = this.pendingIdx;
        this.pendingIdx = -1;
        const nw = this.cur();
        nw.reloading = false; // 切枪打断换弹
        nw.vm.visible = true;
        if (this.player) this.player.adsFovMult = nw.cfg.adsZoom;
        this.onSwitch && this.onSwitch();
      }
    }

    // 换弹
    if (w.reloading) {
      w.reloadT -= dt;
      if (w.reloadT <= 0) {
        const need = this.magSizeFor(w) - w.ammo;
        const take = Math.min(need, w.reserve);
        w.ammo += take;
        w.reserve -= take;
        w.reloading = false;
      }
    }

    this.adsActive = input.ads && !w.reloading && this.switchT <= 0;
    if (this.player) this.player.ads = this.adsActive;

    // 开火（auto 武器按住连发；半自动武器松开才能再扣）
    const firePressed = input.fire && (w.cfg.auto || !this._prevFire);
    this._prevFire = input.fire;
    if (firePressed && !w.reloading && this.switchT <= 0) this.tryFire(targets);

    // ---- 视图模型动画 ----
    this.kick = Math.max(0, this.kick - this.kick * 14 * dt - 0.02 * dt);
    this.kickRot = Math.max(0, this.kickRot - this.kickRot * 12 * dt - 0.02 * dt);

    this.swayX += ((-input.lookDX * 0.00035) - this.swayX) * Math.min(1, 10 * dt);
    this.swayY += ((-input.lookDY * 0.00035) - this.swayY) * Math.min(1, 10 * dt);
    input.lookDX = 0; input.lookDY = 0;

    const target = this.adsActive ? VM_POS_ADS : VM_POS_HIP;
    const bob = this.player ? this.player.bobAmp : 0;
    const bobPhase = this.player ? this.player.bobPhase : 0;
    const switching = this.switchT > 0;
    const swT = switching ? Math.sin((this.switchT / SWITCH_TIME) * Math.PI) : 0;

    let px = target.x + this.swayX + Math.cos(bobPhase) * bob * 0.4;
    let py = target.y + this.swayY + Math.sin(bobPhase * 2) * bob - swT * 0.3;
    let pz = target.z + this.kick;
    let rx = this.kickRot + swT * 0.6, ry = 0, rz = 0;

    if (w.reloading) {
      const t = 1 - Math.abs(w.reloadT / RELOAD_TIME - 0.5) * 2;
      py -= 0.16 * t;
      rx += 0.7 * t;
      rz += 0.35 * t;
    }

    const lerpK = Math.min(1, (this.adsActive ? 16 : 12) * dt);
    w.vm.position.x += (px - w.vm.position.x) * lerpK;
    w.vm.position.y += (py - w.vm.position.y) * lerpK;
    w.vm.position.z += (pz - w.vm.position.z) * lerpK;
    w.vm.rotation.x += (rx - w.vm.rotation.x) * lerpK;
    w.vm.rotation.y += ((ry + (w.vm.userData.yaw || 0)) - w.vm.rotation.y) * lerpK;
    w.vm.rotation.z += (rz - w.vm.rotation.z) * lerpK;
  }
}
