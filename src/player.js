import * as THREE from 'three';

// AABB 位移解算：逐轴移动并推出碰撞体。玩家和敌人共用。
// pos 是脚底中心点。返回是否着地。
export function moveWithCollisions(pos, vel, dt, r, h, colliders) {
  const EPS = 0.001;
  let grounded = false;

  const overlaps = (p) => {
    const hits = [];
    const minx = p.x - r, maxx = p.x + r, miny = p.y, maxy = p.y + h, minz = p.z - r, maxz = p.z + r;
    for (const c of colliders) {
      if (minx < c.max.x && maxx > c.min.x &&
          miny < c.max.y && maxy > c.min.y &&
          minz < c.max.z && maxz > c.min.z) hits.push(c);
    }
    return hits;
  };

  // X 轴
  pos.x += vel.x * dt;
  for (const c of overlaps(pos)) {
    if (vel.x > 0) pos.x = c.min.x - r - EPS;
    else if (vel.x < 0) pos.x = c.max.x + r + EPS;
    vel.x = 0;
  }
  // Z 轴
  pos.z += vel.z * dt;
  for (const c of overlaps(pos)) {
    if (vel.z > 0) pos.z = c.min.z - r - EPS;
    else if (vel.z < 0) pos.z = c.max.z + r + EPS;
    vel.z = 0;
  }
  // Y 轴
  const prevBottom = pos.y;
  pos.y += vel.y * dt;
  if (pos.y <= 0) { pos.y = 0; vel.y = 0; grounded = true; } // 大地板
  for (const c of overlaps(pos)) {
    if (vel.y <= 0 && prevBottom >= c.max.y - 0.01) {
      pos.y = c.max.y; vel.y = 0; grounded = true;      // 落到箱顶
    } else if (vel.y > 0 && prevBottom + h <= c.min.y + 0.01) {
      pos.y = c.min.y - h - EPS; vel.y = 0;              // 顶头
    }
    // 其他情况：侧向重叠留给 X/Z 轴处理
  }
  return grounded;
}

const GRAVITY = 22;
const JUMP_V = 8;
const WALK_SPEED = 6.2;
const ADS_SPEED = 3.4;
const GROUND_ACCEL = 14;
const AIR_ACCEL = 3;
const EYE = 1.62;
const RADIUS = 0.36;
const HEIGHT = 1.78;

export class Player {
  constructor(camera) {
    this.camera = camera;
    this.pos = new THREE.Vector3(0, 0, 20);
    this.vel = new THREE.Vector3();
    this.yaw = 0;      // 水平朝向（弧度）
    this.pitch = 0;    // 俯仰
    this.recoil = 0;   // 后坐力累计（会自动回落一部分）
    this.grounded = true;
    this.health = 100;
    this.alive = true;
    this.ads = false;
    this.fov = 75;
    this.bobPhase = 0;
    this.bobAmp = 0;
    this.keys = new Set();
    this.onDamage = null;   // (amount, fromPos) => {}
    this.protectT = 0;      // 重生保护剩余时间（秒）
    this.sens = 1;          // 灵敏度倍率（设置）
    this.invertY = false;   // 反转Y轴（设置）
    this.baseFov = 75;      // 基础视场角（设置）
    this.adsFovMult = 0.69; // 机瞄 FOV 倍率（由当前武器决定）
    this.shakeAmp = 0;      // 受击屏幕震动强度
    this.maxHp = 100;       // 最大生命（肉鸽强化可增加）
    this.moveMult = 1;      // 移速倍率（肉鸽强化）
    this.extraJumps = 0;    // 额外跳跃次数（二段跳强化）
    this.jumpsUsed = 0;
    this.hasDash = false;   // 冲刺强化
    this.dashCdMult = 1;
    this.dashCd = 0;
    this.dashT = 0;
    this.dashDir = new THREE.Vector3();
    this._spacePrev = false;
    this._qPrev = false;
    this.onStep = null;     // 脚步声回调（main 注入）
    this._stepAcc = 0;
  }

  get sensScale() {
    // 机瞄灵敏度随倍率自适应：狙击（0.42）比步枪（0.69）转得更慢
    return this.ads ? 0.55 * (this.adsFovMult / 0.69) : 1;
  }
  get eyePos() {
    return new THREE.Vector3(this.pos.x, this.pos.y + EYE, this.pos.z);
  }

  look(dx, dy) {
    const s = 0.0021 * this.sensScale * this.sens;
    this.yaw -= dx * s;
    this.pitch -= dy * s * (this.invertY ? -1 : 1);
    const lim = Math.PI / 2 - 0.02;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
  }

  applyRecoil(kick) {
    this.recoil = Math.min(this.recoil + kick, 0.14); // 弧度，约 8° 上限
  }

  // 受击屏幕震动（随时间衰减）
  addShake(amp) {
    this.shakeAmp = Math.min(0.4, this.shakeAmp + amp);
  }

  damage(amount, fromPos) {
    if (!this.alive || this.protectT > 0) return false;
    this.health = Math.max(0, this.health - amount);
    if (this.health <= 0) { this.alive = false; }
    this.onDamage && this.onDamage(amount, fromPos);
    return !this.alive;
  }

