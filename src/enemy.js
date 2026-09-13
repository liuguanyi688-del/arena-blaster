import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { moveWithCollisions } from './player.js';

// ================= 参数 =================
// 敌人强度刻意压制：爽杀体验优先，玩家永远有操作空间
const PATROL_SPEED = 2.4;
const CHASE_SPEED = 4.6;
const STRAFE_SPEED = 2.8;
const VISION_DIST = 22;
const ATTACK_DIST = 15;
const BOLT_SPEED = 34;
const BOLT_DMG = 8;
const BURST = 3;
const BURST_GAP = 0.2;
const ATTACK_COOLDOWN = 1.9;      // 攻速削弱：更长的攻击间隔
const ENEMY_R = 0.38;
const ENEMY_H = 1.7;
const ENEMY_HP = 100;
const RESPAWN_TIME = 3.5;

const SKINS = [
  './assets/animated-characters-protagonists/Skins/criminalMaleA.png',
  './assets/animated-characters-protagonists/Skins/cyborgFemaleA.png',
  './assets/animated-characters-protagonists/Skins/skaterFemaleA.png',
  './assets/animated-characters-protagonists/Skins/skaterMaleA.png'
];

// 兵种差异化：属性/皮肤/体型（数值刻意温和，保爽杀体验）
const ENEMY_TYPES = {
  grunt: { label: '突击兵', hp: 1, speed: 1, dmg: 1, scale: 1, skin: 1 },            // cyborg
  swift: { label: '冲锋兵', hp: 0.65, speed: 1.4, dmg: 0.8, scale: 0.94, skin: 2 }, // skaterF 冲锋
  heavy: { label: '重装兵', hp: 2.6, speed: 0.6, dmg: 1.45, scale: 1.16, skin: 0 }, // criminal 重装
  boss: { label: 'BOSS·重装指挥官', hp: 9, speed: 0.75, dmg: 1.6, scale: 2.1, skin: 3, boss: true }
};

let boltGeo = null, boltMat = null;
function makeBoltMesh() {
  if (!boltGeo) {
    boltGeo = new THREE.BoxGeometry(0.07, 0.07, 0.55);
    boltMat = new THREE.MeshBasicMaterial({ color: 0xff6a4d, blending: THREE.AdditiveBlending, depthWrite: false });
  }
  const m = new THREE.Mesh(boltGeo, boltMat);
  return m;
}

