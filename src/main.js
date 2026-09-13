import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { buildLevel } from './level.js';
import { Player } from './player.js';
import { Weapon, WEAPON_CONFIGS } from './weapon.js';
import { EnemyManager } from './enemy.js';
import { Effects } from './effects.js';
import { HUD } from './hud.js';
import { SoundManager } from './audio.js';
import { DropManager } from './drops.js';
import { loadSettings, saveSettings, settings } from './settings.js';
import { defaultRunMods, pickUpgradeCards } from './upgrades.js';

const WIN_KILLS = 10;
let gameMode = 'classic'; // classic | survival
let wave = 1;
let intermission = false;
let runMods = defaultRunMods(); // 本局成长属性（肉鸽强化）
let runTaken = {};              // 已选强化计数
let runPicks = [];              // 本局强化名列表（结算展示）
// 游戏流程计时器：帧驱动（画面渲染时才倒数）——绝不用 setTimeout，
// 后台冻结的标签页里 setTimeout 永远不触发，会导致波次/选卡流程卡死
let upgradeDelay = -1; // >=0 时倒数到 0 弹出强化三选一
let waveDelay = -1;    // >=0 时倒数到 0 开启下一波

// ---------- 渲染基础 ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
let pixelRatio = Math.min(window.devicePixelRatio, 2);
renderer.setPixelRatio(pixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
// 黄昏天空渐变（画布纹理）
function makeSkyTexture() {
  const cv = document.createElement('canvas');
  cv.width = 2; cv.height = 256;
  const g = cv.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#2e2450');
  grad.addColorStop(0.45, '#b55d45');
  grad.addColorStop(0.72, '#f5a35c');
  grad.addColorStop(1, '#ffe3b3');
  g.fillStyle = grad;
  g.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
scene.background = makeSkyTexture();
scene.fog = new THREE.Fog(0xd9a06c, 55, 155);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.08, 300);
scene.add(camera); // 视图模型挂在相机下，相机必须入场景

scene.add(new THREE.HemisphereLight(0xffd2a8, 0x6b5a4a, 0.85));
const sun = new THREE.DirectionalLight(0xffb36b, 1.4);
sun.position.set(38, 22, -32);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -45; sun.shadow.camera.right = 45;
sun.shadow.camera.top = 45; sun.shadow.camera.bottom = -45;
sun.shadow.camera.far = 140;
sun.shadow.bias = -0.0006;
scene.add(sun);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- 模块 ----------
const hud = new HUD();
const sound = new SoundManager();
const clock = new THREE.Clock();

// ---------- 资源预加载（页面打开即开始） ----------
const assets = {};
let game = null; // {player, weapon, enemies, level, effects}
let state = 'boot';   // boot | ready | playing | dead | win
let kills = 0, shotsFired = 0, shotsHit = 0;

async function preload() {
  let done = 0;
  const total = 13;
  const tick = (label) => { done++; hud.loadingProgress(done / total, label); };

  const gltfLoader = new GLTFLoader();
  const fbxLoader = new FBXLoader();

  // 三把武器模型
  const gunBase = './assets/blaster-kit/Models/GLB format/';
  assets.guns = {};
  for (const cfg of WEAPON_CONFIGS) {
    const g = await gltfLoader.loadAsync(gunBase + cfg.model + '.glb');
    assets.guns[cfg.model] = g.scene;
    tick('武器 ' + cfg.name);
  }

  // 角色 + 动画
  const charFbx = await fbxLoader.loadAsync('./assets/animated-characters-protagonists/Model/characterMedium.fbx');
  assets.char = charFbx;
  const idleFbx = await fbxLoader.loadAsync('./assets/animated-characters-protagonists/Animations/idle.fbx');
  const idleClip = idleFbx.animations[0];
  idleClip.name = 'idle';
  const runFbx = await fbxLoader.loadAsync('./assets/animated-characters-protagonists/Animations/run.fbx');
  const runClip = runFbx.animations[0];
  runClip.name = 'run';
  assets.clips = [idleClip, runClip];
  tick('角色动画');

  // 皮肤
  const texLoader = new THREE.TextureLoader();
  assets.skins = [];
  for (const s of ['criminalMaleA', 'cyborgFemaleA', 'skaterFemaleA', 'skaterMaleA']) {
    const t = await texLoader.loadAsync(`./assets/animated-characters-protagonists/Skins/${s}.png`);
    t.colorSpace = THREE.SRGBColorSpace;
    assets.skins.push(t);
  }
  tick('皮肤');

  // 掉落物模板（治疗药水 / 弹匣）
  assets.drops = {
    heal: (await gltfLoader.loadAsync('./assets/mini-dungeon/Models/GLB format/potion.glb')).scene,
    ammo: (await gltfLoader.loadAsync('./assets/blaster-kit/Models/GLB format/clip-large.glb')).scene
  };
  tick('掉落物');

  // 竞技场（内部加载全部构件）
  assets.level = await buildLevel(scene, gltfLoader, () => tick('场景'));
  tick('场景');

  // 音效（AudioContext 此时被浏览器挂起，decode 不受影响；开始游戏时恢复）
  sound.unlock();
  const sfx = [
    ['shot', './assets/sci-fi-sounds/Audio/laserSmall_001.ogg'],
    ['shotSMG', './assets/sci-fi-sounds/Audio/laserRetro_002.ogg'],
    ['shotSniper', './assets/sci-fi-sounds/Audio/laserLarge_000.ogg'],
    ['shotEnemy', './assets/sci-fi-sounds/Audio/laserLarge_002.ogg'],
    ['hit', './assets/sci-fi-sounds/Audio/impactMetal_003.ogg'],
    ['explosion', './assets/sci-fi-sounds/Audio/explosionCrunch_001.ogg'],
    ['hurt', './assets/sci-fi-sounds/Audio/forceField_002.ogg'],
    ['reload', './assets/sci-fi-sounds/Audio/doorClose_000.ogg']
  ];
  await Promise.all(sfx.map(([n, u]) => sound.load(n, u)));
  tick('音效');

  hud.el.loadbar.style.width = '100%';
  hud.el.loadtext.textContent = '就绪';
  state = 'ready';
}

loadSettings();
bindSettingsUI();
applySettings();

preload().catch(err => {
  console.error(err);
  hud.el.loadtext.textContent = '加载失败：' + err.message;
});

// ---------- 设置 ----------
function applySettings() {
  sound.setVolume(settings.volume);
  if (game) {
    game.player.sens = settings.sens;
    game.player.invertY = settings.invertY;
    game.player.baseFov = settings.fov;
  }
}

function bindSettingsUI() {
  const $ = id => document.getElementById(id);
  const sens = $('setSens'), vol = $('setVol'), fov = $('setFov'), inv = $('setInv'), fpsC = $('setFpsShow');
  sens.value = settings.sens; vol.value = settings.volume; fov.value = settings.fov; inv.checked = settings.invertY;
  fpsC.checked = settings.fps;
  const labels = () => {
    $('setSensV').textContent = Number(settings.sens).toFixed(1) + 'x';
    $('setVolV').textContent = Math.round(settings.volume * 100) + '%';
    $('setFovV').textContent = settings.fov + '°';
  };
  labels();
  hud.showFps(settings.fps);
  sens.addEventListener('input', () => { settings.sens = +sens.value; saveSettings(); applySettings(); labels(); });
  vol.addEventListener('input', () => { settings.volume = +vol.value; saveSettings(); applySettings(); labels(); });
  fov.addEventListener('input', () => { settings.fov = +fov.value; saveSettings(); applySettings(); labels(); });
  inv.addEventListener('change', () => { settings.invertY = inv.checked; saveSettings(); applySettings(); });
  fpsC.addEventListener('change', () => { settings.fps = fpsC.checked; saveSettings(); hud.showFps(settings.fps); });
}

let settingsReturnTo = 'start';
document.getElementById('openSettingsBtn').addEventListener('click', (e) => {
  e.stopPropagation(); // 不要触发整个暂停页的"点击继续"
  settingsReturnTo = 'start';
  hud.showScreen('settings');
});
document.getElementById('settingsBack').addEventListener('click', () => {
  hud.showScreen(settingsReturnTo);
});
// 暂停界面点任意空白处 = 恢复游戏（省去精确点按钮）
document.getElementById('startScreen').addEventListener('click', (e) => {
  if (state === 'paused') resumeGame();
});

// ---------- 开局 ----------
document.getElementById('startBtn').addEventListener('click', () => {
  if (state === 'ready') startGame('classic');
  else if (state === 'paused') resumeGame();
});
document.getElementById('survivalBtn').addEventListener('click', () => {
  if (state === 'ready') startGame('survival');
});

// ---------- 对局重置（胜利结算/暂停菜单共用） ----------
function resetMatch() {
  kills = 0; shotsFired = 0; shotsHit = 0;
  wave = 1; intermission = false;
  upgradeDelay = -1; waveDelay = -1;
  runMods = defaultRunMods();
  runTaken = {};
  runPicks = [];
  game.player.respawn(assets.level.playerSpawn);
  game.player.moveMult = runMods.moveMult;
  game.player.maxHp = 100 + runMods.maxHpBonus;
  game.player.extraJumps = runMods.extraJumps;
  game.player.hasDash = runMods.hasDash;
  game.player.dashCdMult = runMods.dashCdMult;
  game.player.dashCd = 0;
  game.weapon.runMods = runMods;
  game.weapon.resetAmmo();
  game.drops.clear();
  if (gameMode === 'survival') {
    game.enemies.startWave(4, waveMult(1));
    hud.setTopStat('波次 WAVE', '1', '敌人 4');
  } else {
    for (const e of game.enemies.enemies) {
      e.spawnAt(assets.level.enemySpawns[(Math.random() * assets.level.enemySpawns.length) | 0]);
    }
    hud.setTopStat('击杀 KILLS', '0', `目标 ${WIN_KILLS} 杀`);
  }
  input.fire = false; input.ads = false;
}

document.getElementById('restartBtn').addEventListener('click', () => {
  if (state !== 'win') return;
  resetMatch();
  hud.setWinTitle('胜 利');
  hud.showScreen(null);
  state = 'playing';
  tryLock();
});

// ---------- 主菜单 / 暂停按钮 ----------
function updateStartButtons() {
  const paused = state === 'paused';
  const show = (id, on) => { document.getElementById(id).style.display = on ? '' : 'none'; };
  show('startBtn', !paused);
  show('survivalBtn', !paused);
  show('btnResume', paused);
  show('btnRestartMatch', paused);
  show('btnMainMenu', paused);
  document.querySelector('#startScreen h2').textContent = paused
    ? '已暂停 — 点击任意空白处继续'
    : '竞技场射击 · 先拿到 10 个击杀';
}

function exitToMenu() {
  if (!game) return;
  teardownMatch();
  state = 'ready';
  input.fire = false; input.ads = false;
  hud.showGame(false);
  hud.showScreen('start');
  updateStartButtons();
}

function teardownMatch() {
  scene.remove(game.matchGroup);        // 敌人/掉落/特效全部随组拆除
  game.weapon.dispose();                // 视图模型挂在相机下，单独移除
  game.drops.clear();
  game = null;
}

document.getElementById('btnResume').addEventListener('click', () => {
  if (state === 'paused') resumeGame();
});
document.getElementById('btnRestartMatch').addEventListener('click', () => {
  if (state !== 'paused') return;
  resetMatch();
  hud.showScreen(null);
  state = 'playing';
  tryLock();
});
document.getElementById('btnMainMenu').addEventListener('click', () => {
  if (state === 'paused') exitToMenu();
});

// ---------- 指针锁定 ----------
// 规则：点击永远直接发起新请求（点击是新鲜手势，绝不能被闸门吞掉）；
// 只有程序化重试（冷却期）走 catch 链，间隔 800ms。
function tryLock() {
  const el = renderer.domElement;
  if (document.pointerLockElement === el) return;
  const p = el.requestPointerLock();
  if (p && p.catch) p.catch(() => {
    if (state === 'playing') setTimeout(() => {
      if (state === 'playing' && document.pointerLockElement !== el) tryLock();
    }, 800);
  });
}

function startGame(mode = 'classic') {
  sound.unlock(); // 恢复被浏览器挂起的音频
  if (game) teardownMatch(); // 从主菜单再次开局前，拆掉上一局的场景对象
  gameMode = mode;
  wave = 1;
  intermission = false;
  const { playerSpawn, colliders } = assets.level;

  // 本局所有场景对象统一挂到 matchGroup，回主菜单时整体拆除
  const matchGroup = new THREE.Group();
  scene.add(matchGroup);

  const player = new Player(camera);
  player.pos.copy(playerSpawn);
  player.yaw = Math.PI; // 面向场地中心
  player.colliders = colliders;
  player.onDamage = (amt, from) => {
    hud.damageFlash();
    player.addShake(0.22); // 受击屏幕震动
    sound.play('hurt', { volume: 0.55 });
  };

  const effects = new Effects(matchGroup);

  const weapon = new Weapon(camera, assets.guns, effects, sound);
  weapon.player = player;
  weapon.onShotFired = () => { shotsFired++; };
  weapon.onHit = (r) => {
    if (r.type === 'enemy') {
      shotsHit++;
      const willDie = r.enemy.hp - r.damage <= 0;
      r.enemy.damage(r.damage);
      hud.hitmarker(willDie);
      hud.spawnDamage(camera, r.point, r.damage, !!r.head || !!r.crit);
      sound.play('hit', { volume: 0.5, pitch: willDie ? 0.9 : (r.crit ? 1.5 : 1.2) });
      // 高爆弹头：命中点范围伤害
      if (runMods.explosive > 0) {
        const radius = 2.6 + runMods.explosive * 0.8;
        for (const e of enemies.enemies) {
          if (e === r.enemy || !e.alive) continue;
          if (e.pos.distanceTo(r.point) < radius) e.damage(Math.round(r.damage * 0.5));
        }
        effects.smoke(r.point.clone(), 2);
      }
    }
  };
  weapon.onSwitch = () => {
    const w = weapon.cur();
    hud.setWeapon(w.cfg.name, weapon.idx, weapon.weapons.length);
  };
  hud.setWeapon(weapon.cur().cfg.name, 0, weapon.weapons.length);

  const enemies = new EnemyManager(matchGroup, {
    char: assets.char, clips: assets.clips, skins: assets.skins, gun: assets.guns['blaster-f']
  }, assets.level, player, effects, sound, {
    onPlayerHit: (died) => { if (died) onPlayerDeath(); },
    onEnemyDied: (e) => onEnemyKilled(e)
  }, { survival: gameMode === 'survival' });

  const drops = new DropManager(matchGroup, assets.drops);

  runMods = defaultRunMods();
  runTaken = {};
  runPicks = [];
  weapon.runMods = runMods;
  player.moveMult = runMods.moveMult;
  player.maxHp = 100 + runMods.maxHpBonus;
  player.health = player.maxHp;
  player.extraJumps = runMods.extraJumps;
  player.hasDash = runMods.hasDash;

  game = { player, weapon, enemies, effects, drops };
  applySettings(); // 把设置套到新建的 player 上
  state = 'playing';

  hud.showScreen(null);
  hud.showGame(true);
  hud.setWeapon(weapon.cur().cfg.name, 0, weapon.weapons.length);
  if (gameMode === 'survival') startWave(1);
  else hud.setTopStat('击杀 KILLS', '0', `目标 ${WIN_KILLS} 杀`);
  tryLock();
}

// ---------- 生存模式（类肉鸽）：波次 + 强化三选一 ----------
function waveMult(n) {
  // 敌人成长刻意温和：爽杀体验优先
  return {
    hp: 1 + (n - 1) * 0.12,
    speed: Math.min(1.35, 1 + (n - 1) * 0.04),
    dmg: 1 + (n - 1) * 0.05,
    acc: 1 + (n - 1) * 0.1
  };
}

function startWave(n) {
  wave = n;
  intermission = false;
  let count = Math.min(3 + n, 9);
  game.enemies.startWave(count, waveMult(n), n);

  // 精英波（每 5 波）：领队强化成精英，必掉稀有补给
  if (n % 5 === 0) {
    const elite = game.enemies.enemies.find(e => e.alive);
    if (elite) {
      elite.hp *= 2.2;
      elite.root.scale.multiplyScalar(1.28);
      elite.elite = true;
      elite.typeLabel = '精英·' + elite.typeLabel;
    }
    hud.killfeed(`⚠ 第 ${n} 波 [精英] 来袭 — 重装敌人出现`);
  } else {
    hud.killfeed(`第 ${n} 波来袭 — ${count} 名敌人`);
  }
  sound.play('reload', { volume: 0.6, pitch: 0.8 });
}

// 波次肃清 → 强化三选一 → 下一波
function offerUpgrade() {
  intermission = true;
  state = 'upgrade';
  input.fire = false; input.ads = false;
  game.player.keys.clear();
  const cards = pickUpgradeCards(3, runTaken, runMods);
  hud.showUpgradeCards(cards, runTaken, (i) => {
    const u = cards[i];
    runTaken[u.id] = (runTaken[u.id] || 0) + 1;
    runPicks.push(u.name);
    u.apply(runMods, { player: game.player });
    game.weapon.runMods = runMods; // 注意：这里必须用 game.weapon（offerUpgrade 拿不到 startGame 的局部变量）
    // 玩家侧属性同步（移动/跳跃/冲刺/生命上限）
    game.player.moveMult = runMods.moveMult;
    game.player.extraJumps = runMods.extraJumps;
    game.player.hasDash = runMods.hasDash;
    game.player.dashCdMult = runMods.dashCdMult;
    game.player.maxHp = 100 + runMods.maxHpBonus;
    game.player.health = Math.min(game.player.health, game.player.maxHp);
    hud.killfeed(`强化获得：${u.name} — ${u.desc}`);
    sound.play('hurt', { volume: 0.4, pitch: 1.8 });
    state = 'playing';
    waveDelay = 1.3; // 帧驱动：1.3 秒游戏时间后开下一波
  });
}

function resumeGame() {
  state = 'playing';
  hud.showScreen(null);
  tryLock();
}

function onPlayerDeath() {
  if (state !== 'playing') return; // 防重入：多个弹同帧命中只走一次
  state = 'dead';
  input.fire = false;
  input.ads = false;
  game.player.keys.clear();
  sound.play('explosion', { volume: 0.8, pitch: 0.7 });

  // 生存模式（类肉鸽）：阵亡即结算本局 Build
  if (gameMode === 'survival') {
    let best = 0;
    try { best = +localStorage.getItem('ab_bestwave') || 0; } catch (e) {}
    if (wave > best) {
      best = wave;
      try { localStorage.setItem('ab_bestwave', String(best)); } catch (e) {}
    }
    hud.setWinTitle('生 存 终 结');
    const acc = shotsFired > 0 ? Math.round(shotsHit / shotsFired * 100) : 0;
    const build = runPicks.length ? `强化：${runPicks.join(' · ')}` : '未获得强化';
    hud.winStats(`撑到第 ${wave} 波 · 击杀 ${kills} · 命中率 ${acc}%\n${build}\n历史最佳：第 ${best} 波`);
    hud.showScreen('win');
    state = 'win';
    document.exitPointerLock();
    return;
  }

  hud.showScreen('death');
  let n = 3;
  hud.deathCountdown(n);
  const iv = setInterval(() => {
    if (state !== 'dead') { clearInterval(iv); return; }
    n--;
    if (n > 0) { hud.deathCountdown(n); return; }
    clearInterval(iv);
    game.player.respawn(assets.level.playerSpawn);
    game.weapon.resetAmmo(); // 重生补满弹药
    hud.healFlash();         // 绿闪提示状态已重置
    // 清除敌人仇恨，并把出生点 15m 内的敌人传送走——消灭"重生即死"循环
    for (const e of game.enemies.enemies) {
      e.aggro = false;
      e.loseTimer = 0;
      e.burstLeft = 0;
      if (e.pos.distanceTo(assets.level.playerSpawn) < 15) {
        const far = assets.level.enemySpawns.filter(p => p.distanceTo(assets.level.playerSpawn) > 15);
        e.spawnAt(far.length ? far[(Math.random() * far.length) | 0] : assets.level.enemySpawns[0]);
      } else {
        e.pickPatrolTarget();
      }
    }
    hud.showScreen(null);
    state = 'playing';
    // 不绕暂停页：若指针锁丢了，屏幕会显示"点击画面锁定鼠标"，
    // 点一下画面即可恢复视角（tryLock 带冷却重试会自动补锁）
    if (document.pointerLockElement !== renderer.domElement) tryLock();
  }, 1000);
}

function onEnemyKilled(e) {
  kills++;
  // 吸血强化
  if (runMods.lifesteal > 0) game.player.heal(runMods.lifesteal);
  // 掉落判定：低血量更容易出药水；掉率强化生效
  const dm = runMods.dropRate || 1;
  const roll = Math.random();
  const wantHeal = (game.player.health < 70 ? 0.45 : 0.22) * dm;
  if (roll < wantHeal) game.drops.spawn(e.pos, 'heal');
  else if (roll < 0.62 * dm) game.drops.spawn(e.pos, 'ammo');
  // 精英必掉双补给
  if (e.elite) { game.drops.spawn(e.pos, 'heal'); game.drops.spawn(e.pos, 'ammo'); }
  hud.killfeed(`✔ 击杀 敌方 ${e.typeLabel || 'unit'}`);

  if (gameMode === 'survival') {
    // 波次清算：全部肃清 → 强化三选一 → 下一波
    if (game.enemies.aliveCount() === 0 && !intermission && state === 'playing') {
      intermission = true;
      hud.killfeed(`第 ${wave} 波肃清！`);
      game.player.heal(30);
      game.weapon.resetAmmo();
      hud.healFlash();
      sound.play('hurt', { volume: 0.5, pitch: 1.4 });
      upgradeDelay = 0.8; // 帧驱动延迟后弹出强化选择
    }
    return;
  }

  // 经典模式：10 杀获胜
  if (kills >= WIN_KILLS) {
    state = 'win';
    hud.setWinTitle('胜 利');
    const acc = shotsFired > 0 ? Math.round(shotsHit / shotsFired * 100) : 0;
    hud.winStats(`击杀 ${kills} · 命中率 ${acc}%`);
    hud.showScreen('win');
    document.exitPointerLock();
  }
}

// ---------- 输入 ----------
const input = { fire: false, ads: false, lookDX: 0, lookDY: 0 };

document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR' && game && state === 'playing') game.weapon.startReload();
  if (state === 'upgrade' && game) {
    // 强化三选一（保持指针锁定，无需解锁鼠标）
    if (e.code === 'Digit1') hud.pickCard(0);
    if (e.code === 'Digit2') hud.pickCard(1);
    if (e.code === 'Digit3') hud.pickCard(2);
    return;
  }
  if (state === 'playing' && game) {
    if (e.code === 'Digit1') game.weapon.switchTo(0);
    if (e.code === 'Digit2') game.weapon.switchTo(1);
    if (e.code === 'Digit3') game.weapon.switchTo(2);
  }
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight', 'KeyQ'].includes(e.code)) {
    game && game.player.keys.add(e.code);
    if (e.code === 'Space') e.preventDefault();
  }
});
document.addEventListener('wheel', (e) => {
  if (state !== 'playing' || document.pointerLockElement !== renderer.domElement) return;
  game && game.weapon.cycle(e.deltaY > 0 ? 1 : -1);
}, { passive: true });
document.addEventListener('keyup', (e) => {
  game && game.player.keys.delete(e.code);
});

