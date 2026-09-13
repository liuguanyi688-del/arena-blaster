// 肉鸽强化系统：局内成长属性（runMods）+ 强化卡池
// runMods 由 main 持有并注入武器/玩家消费；卡片选择后 apply 即刻生效

export function defaultRunMods() {
  return {
    dmgMult: 1, rpmMult: 1, magMult: 1, reloadMult: 1,
    moveMult: 1, maxHpBonus: 0, extraJumps: 0,
    lifesteal: 0, critChance: 0, explosive: 0, pierce: 0,
    dropRate: 1, hasDash: false, dashCdMult: 1
  };
}

export const UPGRADES = [
  // ---- 常见 ----
  { id: 'dmg',    name: '火力全开', desc: '伤害 +25%',                    rarity: 'common', max: 5, apply: m => { m.dmgMult += 0.25; } },
  { id: 'rpm',    name: '极速扳机', desc: '射速 +20%',                    rarity: 'common', max: 4, apply: m => { m.rpmMult += 0.2; } },
  { id: 'mag',    name: '扩容弹匣', desc: '弹匣容量 +50%',                rarity: 'common', max: 3, apply: m => { m.magMult += 0.5; } },
  { id: 'reload', name: '快速装填', desc: '换弹速度 +30%',                rarity: 'common', max: 3, apply: m => { m.reloadMult += 0.3; } },
  { id: 'hp',     name: '强化体魄', desc: '最大生命 +25，并立即回满',     rarity: 'common', max: 4,
    apply: (m, ctx) => { m.maxHpBonus += 25; ctx.player.maxHp += 25; ctx.player.health = ctx.player.maxHp; } },
  { id: 'speed',  name: '轻装疾行', desc: '移动速度 +12%',                rarity: 'common', max: 3, apply: m => { m.moveMult += 0.12; } },
  { id: 'leech',  name: '嗜血',     desc: '每次击杀回复 5 点生命',        rarity: 'common', max: 3, apply: m => { m.lifesteal += 5; } },
  { id: 'drops',  name: '寻宝直觉', desc: '补给掉落概率 +40%',            rarity: 'common', max: 2, apply: m => { m.dropRate += 0.4; } },

  // ---- 稀有 ----
  { id: 'crit',   name: '弱点洞察', desc: '20% 概率造成双倍暴击',         rarity: 'rare', max: 2, apply: m => { m.critChance += 0.2; } },
  { id: 'pierce', name: '贯穿弹',   desc: '子弹可额外穿透 1 名敌人',      rarity: 'rare', max: 2, apply: m => { m.pierce += 1; } },
  { id: 'boom',   name: '高爆弹头', desc: '命中点爆炸，波及附近敌人',     rarity: 'rare', max: 2, apply: m => { m.explosive += 1; } },
  { id: 'dash',   name: '相位冲刺', desc: '解锁 Q 键冲刺（朝移动方向瞬移）', rarity: 'rare', max: 1, apply: m => { m.hasDash = true; } },
  { id: 'djump',  name: '浮空靴',   desc: '解锁二段跳',                   rarity: 'rare', max: 1, apply: m => { m.extraJumps += 1; } },

  // ---- 史诗 ----
  { id: 'dashcd', name: '冲刺共振', desc: '冲刺冷却 -40%（需已解锁冲刺）', rarity: 'epic', max: 1,
    need: m => m.hasDash, apply: m => { m.dashCdMult = 0.6; } },
  { id: 'frenzy', name: '狂乱',     desc: '伤害 +60%，但最大生命 -20',    rarity: 'epic', max: 1,
    apply: (m, ctx) => {
      m.dmgMult += 0.6;
      m.maxHpBonus -= 20;
      ctx.player.maxHp = Math.max(30, ctx.player.maxHp - 20);
      ctx.player.health = Math.min(ctx.player.health, ctx.player.maxHp);
    } },
  { id: 'godspeed', name: '神速',   desc: '射速 +50%，移动 +20%',         rarity: 'epic', max: 1,
    apply: m => { m.rpmMult += 0.5; m.moveMult += 0.2; } }
];

const RARITY_WEIGHT = { common: 60, rare: 32, epic: 8 };
const RARITY_LABEL = { common: '常见', rare: '稀有', epic: '史诗' };
export const rarityLabel = r => RARITY_LABEL[r] || r;

// 从卡池抽 3 张不重复的卡（过滤已达上限/不满足前置的，按稀有度加权）
export function pickUpgradeCards(count, taken, mods) {
  taken = taken || {};
  mods = mods || defaultRunMods();
  const pool = UPGRADES.filter(u => (taken[u.id] || 0) < u.max && (!u.need || u.need(mods)));
  const picked = [];
  const poolCopy = [...pool];
  while (picked.length < count && poolCopy.length > 0) {
    let total = 0;
    for (const u of poolCopy) total += RARITY_WEIGHT[u.rarity] || 10;
    let roll = Math.random() * total;
    let chosen = poolCopy[0], chosenIdx = 0;
    for (let i = 0; i < poolCopy.length; i++) {
      roll -= RARITY_WEIGHT[poolCopy[i].rarity] || 10;
      if (roll <= 0) { chosen = poolCopy[i]; chosenIdx = i; break; }
    }
    picked.push(chosen);
    poolCopy.splice(chosenIdx, 1);
  }
  return picked;
}