export class Enemy {
  constructor(id, scene, templates, level, player, effects, sound, hooks) {
    this.id = id;
    this.scene = scene;
    this.level = level;
    this.player = player;
    this.effects = effects;
    this.sound = sound;
    this.hooks = hooks;            // {onPlayerHit, onEnemyDied}
    this.alive = true;
    this.hp = ENEMY_HP;
    this.state = 'PATROL';
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.facing = 0;
    this.patrolTarget = new THREE.Vector3();
    this.patrolWait = 0;
    this.aggro = false;            // 是否已发现/记住玩家
    this.loseTimer = 0;
    this.strafeDir = 1;
    this.strafeTimer = 0;
    this.burstLeft = 0;
    this.shotTimer = 0;
    this.attackCd = 1 + Math.random();
    this.visionTimer = Math.random() * 0.2;
    this.playerVisible = false;
    this.flashT = 0;
    this.deathT = -1;              // >=0 表示死亡动画进行中
    this.respawnT = -1;
    this.speedMul = 0.88 + Math.random() * 0.3; // 每个敌人速度略有差异，行为不千篇一律
    this.survivalMode = false;     // 生存模式下死亡不自动复活（等下一波）
    this.statMult = { hp: 1, speed: 1, dmg: 1, acc: 1 };

    // ---- 模型 ----
    this.root = new THREE.Group();
    this.model = SkeletonUtils.clone(templates.char);
    // 统一到 1.7 米高
    const bbox = new THREE.Box3().setFromObject(this.model);
    const h = bbox.getSize(new THREE.Vector3()).y;
    this.model.scale.setScalar(ENEMY_H / h);
    this.model.position.y = 0;

    // 皮肤贴图（每个敌人独立材质，便于闪烁/淡出）；兵种可在 spawnAt 时换肤
    this.skinTextures = templates.skins;
    const skinTex = this.skinTextures[id % this.skinTextures.length];
    this.mats = [];
    this.hitMeshes = [];
    this.model.traverse(o => {
      if (o.isMesh || o.isSkinnedMesh) {
        o.material = new THREE.MeshStandardMaterial({ map: skinTex, roughness: 0.75 });
        o.material.transparent = true;
        this.mats.push(o.material);
      }
    });

    // 命中判定用隐形碰撞盒（CS 式 hitbox）：SkinnedMesh 的射线检测不可靠，
    // 用盒子稳定且支持爆头。挂在反向缩放的组里，保证米制尺寸。
    const hb = new THREE.Group();
    hb.scale.setScalar(1 / this.model.scale.x);
    this.model.add(hb);
    const bodyBox = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.3, 0.45));
    bodyBox.position.y = 0.72;
    const headBox = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.34));
    headBox.position.y = 1.56;
    for (const m of [bodyBox, headBox]) {
      m.visible = false; // three.js 射线检测不跳过不可见网格
      m.userData.enemyRef = this;
      if (m === headBox) m.userData.head = true;
      hb.add(m);
      this.hitMeshes.push(m);
    }

    // 手上的枪：直接挂在模型根节点右手髋侧（FBX 骨骼命名/单位不可靠，
    // 挂骨骼会导致枪消失或比例诡异），尺寸归一化到 0.5m，枪口始终朝前。
    const gun = SkeletonUtils.clone(templates.gun);
    const gbox = new THREE.Box3().setFromObject(gun);
    const gsize = gbox.getSize(new THREE.Vector3());
    gun.scale.setScalar(0.5 / Math.max(gsize.x, gsize.y, gsize.z));
    const gc = new THREE.Box3().setFromObject(gun).getCenter(new THREE.Vector3());
    gun.position.sub(gc);
    const gunWrap = new THREE.Group();
    gunWrap.add(gun);
    const ms = this.model.scale.x;             // 模型可能有整体缩放（FBX 厘米/米单位差异）
    gunWrap.scale.setScalar(1 / ms);           // 内部保持米制
    gunWrap.position.set(0.26 / ms, 1.0 / ms, 0.22 / ms); // 位置同样换算：右手胸前，不再随缩放掉到脚底
    gunWrap.rotation.set(0.12, Math.PI, 0);    // 微微上抬，看起来像持枪
    this.gunTip = new THREE.Object3D();
    this.gunTip.position.set(0, 0.02, -0.42);
    gunWrap.add(this.gunTip);
    this.model.add(gunWrap);
    gun.traverse(o => {
      if (o.isMesh) {
        o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone();
        o.userData.enemyRef = this;
        this.mats.push(...[].concat(o.material));
      }
    });
    this.root.add(this.model);
    scene.add(this.root);

    // ---- 动画 ----
    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = {};
    for (const clip of templates.clips) {
      const name = clip.name.toLowerCase().includes('run') ? 'run' : 'idle';
      if (!this.actions[name]) this.actions[name] = this.mixer.clipAction(clip);
    }
    this.current = null;
    this.play('idle');

    this.pickPatrolTarget();
  }

  play(name) {
    if (this.current === name) return;
    const next = this.actions[name];
    if (!next) return;
    next.reset().fadeIn(0.18).play();
    if (this.current) this.actions[this.current].fadeOut(0.18);
    this.current = name;
  }

  pickPatrolTarget() {
    const H = this.level.half;
    for (let i = 0; i < 8; i++) {
      const x = (Math.random() * 2 - 1) * (H - 2.5);
      const z = (Math.random() * 2 - 1) * (H - 2.5);
      this.patrolTarget.set(x, 0, z);
      if (this.patrolTarget.distanceTo(this.player.pos) > 6) break;
    }
  }

  spawnAt(v, mult, type = 'grunt') {
    this.pos.copy(v);
    this.pos.x += (Math.random() - 0.5) * 2;
    this.pos.z += (Math.random() - 0.5) * 2;
    const t = ENEMY_TYPES[type] || ENEMY_TYPES.grunt;
    this.typeLabel = t.label;
    if (mult) this.statMult = mult;
    // 兵种修正叠加到波次倍率上
    this.statMult = {
      hp: (this.statMult.hp || 1) * t.hp,
      speed: (this.statMult.speed || 1) * t.speed,
      dmg: (this.statMult.dmg || 1) * t.dmg,
      acc: this.statMult.acc || 1
    };
    this.hp = ENEMY_HP * this.statMult.hp;
    this.maxHp = this.hp; // 血条用
    this.isBoss = !!t.boss;
    this.alive = true;
    this.aggro = false;
    this.state = 'PATROL';
    this.deathT = -1;
    this.respawnT = -1;
    this.flashT = 0;
    this.setOpacity(1);
    for (const m of this.mats) m.emissive.set(0x000000); // 复位受击红闪（死亡分支不会走到复位逻辑）
    // 兵种皮肤
    const tex = this.skinTextures[t.skin % this.skinTextures.length];
    for (const m of this.mats) { m.map = tex; m.needsUpdate = true; }
    // 兵种体型（缩放 root，不影响碰撞盒的反向缩放）
    this.root.scale.setScalar(t.scale);
    this.model.rotation.set(0, 0, 0);
    this.pickPatrolTarget();
    this.root.visible = true;
    this.play('idle');
  }

  setOpacity(v) {
    for (const m of this.mats) m.opacity = v;
  }

  damage(amount) {
    if (!this.alive) return;
    this.hp -= amount;
    this.flashT = 0.14;
    for (const m of this.mats) m.emissive = new THREE.Color(0xff2211);
    // 被打会立刻警觉
    this.aggro = true;
    this.loseTimer = 6;
    if (this.state === 'PATROL') this.state = 'CHASE';
    if (this.hp <= 0) this.die();
  }

  die() {
    this.alive = false;
    this.deathT = 0;
    this.vel.set(0, 0, 0);
    // 归还全局攻击名额（若正持有着）
    if (this._slotHeld && this.sharedAttack) { this.sharedAttack.attackers--; this._slotHeld = false; }
    this.burstLeft = 0;
    this.hooks.onEnemyDied && this.hooks.onEnemyDied(this);
    this.sound.playAt('explosion', this.pos.distanceTo(this.player.pos), 0.9);
    this.effects.smoke(this.pos.clone().add(new THREE.Vector3(0, 0.4, 0)), 5);
  }

  shoot() {
    const mz = this.gunTip.getWorldPosition(new THREE.Vector3());
    const target = this.player.eyePos;
    const dir = target.sub(mz).normalize();
    // 精度：距离越远越飘；acc 越高越准（生存模式后期提升）
    const err = (0.035 + this.pos.distanceTo(this.player.pos) * 0.0022) / (this.statMult.acc || 1);
    dir.x += (Math.random() - 0.5) * 2 * err;
    dir.y += (Math.random() - 0.5) * 1.4 * err;
    dir.z += (Math.random() - 0.5) * 2 * err;
    dir.normalize();
    this.spawnBolt(dir, this.statMult.dmg || 1);

    this.effects.flash(mz, 1.6, 4, 0.05);
    this.sound.playAt('shotEnemy', this.pos.distanceTo(this.player.pos), 0.75);
    // 开火后坐：身体轻轻一颤（程序动画）
    this.recoilT = 0.09;
  }

  // Boss 专属：朝玩家扇形弹幕（5 发）
  shootRadial() {
    const mz = this.gunTip.getWorldPosition(new THREE.Vector3());
    const target = this.player.eyePos;
    const baseDir = target.sub(mz).normalize();
    for (let k = -2; k <= 2; k++) {
      const dir = baseDir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), k * 0.13);
      dir.y += (Math.random() - 0.5) * 0.04;
      this.spawnBolt(dir.normalize(), this.statMult.dmg || 1);
    }
    this.effects.flash(mz, 3, 6, 0.06);
    this.sound.playAt('shotEnemy', this.pos.distanceTo(this.player.pos), 0.9);
    this.recoilT = 0.12;
  }

  spawnBolt(dir, dmgMult) {
    const bolt = makeBoltMesh();
    bolt.position.copy(this.gunTip.getWorldPosition(new THREE.Vector3()));
    this.scene.add(bolt);
    this.bolts = this.bolts || [];
    this.bolts.push({ mesh: bolt, vel: dir.clone().multiplyScalar(BOLT_SPEED), life: 2.2, dmg: dmgMult });
    this.effects.flash(bolt.position, 1.6, 4, 0.05);
  }

  updateBolts(dt) {
    if (!this.bolts) return;
    const _ray = new THREE.Raycaster();
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.life -= dt;
      const from = b.mesh.position.clone();
      const step = b.vel.clone().multiplyScalar(dt);
      const to = from.clone().add(step);

      let hit = false;
      // 打墙
      _ray.set(from, step.clone().normalize());
      _ray.far = step.length() + 0.1;
      const lv = _ray.intersectObjects(this.level.hitMeshes, false);
      if (lv.length > 0) {
        this.effects.sparks(lv[0].point, null);
        hit = true;
      }
      // 打玩家（点到线段距离）
      if (!hit && this.player.alive) {
        const pc = this.player.eyePos;
        const ab = to.clone().sub(from);
        const t = Math.max(0, Math.min(1, pc.clone().sub(from).dot(ab) / (ab.lengthSq() || 1)));
        const closest = from.clone().addScaledVector(ab, t);
        if (closest.distanceTo(pc) < 0.55) {
          const died = this.player.damage(Math.round((BOLT_DMG + Math.floor(Math.random() * 5)) * (b.dmg || 1)), from);
          this.hooks.onPlayerHit && this.hooks.onPlayerHit(died);
          hit = true;
        }
      }
      b.mesh.position.copy(to);
      b.mesh.lookAt(to.clone().add(b.vel));
      if (hit || b.life <= 0) {
        this.scene.remove(b.mesh);
        this.bolts.splice(i, 1);
      }
    }
  }

  // 视线检测：眼里到玩家眼里之间有没有墙
  canSeePlayer() {
    const eye = this.pos.clone().add(new THREE.Vector3(0, 1.5, 0));
    const pe = this.player.eyePos;
    const dir = pe.clone().sub(eye);
    const dist = dir.length();
    if (dist > VISION_DIST) return false;
    if (!this.player.alive) return false;
    this._ray || (this._ray = new THREE.Raycaster());
    this._ray.set(eye, dir.normalize());
    this._ray.far = dist - 0.3;
    const hits = this._ray.intersectObjects(this.level.hitMeshes, false);
    return hits.length === 0;
  }

  moveToward(target, speed, dt) {
    const dir = target.clone().sub(this.pos);
    dir.y = 0;
    const dist = dir.length();
    if (dist < 0.05) return 0;
    dir.normalize();

    // 避障探测节流：每 0.12s 才做一次射线检测（全场数百网格，每帧做太浪费）
    this.steerT = (this.steerT || 0) - dt;
    if (this.steerT <= 0) {
      this.steerT = 0.12;
      this._ray || (this._ray = new THREE.Raycaster());
      this._ray.set(this.pos.clone().add(new THREE.Vector3(0, 0.8, 0)), dir);
      this._ray.far = 1.3;
      this._steerBlocked = this._ray.intersectObjects(this.level.hitMeshes, false).length > 0;
      this._steerSide = Math.random() < 0.5 ? 1 : -1;
    }
    if (this._steerBlocked) {
      dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), this._steerSide * 1.2);
    }

    this.vel.x = dir.x * speed;
    this.vel.z = dir.z * speed;
    this.vel.y -= 22 * dt;
    moveWithCollisions(this.pos, this.vel, dt, ENEMY_R, ENEMY_H, this.level.colliders);
    return Math.atan2(dir.x, dir.z);
  }

  faceAngle(angle, dt, rate = 10) {
    let d = angle - this.facing;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.facing += d * Math.min(1, rate * dt);
  }

  update(dt) {
    // ---- 死亡 / 重生流程 ----
    if (!this.alive && this.deathT < 0 && this.respawnT <= 0) return; // 生存模式阵亡后保持退场
    if (this.respawnT > 0) {
      this.respawnT -= dt;
      if (this.respawnT <= 0) {
        const pts = this.level.enemySpawns;
        const far = pts.filter(p => p.distanceTo(this.player.pos) > 12);
        const p = (far.length ? far : pts)[Math.floor(Math.random() * (far.length ? far.length : pts.length))];
        this.spawnAt(p);
      }
      return;
    }
    if (this.deathT >= 0) {
      this.deathT += dt;
      // 倒地：0.45 秒转倒，之后冒烟淡出
      const fall = Math.min(1, this.deathT / 0.45);
      this.model.rotation.x = -(Math.PI / 2) * (fall * fall * (3 - 2 * fall));
      this.model.position.y = 0.15 * fall;
      if (this.deathT > 0.5 && Math.random() < dt * 6) {
        this.effects.smoke(this.pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.6, 0.3, (Math.random() - 0.5) * 0.6)), 1);
      }
      if (this.deathT > 1.4) {
        this.setOpacity(Math.max(0, 1 - (this.deathT - 1.4) / 0.9));
      }
      if (this.deathT > 2.4) {
        this.root.visible = false;
        this.deathT = -1;
        // 经典模式：倒计时后重生；生存模式：保持退场等下一波
        if (!this.survivalMode) this.respawnT = RESPAWN_TIME;
      }
      return;
    }
    if (!this.player.alive) {
      // 玩家死了：敌人原地待机
      this.play('idle');
      this.mixer.update(dt);
      return;
    }

    // ---- 感知 ----
    this.visionTimer -= dt;
    if (this.visionTimer <= 0) {
      this.visionTimer = 0.16;
      this.playerVisible = this.canSeePlayer();
      if (this.playerVisible) { this.aggro = true; this.loseTimer = 5; }
    }
    if (this.aggro) {
      this.loseTimer -= dt;
      if (this.loseTimer <= 0) { this.aggro = false; this.state = 'PATROL'; this.pickPatrolTarget(); }
    }

    const distP = this.pos.distanceTo(this.player.pos);

    // ---- 状态机 ----
    if (!this.aggro) {
      this.state = 'PATROL';
    } else if (this.playerVisible && distP < ATTACK_DIST) {
      this.state = 'ATTACK';
    } else {
      this.state = 'CHASE';
    }

    let moveAnim = false;
    if (this.state === 'PATROL') {
      this.patrolWait -= dt;
      if (this.patrolWait <= 0) {
        const ang = this.moveToward(this.patrolTarget, PATROL_SPEED * this.speedMul * (this.statMult.speed || 1), dt);
        if (ang !== 0) { this.faceAngle(ang, dt, 8); moveAnim = true; }
        if (this.pos.distanceTo(this.patrolTarget) < 1.2) {
          this.patrolWait = 0.8 + Math.random() * 1.6;
          this.pickPatrolTarget();
        }
      }
      if (!moveAnim) this.play('idle'); else this.play('run');
    } else if (this.state === 'CHASE') {
      const ang = this.moveToward(this.player.pos, CHASE_SPEED * this.speedMul * (this.statMult.speed || 1), dt);
      this.faceAngle(ang, dt, 10);
      this.play('run');
      moveAnim = true;
    } else { // ATTACK
      this.faceAngle(Math.atan2(this.player.pos.x - this.pos.x, this.player.pos.z - this.pos.z), dt, 12);
      // 左右横移拉扯
      this.strafeTimer -= dt;
      if (this.strafeTimer <= 0) {
        this.strafeTimer = 1.0 + Math.random() * 1.4;
        this.strafeDir = Math.random() < 0.5 ? 1 : -1;
      }
      const toP = this.player.pos.clone().sub(this.pos).setY(0).normalize();
      const side = new THREE.Vector3(-toP.z, 0, toP.x).multiplyScalar(this.strafeDir);
      const keep = distP < 5 ? toP.clone().multiplyScalar(-0.7) : (distP > ATTACK_DIST * 0.85 ? toP.clone().multiplyScalar(0.6) : new THREE.Vector3());
      const mv = side.multiplyScalar(STRAFE_SPEED * this.speedMul).add(keep.multiplyScalar(3));
      this.vel.x = mv.x; this.vel.z = mv.z; this.vel.y -= 22 * dt;
      moveWithCollisions(this.pos, this.vel, dt, ENEMY_R, ENEMY_H, this.level.colliders);
      this.play('run');

      // Boss 冲撞：周期性朝玩家突进，接触伤害
      if (this.isBoss) {
        this.chargeCd = (this.chargeCd ?? 4) - dt;
        if (this.chargeT > 0) {
          this.chargeT -= dt;
          this.vel.x = this.chargeDir.x * 20;
          this.vel.z = this.chargeDir.z * 20;
          this.vel.y = 0;
          moveWithCollisions(this.pos, this.vel, dt, ENEMY_R, ENEMY_H, this.level.colliders);
          // 撞到玩家
          if (this.pos.distanceTo(this.player.pos) < 1.6 && (this._chargeHitT ?? 0) <= 0) {
            this._chargeHitT = 0.8;
            const died = this.player.damage(Math.round(22 * (this.statMult.dmg || 1)), this.pos);
            this.hooks.onPlayerHit && this.hooks.onPlayerHit(died);
          }
        } else if (this.chargeCd <= 0) {
          this.chargeCd = 6 + Math.random() * 2;
          this.chargeT = 0.55;
          this.chargeDir = toP.clone();
          this.sound.playAt('shotSniper', distP, 0.8);
        }
        if ((this._chargeHitT ?? 0) > 0) this._chargeHitT -= dt;
      }

      // 开火节奏：burst + 全局攻击名额（最多 2 人同时开火，杜绝群殴秒杀）
      this.attackCd -= dt;
      if (this.attackCd <= 0 && this.burstLeft <= 0) {
        const shared = this.sharedAttack;
        const maxSim = this.isBoss ? 99 : (shared ? shared.maxAttackers : 2);
        const cur = shared ? shared.attackers : 0;
        if (this.isBoss || cur < maxSim) {
          this.burstLeft = this.isBoss ? 1 : BURST;
          this.shotTimer = 0;
          if (shared && !this.isBoss) { shared.attackers++; this._slotHeld = true; }
        }
      }
    }

    // burst 射击计时（ATTACK 中触发）；burst 结束归还全局攻击名额
    if (this.burstLeft > 0) {
      this.shotTimer -= dt;
      if (this.shotTimer <= 0) {
        this.shotTimer = this.isBoss ? 0.5 : BURST_GAP;
        this.burstLeft--;
        if (this.isBoss) this.shootRadial();
        else this.shoot();
        if (this.burstLeft <= 0) {
          this.attackCd = ATTACK_COOLDOWN + Math.random() * 0.6;
          if (this._slotHeld && this.sharedAttack) { this.sharedAttack.attackers--; this._slotHeld = false; }
        }
      }
    }

    // 敌人间简单分离
    for (const o of this.others || []) {
      if (o === this || !o.alive) continue;
      const d = this.pos.distanceTo(o.pos);
      if (d < 1.0 && d > 0.001) {
        const push = this.pos.clone().sub(o.pos).setY(0).normalize().multiplyScalar((1.0 - d) * 2 * dt);
        this.pos.add(push);
      }
    }

    // 受击闪红
    if (this.flashT > 0) {
      this.flashT -= dt;
      if (this.flashT <= 0) for (const m of this.mats) m.emissive.set(0x000000);
    }
    // 开火后坐颤动
    if (this.recoilT > 0) {
      this.recoilT -= dt;
      this.model.position.z = Math.sin(this.recoilT / 0.09 * Math.PI) * 0.05;
    } else {
      this.model.position.z = 0;
    }

    this.root.position.copy(this.pos);
    this.root.rotation.y = this.facing;
    this.mixer.update(dt);
    this.updateBolts(dt);
  }
}