document.addEventListener('mousedown', (e) => {
  if (state !== 'playing') return;
  if (document.pointerLockElement !== renderer.domElement) {
    // 锁丢失/未获取时，点画面重新锁定（点击是新鲜手势，直接发起）
    tryLock();
    return;
  }
  if (e.button === 0) { input.fire = true; if (window.__dbg) window.__fireCnt++; }
  if (e.button === 2) input.ads = true;
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 0) input.fire = false;
  if (e.button === 2) input.ads = false;
});
document.addEventListener('contextmenu', (e) => e.preventDefault());

document.addEventListener('mousemove', (e) => {
  if (state !== 'playing' || document.pointerLockElement !== renderer.domElement) return;
  const dx = Math.max(-60, Math.min(60, e.movementX));
  const dy = Math.max(-60, Math.min(60, e.movementY));
  game && game.player.look(dx, dy);
  input.lookDX += dx;
  input.lookDY += dy;
});

// 丢锁 = 暂停
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== renderer.domElement && state === 'playing') {
    state = 'paused';
    input.fire = false; input.ads = false;
    game && game.player.keys.clear();
    updateStartButtons();
    hud.showScreen('start');
  }
});

// ---------- 主循环 ----------
let fpsFrames = 0, fpsAcc = 0;
renderer.setAnimationLoop(() => {
  try {
    const dt = Math.min(clock.getDelta(), 0.05);
    if (game && (state === 'playing' || state === 'dead')) {
      if (state === 'playing') {
        game.player.update(dt);
        game.weapon.update(dt, input, targets());
        game.drops.update(dt, game.player, onDropPickup);
        // 帧驱动的流程计时（强化选择 / 下一波）
        if (upgradeDelay >= 0) {
          upgradeDelay -= dt;
          if (upgradeDelay < 0) offerUpgrade();
        }
        if (waveDelay >= 0) {
          waveDelay -= dt;
          if (waveDelay < 0) startWave(wave + 1);
        }
      }
      game.enemies.update(dt);
      game.effects.update(dt);
      updateHUD();
      if (window.__autoTick) window.__autoTick(dt); // 自测阶段推进（帧驱动）
    } else if (game && state === 'paused') {
      game.effects.update(dt);
    }
    renderer.render(scene, camera);
    // FPS 统计 + 自适应分辨率（掉帧降采样保帧率）
    fpsFrames++; fpsAcc += dt;
    if (fpsAcc >= 0.5) {
      const fps = Math.round(fpsFrames / fpsAcc);
      if (settings.fps) hud.setFps(fps);
      if (state === 'playing' || state === 'paused') {
        if (fps < 45 && pixelRatio > 0.6) {
          pixelRatio = Math.max(0.6, pixelRatio - 0.25);
          renderer.setPixelRatio(pixelRatio);
        } else if (fps > 58 && pixelRatio < Math.min(window.devicePixelRatio, 2)) {
          pixelRatio = Math.min(Math.min(window.devicePixelRatio, 2), pixelRatio + 0.1);
          renderer.setPixelRatio(pixelRatio);
        }
      }
      fpsFrames = 0; fpsAcc = 0;
    }
  } catch (e) {
    if (!window.__loopErr) {
      window.__loopErr = true;
      window.__loopErrTitle = 'LOOP错误: ' + e.message + ' | ' + String(e.stack || '').split('\n')[1];
      document.title = window.__loopErrTitle;
      console.error(e);
    }
  }
});

