import * as THREE from 'three';

// 特效池：枪口火光 / 曳光 / 火花 / 烟雾，全部程序生成，无外部贴图
export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.tracers = [];   // {mesh, life, maxLife}
    this._sparks = [];   // {points, vels[], life, maxLife}（注意：不能叫 this.sparks，会遮蔽同名方法）
    this.smokes = [];    // {sprite, vel, life, maxLife, grow}
    this._initPools();
  }

  _initPools() {
    // 曳光：细长发光圆柱
    const tracerGeo = new THREE.CylinderGeometry(0.015, 0.015, 1, 5, 1, true);
    tracerGeo.translate(0, 0.5, 0); // 沿 +Y，方便拉伸
    tracerGeo.rotateX(Math.PI / 2); // 沿 -Z-> +Z? 旋转后沿 Z，用 lookAt 对准
    this._tracerGeo = tracerGeo;
    this._tracerMat = new THREE.MeshBasicMaterial({
      color: 0xffe08a, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false
    });

    // 火花：Points
    this._sparkGeo = new THREE.BufferGeometry();
    this._sparkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 24), 3));
    this._sparkMat = new THREE.PointsMaterial({
      color: 0xffc766, size: 0.07, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false
    });

    // 烟雾 sprite 材质：canvas 画软圆
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const g = cv.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 4, 32, 32, 30);
    grad.addColorStop(0, 'rgba(200,200,205,0.85)');
    grad.addColorStop(1, 'rgba(200,200,205,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    this._smokeTex = new THREE.CanvasTexture(cv);

    // 枪口闪光光源池：常驻场景、只调强度。动态加删光源会触发
    // three.js 重编译着色器，每次开火卡顿，所以绝不 add/remove。
    this._lightPool = [];
    for (let i = 0; i < 6; i++) {
      const l = new THREE.PointLight(0xffc66e, 0, 7);
      this.scene.add(l);
      this._lightPool.push({ light: l, life: 0, maxLife: 1, base: 0 });
    }
  }

  // 曳光：从 from 到 to 的发光细条，寿命极短（颜色随武器）
  tracer(from, to, color = 0xffe08a) {
    const len = from.distanceTo(to);
    if (len < 0.2) return;
    const mesh = new THREE.Mesh(this._tracerGeo, this._tracerMat.clone());
    mesh.material.color.set(color);
    mesh.position.copy(from);
    mesh.lookAt(to);
    mesh.scale.set(1, 1, len);
    this.scene.add(mesh);
    this.tracers.push({ mesh, life: 0.09, maxLife: 0.09 });
  }

  // 命中火花
  sparks(pos, normal) {
    const n = 10;
    const geo = this._sparkGeo.clone();
    const p = geo.attributes.position.array;
    const vels = [];
    for (let i = 0; i < n; i++) {
      p[i * 3] = pos.x; p[i * 3 + 1] = pos.y; p[i * 3 + 2] = pos.z;
      const v = new THREE.Vector3(
        (Math.random() - 0.5) * 2, Math.random() * 1.4, (Math.random() - 0.5) * 2
      ).normalize().multiplyScalar(2 + Math.random() * 4);
      if (normal) v.addScaledVector(normal, 3).multiplyScalar(0.6);
      vels.push(v);
    }
    geo.setDrawRange(0, n);
    const mat = this._sparkMat.clone();
    const points = new THREE.Points(geo, mat);
    this.scene.add(points);
    this._sparks.push({ points, vels, life: 0.35, maxLife: 0.35 });
  }

  // 烟雾团（死亡用，pos 为地面处）
  smoke(pos, count = 7) {
    for (let i = 0; i < count; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this._smokeTex, transparent: true, opacity: 0.8, depthWrite: false,
        color: 0x9aa0a8
      });
      const s = new THREE.Sprite(mat);
      s.position.copy(pos).add(new THREE.Vector3(
        (Math.random() - 0.5) * 0.7, 0.3 + Math.random() * 0.9, (Math.random() - 0.5) * 0.7
      ));
      s.scale.setScalar(0.5 + Math.random() * 0.5);
      this.scene.add(s);
      this.smokes.push({
        sprite: s, life: 1.4 + Math.random() * 0.7, maxLife: 2.1,
        vel: new THREE.Vector3((Math.random() - 0.5) * 0.4, 0.8 + Math.random() * 0.6, (Math.random() - 0.5) * 0.4),
        grow: 1.1 + Math.random() * 0.8
      });
    }
  }

  // 枪口闪光：从池里取一个点光，短时间衰减（不加删光源）
  flash(pos, intensity = 3, dist = 7, time = 0.05) {
    const slot = this._lightPool.find(s => s.life <= 0) || this._lightPool[0];
    slot.light.position.copy(pos);
    slot.light.distance = dist;
    slot.life = time;
    slot.maxLife = time;
    slot.base = intensity;
  }

  update(dt) {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      t.mesh.material.opacity = Math.max(0, t.life / t.maxLife) * 0.9;
      if (t.life <= 0) { this.scene.remove(t.mesh); t.mesh.material.dispose(); this.tracers.splice(i, 1); }
    }
    for (let i = this._sparks.length - 1; i >= 0; i--) {
      const s = this._sparks[i];
      s.life -= dt;
      const arr = s.points.geometry.attributes.position.array;
      for (let j = 0; j < s.vels.length; j++) {
        s.vels[j].y -= 12 * dt;
        arr[j * 3] += s.vels[j].x * dt;
        arr[j * 3 + 1] += s.vels[j].y * dt;
        arr[j * 3 + 2] += s.vels[j].z * dt;
      }
      s.points.geometry.attributes.position.needsUpdate = true;
      s.points.material.opacity = Math.max(0, s.life / s.maxLife);
      if (s.life <= 0) { this.scene.remove(s.points); s.points.geometry.dispose(); s.points.material.dispose(); this._sparks.splice(i, 1); }
    }
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const s = this.smokes[i];
      s.life -= dt;
      s.sprite.position.addScaledVector(s.vel, dt);
      s.sprite.scale.addScalar(s.grow * dt);
      s.sprite.material.opacity = 0.8 * Math.max(0, s.life / s.maxLife);
      if (s.life <= 0) { this.scene.remove(s.sprite); s.sprite.material.dispose(); this.smokes.splice(i, 1); }
    }
    for (const s of this._lightPool) {
      if (s.life > 0) {
        s.life -= dt;
        s.light.intensity = Math.max(0, s.life / s.maxLife) * s.base;
      }
    }
  }
}