// ================= 管理器 =================
export class EnemyManager {
  constructor(scene, templates, level, player, effects, sound, hooks, opts = {}) {
    this.scene = scene;
    this.templates = templates;
    this.level = level;
    this.player = player;
    this.effects = effects;
    this.sound = sound;
    this.hooks = hooks;
    this.survival = !!opts.survival; // 生存模式：敌人死亡后不自动复活
    this.sharedAttack = { attackers: 0, maxAttackers: 2 }; // 全局攻击名额：最多 2 人同时开火
    this.enemies = [];
    this.hitMeshes = [];

    // ---- 动画轨道名重映射（一次性） ----
    // Kenney 的动画 FBX 与模型 FBX 骨骼命名可能带不同前后缀，
    // 绑定不上就会永远 T-pose。按"后缀互相匹配"重命名轨道修复。
    const boneNames = new Set();
    templates.char.traverse(o => { if (o.isBone) boneNames.add(o.name); });
    let remapped = 0;
    for (const clip of templates.clips) {
      for (const track of clip.tracks) {
        const dot = track.name.lastIndexOf('.');
        if (dot <= 0) continue;
        const nodeName = track.name.slice(0, dot);
        if (boneNames.has(nodeName)) continue;
        const prop = track.name.slice(dot);
        const key = s => s.replace(/[\s_:]/g, '').toLowerCase();
        const nk = key(nodeName);
        const match = [...boneNames].find(b => {
          const bk = key(b);
          return bk.endsWith(nk) || nk.endsWith(bk);
        });
        if (match) { track.name = match + prop; remapped++; }
      }
    }
    window.__animRemap = remapped;

    // 初始出生点：过滤掉离玩家出生点太近的，避免开局即被贴脸
    const startPts = level.enemySpawns.filter(p => p.distanceTo(level.playerSpawn) > 10);
    const pts = startPts.length ? startPts : level.enemySpawns;
    for (let i = 0; i < 4; i++) {
      const e = this._create();
      e.spawnAt(pts[i % pts.length]);
    }
    for (const e of this.enemies) e.others = this.enemies;
  }

