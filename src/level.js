import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// 竞技场拼装：运行时测量每块模型的包围盒，自动居中、落地、生成碰撞体。
// 这样不依赖素材的具体尺寸/轴心，拼出来必然严丝合缝。

export const ARENA_HALF = 24; // 内区半宽（米）

export async function buildLevel(scene, gltfLoader, onProgress) {
  const PIECES = [
    'floor', 'floor-detail', 'wall', 'wall-corner', 'wall-gate',
    'column', 'column-damaged', 'statue', 'stairs', 'banner',
    'tree', 'trophy', 'weapon-rack', 'block'
  ];
  const base = './assets/mini-arena/Models/GLB format/';
  const baseBlaster = './assets/blaster-kit/Models/GLB format/';

  // 跨包构件：castle-kit（城堡）与 mini-dungeon（地牢道具），文件名在各包内唯一
  // 条目格式：[包名, 文件名, 模板键]（模板键加 c 前缀避免与主包冲突）
  const EXTRA = [
    ['castle-kit', 'rocks-large', 'rocks-large'],
    ['castle-kit', 'tree-large', 'tree-large'],
    ['castle-kit', 'siege-catapult', 'siege-catapult'],
    ['castle-kit', 'tower-square', 'tower-square'],
    ['mini-dungeon', 'barrel', 'barrel'],
    ['mini-dungeon', 'chest', 'chest'],
    ['castle-kit', 'tower-square-base', 'ctower-base'],
    ['castle-kit', 'tower-square-mid', 'ctower-mid'],
    ['castle-kit', 'tower-square-top', 'ctower-top'],
    ['castle-kit', 'wall', 'cwall'],
    ['castle-kit', 'wall-corner', 'cwall-corner'],
    ['castle-kit', 'gate', 'cgate']
  ];

  const templates = {};
  let done = 0;
  const total = PIECES.length + 3 + EXTRA.length;
  for (const name of PIECES) {
    const gltf = await gltfLoader.loadAsync(base + name + '.glb');
    templates[name] = gltf.scene;
    done++;
    onProgress && onProgress(done / total, name);
  }
  const crateGltf = await gltfLoader.loadAsync(baseBlaster + 'crate-medium.glb');
  templates['crate-medium'] = crateGltf.scene;
  const crateWideGltf = await gltfLoader.loadAsync(baseBlaster + 'crate-wide.glb');
  templates['crate-wide'] = crateWideGltf.scene;
  const crateSmallGltf = await gltfLoader.loadAsync(baseBlaster + 'crate-small.glb');
  templates['crate-small'] = crateSmallGltf.scene;
  for (const [pack, file, key] of EXTRA) {
    const g = await gltfLoader.loadAsync(`./assets/${pack}/Models/GLB format/${file}.glb`);
    templates[key] = g.scene;
    done++;
    onProgress && onProgress(done / total, file);
  }
  onProgress && onProgress(done / total, 'done');

  const group = new THREE.Group();
  scene.add(group);

  const colliders = [];   // Box3[] 玩家/敌人/子弹的碰撞体
  const hitMeshes = [];   // Mesh[] 射线检测（命中/视线遮挡）

  const _box = new THREE.Box3();
  const _c = new THREE.Vector3();

  // 放置一块模型：以 (cx, groundY, cz) 为中心，自动落地对齐（scale 会同步影响碰撞体）
  function place(key, cx, cz, { rotY = 0, groundY = 0, collide = true, scale = 1 } = {}) {
    const inst = templates[key].clone(true);
    if (scale !== 1) inst.scale.setScalar(scale);
    inst.rotation.y = rotY;
    inst.position.set(cx, groundY, cz);
    group.add(inst);
    inst.updateMatrixWorld(true);
    _box.setFromObject(inst);
    _box.getCenter(_c);
    inst.position.x += cx - _c.x;
    inst.position.z += cz - _c.z;
    inst.position.y += groundY - _box.min.y;
    inst.updateMatrixWorld(true);
    if (collide) {
      _box.setFromObject(inst);
      colliders.push(_box.clone());
    }
    inst.traverse(o => { if (o.isMesh) { o.userData.level = true; hitMeshes.push(o); } });
    return inst;
  }

  const sizeOf = key => {
    const b = new THREE.Box3().setFromObject(templates[key]);
    return b.getSize(new THREE.Vector3());
  };

  // ---------- 地板 ----------
  const floorSize = sizeOf('floor');
  const N = Math.max(1, Math.round((ARENA_HALF * 2) / floorSize.x));
  const step = (ARENA_HALF * 2) / N;             // 实际每格尺寸
  const inner = step * N;                        // 实际内区宽
  const H = inner / 2;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = -H + step / 2 + i * step;
      const z = -H + step / 2 + j * step;
      place((i + j) % 7 === 3 ? 'floor-detail' : 'floor', x, z, { collide: false });
    }
  }

  // ---------- 四周围墙 + 角 ----------
  const wallSize = sizeOf('wall');
  const cornerSize = sizeOf('wall-corner');
  const span = inner - cornerSize.x;             // 角件占用两端的余量
  const count = Math.max(1, Math.round(span / wallSize.x));
  const spacing = span / count;
  const start = -H + cornerSize.x + spacing / 2;

  const sides = [
    { dir: 'n', rotY: 0 },
    { dir: 's', rotY: Math.PI },
    { dir: 'w', rotY: Math.PI / 2 },
    { dir: 'e', rotY: -Math.PI / 2 }
  ];
  let gatePlaced = false;
  for (const s of sides) {
    for (let i = 0; i < count; i++) {
      const t = start + i * spacing;
      let x, z, rot = s.rotY;
      if (s.dir === 'n') { x = t; z = -H; }
      else if (s.dir === 's') { x = t; z = H; }
      else if (s.dir === 'w') { x = -H; z = t; rot = s.rotY + Math.PI / 2; }
      else { x = H; z = t; rot = s.rotY + Math.PI / 2; }

      // 南侧正中换成大门（装饰，碰撞照常）
      if (s.dir === 's' && !gatePlaced && Math.abs(x) < spacing * 0.6) {
        place('wall-gate', 0, H, { rotY: Math.PI });
        gatePlaced = true;
        continue;
      }
      place('wall', x, z, { rotY: rot });
    }
  }
  // 四个角
  const co = H - cornerSize.x / 2;
  place('wall-corner', co, co, { rotY: Math.PI });
  place('wall-corner', -co, co, { rotY: -Math.PI / 2 });
  place('wall-corner', co, -co, { rotY: Math.PI / 2 });
  place('wall-corner', -co, -co, { rotY: 0 });

  // ---------- 墙边柱子（每边 2 根，交替用破损柱） ----------
  const colOff = H - 1.4;
  const colPos = [-H / 2, H / 2];
  for (const t of colPos) {
    place('column', t, -colOff, {});
    place('column-damaged', t, colOff, {});
    place('column', -colOff, t, { rotY: Math.PI / 2 });
    place('column-damaged', colOff, t, { rotY: Math.PI / 2 });
  }

  // ---------- 角落雕像 + 树 ----------
  const stOff = H - 2.6;
  place('statue', stOff, stOff, { rotY: Math.PI * 0.75 });
  place('statue', -stOff, stOff, { rotY: Math.PI * 0.25 });
  place('statue', stOff, -stOff, { rotY: Math.PI * 1.25 });
  place('statue', -stOff, -stOff, { rotY: Math.PI * 1.75 });
  place('tree', stOff - 1.2, 2.5, {});
  place('tree', -stOff + 1.2, -2.5, {});

  // ---------- 中央地标 + 两侧台阶 ----------
  place('trophy', 0, 0, {});
  const st2 = H - 1.8;
  place('stairs', 0, -st2, { rotY: Math.PI });
  place('stairs', 0, st2, { rotY: 0 });

  // ---------- 掩体木箱群（blaster-kit） ----------
  const clusters = [
    [-9, -9], [9, -9], [-9, 9], [9, 9], [0, -14], [0, 14], [-14, 0], [14, 0]
  ];
  const crateM = sizeOf('crate-medium');
  for (const [x, z] of clusters) {
    place('crate-medium', x, z, { rotY: Math.random() * Math.PI });
    if (Math.random() < 0.7) {
      // 叠一个小的
      place('crate-small', x + crateM.x * 0.15, z + crateM.z * 0.1,
        { rotY: Math.random() * Math.PI, groundY: crateM.y, collide: false });
    }
    if (Math.random() < 0.5) {
      place('crate-wide', x + (crateM.x + 1.4) * (Math.random() < 0.5 ? 1 : -1), z + (Math.random() - 0.5) * 2,
        { rotY: Math.random() * Math.PI });
    }
  }

  // ---------- 武器架 / 横幅 / 低矮块 ----------
  place('weapon-rack', -H + 1.1, 4, { rotY: Math.PI / 2 });
  place('weapon-rack', H - 1.1, -4, { rotY: -Math.PI / 2 });
  place('banner', 2.2, H - 1.2, { rotY: Math.PI });
  place('banner', -2.2, H - 1.2, { rotY: Math.PI });
  place('block', -5, 16, { rotY: 0.3 });
  place('block', 5, -16, { rotY: -0.3 });

  // ---------- 中央遗迹：四柱 + 石梁（可穿行，梁下净空约 3m） ----------
  const colH = sizeOf('column').y;
  const wallLen = sizeOf('wall').x;
  for (const [x, z] of [[-3.4, -3.4], [3.4, -3.4], [-3.4, 3.4], [3.4, 3.4]]) {
    place('column', x, z, {});
  }
  for (const zz of [-3.4, 3.4]) {
    place('wall', -wallLen * 0.45, zz, { rotY: 0, groundY: colH * 0.85 });
    place('wall', wallLen * 0.45, zz, { rotY: 0, groundY: colH * 0.85 });
  }

  // ---------- 可攀爬木箱塔（底箱 1.2m 跳得上，二段跳上顶） ----------
  const towerSpots = [[-6, 2], [6, -2], [0, 8], [0, -8]];
  for (const [x, z] of towerSpots) {
    place('crate-medium', x, z, { rotY: Math.random() * Math.PI });
    place('crate-small', x + 0.45, z + 0.3, { rotY: Math.random() * Math.PI, groundY: crateM.y, collide: true });
  }

  // ---------- L 形掩体（block 低墙，可跳越） ----------
  const L1 = [[-11, -6], [-11, -4.4], [-11, -2.8], [-9.4, -2.8]];
  const L2 = [[11, 6], [11, 4.4], [11, 2.8], [9.4, 2.8]];
  for (const [x, z] of L1) place('block', x, z, { rotY: 0 });
  for (const [x, z] of L2) place('block', x, z, { rotY: 0 });

  // ---------- 中圈柱廊（破损柱混搭，提供中距离掩体） ----------
  const midOff = 12.5;
  place('column', midOff, 0, { rotY: Math.PI / 2 });
  place('column-damaged', -midOff, 0, { rotY: Math.PI / 2 });
  place('column', 0, midOff, {});
  place('column-damaged', 0, -midOff, {});

  // ---------- 装饰：旗门 + 树 + 雕像细节 ----------
  place('banner', 3.4, -H + 1.3, {});
  place('banner', -3.4, -H + 1.3, {});
  place('tree', 8, 8.5, {});
  place('tree', -8, -8.5, {});
  place('weapon-rack', H - 1.1, 8, { rotY: -Math.PI / 2 });
  place('weapon-rack', -H + 1.1, -8, { rotY: Math.PI / 2 });

  // ---------- 跨包装饰与掩体：castle-kit + mini-dungeon ----------
  place('rocks-large', 17, 17, { rotY: 0.5, scale: 1.5 });    // 巨石掩体
  place('rocks-large', -17, -17, { rotY: 2.4, scale: 1.5 });
  place('siege-catapult', 12, -12, { rotY: -0.8 }); // 中场攻城投石机地标
  place('tree-large', -13, 6, {});
  place('tree-large', 13, -6, {});
  place('barrel', -4, 10, {});
  place('barrel', 4, -10, {});
  place('barrel', 16, 4, {});
  place('barrel', -16, -4, {});
  place('chest', 10, 10, { rotY: 0.6 });
  place('chest', -10, -10, { rotY: -0.6 });
  place('tower-square', 0, H + 8, { collide: false, scale: 1.6 }); // 墙外城堡塔楼（远景天际线）

  // ---------- 大型建筑：三层城堡塔楼（西北角地标，放大 1.9 倍≈12m） ----------
  const CS = 1.9; // castle-kit 建筑整体放大系数
  const tbH = sizeOf('ctower-base').y * CS;
  place('ctower-base', -14, -12, { scale: CS });
  place('ctower-mid', -14, -12, { groundY: tbH, scale: CS });
  place('ctower-top', -14, -12, { groundY: tbH * 2, scale: CS });

  // ---------- 石墙堡垒（东侧凹字形，开口朝西，墙体 2m→3.8m 高） ----------
  const cwl = sizeOf('cwall').x * CS;
  place('cwall', 15.5, 17.5, { rotY: 0, scale: CS });      // 北翼
  place('cwall', 11.5, 6.5, { rotY: 0, scale: CS });       // 南翼
  place('cwall', 15.8, 12, { rotY: Math.PI / 2, scale: CS }); // 东背墙
  place('cwall-corner', 15.8, 18.2, { rotY: Math.PI / 2, scale: CS }); // 东北角楼
  place('cgate', 7.2, 12, { rotY: Math.PI / 2, scale: CS, collide: false }); // 西口 freestanding 大门
  place('ctower-base', 15.8, 6.5, { scale: CS * 0.8 });    // 西南角小塔楼（进出通道标记）

  // 地面碰撞（y=0 平面由玩家物理单独处理）

  // ---------- 静态网格合并：同材质的几百个构件合成一个 Mesh，大幅减少 draw call ----------
  group.updateMatrixWorld(true);
  const batch = new Map(); // 材质uuid -> { mat, parts: [mesh...] }
  const allMeshes = [];
  group.traverse(o => { if (o.isMesh) allMeshes.push(o); });
  for (const mesh of allMeshes) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (mats.length !== 1) continue; // 多材质网格不合并
    if (!batch.has(mats[0].uuid)) batch.set(mats[0].uuid, { mat: mats[0], parts: [] });
    batch.get(mats[0].uuid).parts.push(mesh);
  }
  let mergedBatches = 0, removedMeshes = 0;
  for (const { mat, parts } of batch.values()) {
    if (parts.length < 2) continue;
    const geoms = parts.map(mesh => {
      const g = mesh.geometry.clone();
      g.applyMatrix4(mesh.matrixWorld);
      return g;
    });
    const merged = mergeGeometries(geoms, false);
    if (!merged) continue; // 属性不一致就保留原样
    const m = new THREE.Mesh(merged, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    mergedBatches++;
    for (const mesh of parts) { group.remove(mesh); removedMeshes++; }
  }
  console.log(`[level] 静态网格合并: ${mergedBatches} 批, 移除 ${removedMeshes} 个原始网格`);

  const enemySpawns = [
    new THREE.Vector3(-H * 0.6, 0, -H * 0.6),
    new THREE.Vector3(H * 0.6, 0, -H * 0.6),
    new THREE.Vector3(-H * 0.6, 0, H * 0.6),
    new THREE.Vector3(H * 0.6, 0, H * 0.6),
    new THREE.Vector3(0, 0, -H * 0.7),
    new THREE.Vector3(0, 0, H * 0.55)
  ];
  const playerSpawn = new THREE.Vector3(0, 0, H - 4.5);

  return { group, colliders, hitMeshes, enemySpawns, playerSpawn, half: H };
}
