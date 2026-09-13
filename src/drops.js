import * as THREE from 'three';

// 击杀掉落：治疗药水（回血）与弹匣（补弹），旋转漂浮、靠近拾取、限时消失
export class DropManager {
  constructor(scene, templates) {
    this.scene = scene;
    this.templates = templates; // { heal: potion场景, ammo: clip-large场景 }
    this.items = [];
  }

  spawn(pos, type) {
    const tpl = this.templates[type];
    if (!tpl) return;
    const mesh = tpl.clone(true);
    mesh.position.set(pos.x, 0.55, pos.z);
    mesh.rotation.y = Math.random() * Math.PI * 2;
    this.scene.add(mesh);
    this.items.push({ mesh, type, t: Math.random() * 6, life: 12 });
  }

  update(dt, player, onPickup) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.t += dt;
      it.life -= dt;
      it.mesh.rotation.y += dt * 2.4;
      it.mesh.position.y = 0.55 + Math.sin(it.t * 2.6) * 0.1;
      // 即将消失时闪烁提醒
      it.mesh.visible = it.life > 3 || Math.sin(it.life * 14) > -0.2;
      // 拾取判定
      const d = it.mesh.position.distanceTo(player.pos);
      if (d < 1.35 && player.alive) {
        onPickup(it.type);
        this.remove(i);
        continue;
      }
      if (it.life <= 0) this.remove(i);
    }
  }

  remove(i) {
    this.scene.remove(this.items[i].mesh);
    this.items.splice(i, 1);
  }

  clear() {
    for (const it of this.items) this.scene.remove(it.mesh);
    this.items = [];
  }
}