function targets() {
  return assets.level.hitMeshes.concat(game.enemies.aliveHitMeshes());
}

function onDropPickup(type) {
  if (type === 'heal') {
    game.player.health = Math.min(100, game.player.health + 35);
    hud.healFlash();
    sound.play('hurt', { volume: 0.4, pitch: 1.6 });
  } else {
    const w = game.weapon.cur();
    w.reserve += Math.ceil(w.cfg.mag * 0.75);
    sound.play('reload', { volume: 0.5, pitch: 1.5 });
  }
}

function updateHUD() {
  const p = game.player, W = game.weapon, w = W.cur();
  hud.setHealth(p.health);
  hud.setAmmo(w.ammo, w.reserve, w.reloading, 1 - w.reloadT / 1.6);
  hud.setCrosshairGap(W.crosshairGap());
  const locked = document.pointerLockElement === renderer.domElement;
  hud.setLockHint(state === 'playing' && !locked);
  // 冲刺冷却指示（解锁相位冲刺后显示）
  if (p.hasDash) hud.setDash(p.dashCd > 0 ? `Q 冲刺 ${p.dashCd.toFixed(1)}s` : 'Q 冲刺 就绪');
  else hud.setDash('');
  // 顶部战况按模式显示
  if (gameMode === 'survival') hud.setTopStat('波次 WAVE', String(wave), `剩余敌人 ${game.enemies.aliveCount()}`);
  else hud.setTopStat('击杀 KILLS', String(kills), `目标 ${WIN_KILLS} 杀`);
  // 狙击开镜镜筒
  hud.setScope(W.adsActive && w.cfg.adsZoom < 0.5);
  if (window.__dbg) {
    window.__fireCnt = window.__fireCnt || 0;
    const e0 = game.enemies.enemies[0];
    document.getElementById('debugbar').textContent =
      `state=${state} 模式=${gameMode} 锁=${locked ? '是' : '否'} fire=${input.fire} ads=${input.ads}\n` +
      `HP=${p.health} 弹=${w.ammo}/${w.reserve} 换弹=${w.reloading} 击杀=${kills} 敌活=${game.enemies.aliveCount()} 波=${wave}\n` +
      `武器=${W.idx + 1}.${w.cfg.name} 动画=${e0 && e0.mixer ? e0.mixer.time.toFixed(1) : '-'} 重映射=${window.__animRemap ?? '-'} 敌0态=${e0 ? e0.state : '-'}`;
  }
}