  _create() {
    const e = new Enemy(this.enemies.length, this.scene, this.templates, this.level,
      this.player, this.effects, this.sound, this.hooks);
    e.survivalMode = this.survival;
    e.sharedAttack = this.sharedAttack;
    e.others = this.enemies;
    this.enemies.push(e);
    return e;
  }

  ensureCount(n) {
    while (this.enemies.length < n) this._create();
  }

  // 生存模式：开启一波（数量/倍率/波次/BOSS标记），兵种混编，多余敌人退场
  startWave(count, mult, wave = 1, opts = {}) {
    this.ensureCount(count);
    const pts = this.level.enemySpawns.filter(p => p.distanceTo(this.player.pos) > 10);
    const use = pts.length ? pts : this.level.enemySpawns;
    // 兵种解锁节奏：第2波起混入冲锋兵，第3波起混入重装兵；BOSS波 i===0 为 BOSS
    const typeFor = (i) => {
      if (opts.boss && i === 0) return 'boss';
      if (wave >= 3 && i % 3 === 2) return 'heavy';
      if (wave >= 2 && i % 3 === 1) return 'swift';
      return 'grunt';
    };
    this.enemies.forEach((e, i) => {
      if (i < count) {
        e.spawnAt(use[i % use.length], mult, typeFor(i));
      } else {
        e.alive = false;
        e.root.visible = false;
        e.deathT = -1;
        e.respawnT = -1;
        e.setOpacity(1);
        for (const m of e.mats) m.emissive.set(0x000000);
      }
    });
  }

  aliveCount() {
    let n = 0;
    for (const e of this.enemies) if (e.alive) n++;
    return n;
  }

  aliveHitMeshes() {
    const out = [];
    for (const e of this.enemies) if (e.alive) out.push(...e.hitMeshes);
    return out;
  }

  update(dt) {
    for (const e of this.enemies) e.update(dt);
  }
}