  heal(amount) {
    if (!this.alive) return;
    this.health = Math.min(this.maxHp, this.health + amount);
  }

  respawn(at) {
    this.pos.copy(at);
    this.vel.set(0, 0, 0);
    this.health = this.maxHp;
    this.alive = true;
    this.recoil = 0;
    this.protectT = 2.5; // 出生保护：2.5 秒无敌，防重生即被围殴
    this.dashT = 0;
    this.dashCd = 0;
  }

  update(dt) {
    const k = this.keys;
    let fx = 0, fz = 0;
    if (k.has('KeyW')) fz -= 1;
    if (k.has('KeyS')) fz += 1;
    if (k.has('KeyA')) fx -= 1;
    if (k.has('KeyD')) fx += 1;

    // 冲刺：按住 Shift 且在移动（与机瞄互斥）
    this.sprinting = (k.has('ShiftLeft') || k.has('ShiftRight')) && (fx !== 0 || fz !== 0) && !this.ads;

    // 朝向系→世界系
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let wx = fx * cos + fz * sin;
    let wz = -fx * sin + fz * cos;
    const len = Math.hypot(wx, wz);
    if (len > 0) { wx /= len; wz /= len; }

    const speed = (this.sprinting ? WALK_SPEED * 1.55 : (this.ads ? ADS_SPEED : WALK_SPEED)) * this.moveMult;
    const accel = this.grounded ? GROUND_ACCEL : AIR_ACCEL;
    this.vel.x += (wx * speed - this.vel.x) * Math.min(1, accel * dt);
    this.vel.z += (wz * speed - this.vel.z) * Math.min(1, accel * dt);

    // 跳跃（支持二段跳：落地重置计数）
    const spaceNow = k.has('Space');
    if (spaceNow && !this._spacePrev) {
      if (this.grounded) {
        this.vel.y = JUMP_V; this.grounded = false; this.jumpsUsed = 1;
      } else if (this.jumpsUsed < 1 + this.extraJumps) {
        this.vel.y = JUMP_V * 0.92; this.jumpsUsed++;
      }
    }
    this._spacePrev = spaceNow;

    // 相位冲刺（Q）：朝移动方向瞬移，冷却期间不可用
    this.dashCd = Math.max(0, this.dashCd - dt);
    const qNow = k.has('KeyQ');
    if (qNow && !this._qPrev && this.hasDash && this.dashCd <= 0) {
      const d = new THREE.Vector3(wx, 0, wz);
      if (d.lengthSq() < 0.01) d.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      this.dashDir.copy(d.normalize());
      this.dashT = 0.14;
      this.dashCd = 2.2 * this.dashCdMult;
    }
    this._qPrev = qNow;

    this.vel.y -= GRAVITY * dt;
    if (this.dashT > 0) {
      // 冲刺期间锁定水平速度、悬停
      this.dashT -= dt;
      this.vel.x = this.dashDir.x * 24;
      this.vel.z = this.dashDir.z * 24;
      this.vel.y = 0;
    }

    this.grounded = moveWithCollisions(this.pos, this.vel, dt, RADIUS, HEIGHT, this.colliders || []);

    // 走路视角摆动
    const hspeed = Math.hypot(this.vel.x, this.vel.z);
    const targetAmp = this.grounded ? Math.min(1, hspeed / WALK_SPEED) * (this.ads ? 0.008 : 0.02) : 0;
    this.bobAmp += (targetAmp - this.bobAmp) * Math.min(1, 10 * dt);
    this.bobPhase += hspeed * dt * 1.6;
    // 脚步声：按移动距离触发（奔跑更密）
    if (this.grounded && hspeed > 2 && this.onStep) {
      this._stepAcc += hspeed * dt;
      if (this._stepAcc >= (this.sprinting ? 2.6 : 2.2)) {
        this._stepAcc = 0;
        this.onStep();
      }
    }

    // 后坐力回落（软回落，打完自动压回一半左右）
    this.recoil = Math.max(0, this.recoil - this.recoil * 6 * dt - 0.004 * dt);
    if (this.protectT > 0) this.protectT -= dt;

    // FOV（机瞄拉近；冲刺小幅拉伸速度感）
    const targetFov = (this.ads ? this.baseFov * this.adsFovMult : this.baseFov)
      + (this.sprinting ? 6 : 0);
    this.fov += (targetFov - this.fov) * Math.min(1, 14 * dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }

    // 相机位姿
    const bobY = Math.sin(this.bobPhase * 2) * this.bobAmp;
    const bobX = Math.cos(this.bobPhase) * this.bobAmp * 0.8;
    this.camera.position.set(
      this.pos.x + bobX * Math.cos(this.yaw),
      this.pos.y + EYE + bobY,
      this.pos.z - bobX * Math.sin(this.yaw)
    );
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch + this.recoil);
    this.camera.rotateZ(bobX * 0.35);
    // 受击震动
    if (this.shakeAmp > 0.002) {
      this.camera.position.x += (Math.random() - 0.5) * this.shakeAmp * 0.24;
      this.camera.position.y += (Math.random() - 0.5) * this.shakeAmp * 0.24;
      this.shakeAmp = Math.max(0, this.shakeAmp - dt * 1.4);
    }
  }
}