// ---------- 自动化自测（?autotest=1）：自动开局、移动、瞄准射击，结果写进页面标题 ----------
// 阶段推进用"游戏内时间"（rAF 帧累加），标签页被切到后台时测试自动暂停，不会跑飞
if (new URLSearchParams(location.search).get('debug')) {
  window.__dbg = true;
  const db = document.getElementById('debugbar');
  db.style.display = 'block';
  // 调试钩子：允许外部工具（内置浏览器检查）读取游戏状态、传送视角
  Object.defineProperty(window, '__GD', {
    get: () => game && ({
      get player() { return game.player; },
      get enemies() { return game.enemies; },
      get state() { return state; },
      input,
      teleport(x, z, yaw = 0, pitch = 0) {
        game.player.pos.set(x, 0, z);
        game.player.vel.set(0, 0, 0);
        game.player.yaw = yaw;
        game.player.pitch = pitch;
      }
    })
  });
}
if (new URLSearchParams(location.search).get('autotest')) {
  const T = {
    started: false, moved: false, hit: false, killed: false,
    died: false, respawned: false, err: '', pos0: null
  };
  let S = null; // {t} 以渲染帧推进的阶段状态

  const report = () => {
    if (window.__loopErrTitle) { document.title = window.__loopErrTitle; return; } // 循环报错优先展示，不被覆盖
    const bits = [];
    bits.push(T.started ? '启✓' : '启…');
    bits.push(T.moved ? '移✓' : '移✗');
    bits.push(T.hit ? '中✓' : '中…');
    bits.push(T.killed ? '杀✓' : '杀…');
    bits.push(T.died ? '死✓' : '死…');
    bits.push(T.respawned ? '生✓' : '生…');
    if (T.err) bits.push('E:' + T.err);
    if (window.__loopErr) bits.push('LOOPerr!');
    if (window.__shotDbg) bits.push(window.__shotDbg);
    if (game) bits.push(`HP${game.player.health}|弹${game.weapon.cur().ammo}|杀${kills}|发${shotsFired}|态${state}`);
    document.title = '自测 ' + bits.join(' ');
  };
  setInterval(report, 700);

  // 每个渲染帧调用一次（主循环里），保证只在画面真正渲染时推进
  window.__autoTick = (dt) => {
    if (!S || S.done) return;
    try {
      S.t += dt;
      const aim = () => {
        let best = null, bd = 1e9;
        for (const e of game.enemies.enemies) {
          if (!e.alive) continue;
          const d = e.pos.distanceTo(game.player.pos);
          if (d < bd) { bd = d; best = e; }
        }
        if (!best) return false;
        const eye = game.player.eyePos;
        const target = best.pos.clone().add(new THREE.Vector3(0, 1.15, 0));
        const d = target.clone().sub(eye);
        const hd = Math.hypot(d.x, d.z);
        game.player.yaw = Math.atan2(-d.x, -d.z);
        game.player.pitch = Math.atan2(d.y, hd);
        game.player.recoil = 0; // 自测抵消后坐力上跳
        game.weapon.bloom = 0;  // 自测抵消连发扩散
        return true;
      };

      if (state === 'dead') T.died = true;
      if (T.died && !T.respawned && state === 'playing' && game.player.alive && game.player.health >= 100) {
        T.respawned = true;
        game.player.health = 1e9;
      }
      if (!game.player.alive && state === 'playing') {
        game.player.respawn(game.player.pos.clone().setY(0.1)); // 兜底
      }

      if (S.t < 2) {
        game.player.keys.add('KeyW');
        if (!aim()) game.player.yaw += 0.6 * dt;
        if (S.t > 1.5 && T.pos0 && game.player.pos.distanceTo(T.pos0) > 1) T.moved = true;
      } else if (S.t < 35) {
        game.player.keys.delete('KeyW');
        aim();
        input.fire = !T.killed;
        if (shotsHit > 0) T.hit = true;
        if (kills > 0) T.killed = true;
        if (T.killed && !T.died && state === 'playing') game.player.health = 5; // 故意送死，验证重生
      } else {
        input.fire = false;
        S.done = true;
      }
    } catch (e) { T.err = String(e).slice(0, 40); S.done = true; }
  };

  const waitReady = setInterval(() => {
    if (state !== 'ready') return;
    clearInterval(waitReady);
    try {
      startGame();
      game.player.health = 1e9; // 自测前期无敌，保证先验证击杀再验证死亡
      window.__shotDbg = '';    // 开启射击探针（weapon 里检测到该字段就上报）
      T.started = true;
      T.pos0 = game.player.pos.clone();
      S = { t: 0, done: false };
    } catch (e) {
      T.err = String(e).slice(0, 60);
      document.title = '自测失败 ' + T.err;
    }
  }, 300);
}

