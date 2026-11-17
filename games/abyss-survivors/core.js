/*
 * 深淵倖存者 Abyss Survivors — core simulation (pure ES module, no DOM, runs in Node).
 * See SPEC.md for the module contract. Internal (non-contract) fields on state objects are prefixed with "_".
 */

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* =====================================================================
 * RNG + hash
 * ===================================================================== */
export function mulberry32(a) {
  a = a >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash3(x, z, s) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = Math.imul(h ^ (h >>> 16), 2246822519);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/* =====================================================================
 * DATA
 * ===================================================================== */
const STAGES = {
  graveyard: { id: 'graveyard', name: '迷霧墓園', desc: '霧氣籠罩的古老墓地，亡者從墳中爬出。', order: 0, mult: 1, timeLimit: 480,
    boss: 'boss_bonelord', colors: { ground: '#1d2a2a', fog: '#6f9a95', accent: '#7fe0c8' },
    obstacles: [['tomb', 0.6, 5], ['deadtree', 0.5, 3], ['lantern', 0.32, 2]],
    pool: [[0, 'skeleton', 10], [15, 'bat', 6], [50, 'zombie', 6], [100, 'ghoul', 5], [150, 'wraith', 4], [190, 'cultist', 3],
      [230, 'bomber', 3], [270, 'deathknight', 2], [300, 'shaman', 2], [340, 'golem', 2], [380, 'hound', 3]],
    unlock: null },
  catacombs: { id: 'catacombs', name: '蛛網地穴', desc: '佈滿蛛網的地下墓穴，毒蛛盤據其中。', order: 1, mult: 1.25, timeLimit: 480,
    boss: 'boss_broodmother', colors: { ground: '#1f2418', fog: '#7a9a4a', accent: '#a6e05a' },
    obstacles: [['pillar', 0.8, 4], ['rubble', 0.85, 3], ['brazier', 0.5, 2]],
    pool: [[0, 'spider', 8], [0, 'skeleton', 6], [30, 'bat', 5], [70, 'zombie', 5], [110, 'cultist', 4], [150, 'bomber', 4],
      [180, 'ghoul', 4], [220, 'wraith', 3], [260, 'shaman', 2], [290, 'golem', 2], [330, 'deathknight', 2]],
    unlock: { kind: 'clear', stage: 'graveyard', desc: '擊敗「迷霧墓園」首領' } },
  inferno: { id: 'inferno', name: '熔火深淵', desc: '岩漿翻湧的深淵，惡魔與獄犬橫行。', order: 2, mult: 1.3, timeLimit: 480,
    boss: 'boss_pyrelord', colors: { ground: '#2a1410', fog: '#c8582a', accent: '#ff8a3a' },
    obstacles: [['spike', 0.55, 4], ['basalt', 1.0, 3], ['lavavent', 0.75, 2]],
    pool: [[0, 'skeleton', 7], [10, 'imp', 4], [35, 'hound', 4], [80, 'bomber', 5], [120, 'ghoul', 4], [160, 'cultist', 3],
      [230, 'golem', 1.5], [250, 'deathknight', 2], [280, 'shaman', 2], [320, 'wraith', 3]],
    unlock: { kind: 'clear', stage: 'catacombs', desc: '擊敗「蛛網地穴」首領' } },
  frostkeep: { id: 'frostkeep', name: '霜骨王座', desc: '冰封的亡者王座，寒氣能凍結靈魂。', order: 3, mult: 1.45, timeLimit: 480,
    boss: 'boss_frostlich', colors: { ground: '#1c2633', fog: '#9ec4e8', accent: '#bfe8ff' },
    obstacles: [['icecrystal', 0.75, 4], ['statue', 0.7, 3], ['pine', 0.6, 3]],
    pool: [[0, 'skeleton', 8], [10, 'frostling', 4], [40, 'wraith', 3], [80, 'hound', 4], [110, 'zombie', 4], [150, 'bat', 5],
      [200, 'deathknight', 2], [230, 'shaman', 2], [270, 'golem', 1.5], [300, 'cultist', 3], [340, 'bomber', 3]],
    unlock: { kind: 'clear', stage: 'inferno', desc: '擊敗「熔火深淵」首領' } }
};
const STAGE_IDS = Object.keys(STAGES);

const HEROES = {
  knight: { id: 'knight', name: '聖盾騎士', iconId: 'h_knight', weapon: 'sword', color: '#d8c27a',
    desc: '重甲護身的聖騎士，以劍氣橫掃群魔。', trait: '聖盾：每 10 秒獲得最大生命 20% 的護盾。',
    stats: { maxHp: 130, speed: 0.95, armor: 2, might: 1, area: 1, cd: 1, crit: 0.05 }, unlock: null },
  mage: { id: 'mage', name: '元素法師', iconId: 'h_mage', weapon: 'firebolt', color: '#7aa8ff',
    desc: '操縱元素的法師，火焰與冰霜皆聽其號令。', trait: '奧術湧動：冷卻 −10%、範圍 +10%。',
    stats: { maxHp: 90, speed: 1, armor: 0, might: 1, area: 1.1, cd: 0.9, crit: 0.05 }, unlock: null },
  ranger: { id: 'ranger', name: '暗影遊俠', iconId: 'h_ranger', weapon: 'arrows', color: '#7ad08a',
    desc: '行走於陰影的弓手，身手矯健、百步穿楊。', trait: '鷹眼：暴擊 +10%、衝刺 +1 次、移速 +8%。',
    stats: { maxHp: 100, speed: 1.08, armor: 0, might: 1, area: 1, cd: 1, crit: 0.15, dash: 1 },
    unlock: { kind: 'survive', v: 300, desc: '任一關卡存活 5 分鐘' } },
  necro: { id: 'necro', name: '亡靈召喚師', iconId: 'h_necro', weapon: 'minions', color: '#b48aff',
    desc: '戴著骷髏面具的術士，驅使亡者為其作戰。', trait: '靈魂收割：投射物與召喚數量 +1；每擊殺 150 隻敵人傷害 +2%（最多 +40%）。',
    stats: { maxHp: 105, speed: 1, armor: 0, might: 1, area: 1, cd: 1, crit: 0.05, amount: 1 },
    unlock: { kind: 'kills', v: 2500, desc: '累計擊殺 2500 隻敵人' } },
  berserker: { id: 'berserker', name: '狂戰士', iconId: 'h_berserker', weapon: 'axes', color: '#ff7a5a',
    desc: '雙斧在手的蠻族戰士，越是瀕死越是狂暴。', trait: '血怒：生命越低傷害越高（最多 +45%），擊殺回復 0.2 生命。',
    stats: { maxHp: 115, speed: 1.02, armor: 1, might: 1, area: 1, cd: 1, crit: 0.05, killHeal: 0.2 },
    unlock: { kind: 'win', v: 1, desc: '擊敗任一關卡首領' } }
};
const HERO_IDS = Object.keys(HEROES);

/* Weapons: base stats + 5 upgrades (levels 2..6). Fields: dmg cd area amount pierce speed dur */
const WEAPONS = {
  sword: { name: '橫掃劍刃', kind: 'phys', desc: '朝面向揮出弧形劍氣，橫掃前方敵人。', evo: 'holyblade', evoPassive: 'might',
    base: { dmg: 22, cd: 1.0, area: 3.2, amount: 1, pierce: 0, speed: 0, dur: 0 },
    up: [{ dmg: 7, t: '傷害 +7' }, { amount: 1, t: '同時向後揮砍' }, { area: 0.5, dmg: 5, t: '範圍 +0.5、傷害 +5' },
      { cd: -0.18, dmg: 6, t: '冷卻 −0.18 秒、傷害 +6' }, { amount: 1, dmg: 9, area: 0.4, t: '再多揮一刀、傷害 +9' }] },
  firebolt: { name: '火焰彈', kind: 'fire', desc: '射出追向最近敵人的火球，命中後爆炸。', evo: 'meteor', evoPassive: 'area',
    base: { dmg: 19, cd: 1.25, area: 1.5, amount: 1, pierce: 0, speed: 11, dur: 0 },
    up: [{ amount: 1, t: '火球 +1' }, { dmg: 9, t: '傷害 +9' }, { area: 0.5, t: '爆炸範圍 +0.5' },
      { amount: 1, cd: -0.15, t: '火球 +1、冷卻 −0.15 秒' }, { dmg: 14, area: 0.3, t: '傷害 +14、範圍 +0.3' }] },
  arrows: { name: '多重箭', kind: 'phys', desc: '朝最近的敵人扇形射出多支利箭，可穿透。', evo: 'arrowstorm', evoPassive: 'multishot',
    base: { dmg: 12, cd: 0.9, area: 1, amount: 2, pierce: 1, speed: 18, dur: 0 },
    up: [{ amount: 1, t: '箭矢 +1' }, { dmg: 5, pierce: 1, t: '傷害 +5、穿透 +1' }, { cd: -0.15, amount: 1, t: '冷卻 −0.15 秒、箭矢 +1' },
      { dmg: 7, t: '傷害 +7' }, { amount: 2, pierce: 1, t: '箭矢 +2、穿透 +1' }] },
  axes: { name: '迴旋飛斧', kind: 'phys', desc: '擲出會飛回來的旋轉飛斧，來回切割敵群。', evo: 'bloodaxes', evoPassive: 'vitality',
    base: { dmg: 15, cd: 1.55, area: 1, amount: 1, pierce: 99, speed: 13, dur: 1.6 },
    up: [{ amount: 1, t: '飛斧 +1' }, { dmg: 7, t: '傷害 +7' }, { area: 0.3, speed: 2, t: '飛斧變大、飛得更遠' },
      { amount: 1, cd: -0.2, t: '飛斧 +1、冷卻 −0.2 秒' }, { dmg: 11, amount: 1, t: '傷害 +11、飛斧 +1' }] },
  orbs: { name: '護體靈球', kind: 'holy', desc: '召喚環繞自身旋轉的靈球，碰觸敵人造成傷害。', evo: 'soulring', evoPassive: 'duration',
    base: { dmg: 13, cd: 4, area: 2.2, amount: 2, pierce: 0, speed: 3.3, dur: 3 },
    up: [{ amount: 1, t: '靈球 +1' }, { dmg: 6, area: 0.3, t: '傷害 +6、半徑 +0.3' }, { dur: 1, amount: 1, t: '持續 +1 秒、靈球 +1' },
      { dmg: 8, speed: 0.8, t: '傷害 +8、轉速提升' }, { amount: 1, dur: 1.5, t: '靈球 +1、持續 +1.5 秒' }] },
  chain: { name: '連鎖閃電', kind: 'light', desc: '雷擊最近的敵人並在敵人之間跳躍。', evo: 'thunderstorm', evoPassive: 'crit',
    base: { dmg: 21, cd: 1.4, area: 4.5, amount: 1, pierce: 3, speed: 0, dur: 0 },
    up: [{ pierce: 2, t: '跳躍 +2' }, { dmg: 9, t: '傷害 +9' }, { amount: 1, t: '閃電 +1' },
      { cd: -0.25, pierce: 2, t: '冷卻 −0.25 秒、跳躍 +2' }, { dmg: 15, amount: 1, t: '傷害 +15、閃電 +1' }] },
  nova: { name: '冰霜新星', kind: 'frost', desc: '以自身為中心爆發寒氣，凍結周圍敵人。', evo: 'blizzard', evoPassive: 'armor',
    base: { dmg: 15, cd: 2.5, area: 3.2, amount: 1, pierce: 0, speed: 0, dur: 0.9 },
    up: [{ dmg: 7, t: '傷害 +7' }, { area: 0.7, t: '範圍 +0.7' }, { dur: 0.4, cd: -0.3, t: '凍結 +0.4 秒、冷卻 −0.3 秒' },
      { dmg: 11, t: '傷害 +11' }, { area: 0.9, dmg: 9, t: '範圍 +0.9、傷害 +9' }] },
  aura: { name: '聖焰光環', kind: 'holy', desc: '身周燃起聖焰，持續灼傷靠近的敵人並使其減速。', evo: 'inferno_aura', evoPassive: 'regen',
    base: { dmg: 7, cd: 0.45, area: 2.0, amount: 1, pierce: 0, speed: 0, dur: 0 },
    up: [{ area: 0.4, t: '範圍 +0.4' }, { dmg: 4, t: '傷害 +4' }, { area: 0.4, cd: -0.05, t: '範圍 +0.4、頻率提升' },
      { dmg: 5, t: '傷害 +5' }, { area: 0.6, dmg: 5, t: '範圍 +0.6、傷害 +5' }] },
  daggers: { name: '連射飛刀', kind: 'phys', desc: '朝移動方向快速連射飛刀。', evo: 'thousand', evoPassive: 'swift',
    base: { dmg: 10, cd: 0.8, area: 1, amount: 2, pierce: 0, speed: 20, dur: 0 },
    up: [{ amount: 1, t: '飛刀 +1' }, { dmg: 5, t: '傷害 +5' }, { amount: 1, cd: -0.12, t: '飛刀 +1、冷卻 −0.12 秒' },
      { pierce: 1, dmg: 5, t: '穿透 +1、傷害 +5' }, { amount: 2, t: '飛刀 +2' }] },
  minions: { name: '骷髏僕從', kind: 'dark', desc: '召喚骷髏戰士為你作戰，牠們不會死亡。', evo: 'lichguard', evoPassive: 'magnet',
    base: { dmg: 18, cd: 0.7, area: 1, amount: 2, pierce: 0, speed: 0, dur: 0 },
    up: [{ amount: 1, t: '骷髏 +1' }, { dmg: 6, t: '傷害 +6' }, { amount: 1, t: '骷髏 +1' },
      { dmg: 7, cd: -0.12, t: '傷害 +7、攻速提升' }, { amount: 2, t: '骷髏 +2' }] },
  poison: { name: '劇毒瓶', kind: 'poison', desc: '向敵群拋出毒瓶，留下持續傷害的毒池。', evo: 'plague', evoPassive: 'luck',
    base: { dmg: 6, cd: 2.2, area: 1.8, amount: 1, pierce: 0, speed: 0, dur: 3.2 },
    up: [{ amount: 1, t: '毒瓶 +1' }, { area: 0.4, t: '毒池範圍 +0.4' }, { dmg: 3, dur: 1, t: '傷害 +3、持續 +1 秒' },
      { amount: 1, t: '毒瓶 +1' }, { dmg: 4, area: 0.5, t: '傷害 +4、範圍 +0.5' }] },
  spirits: { name: '怨靈追獵', kind: 'dark', desc: '放出會自動追蹤敵人的怨靈。', evo: 'reaper', evoPassive: 'haste',
    base: { dmg: 16, cd: 1.6, area: 1, amount: 2, pierce: 0, speed: 8, dur: 3 },
    up: [{ amount: 1, t: '怨靈 +1' }, { dmg: 7, t: '傷害 +7' }, { amount: 1, cd: -0.2, t: '怨靈 +1、冷卻 −0.2 秒' },
      { dmg: 9, pierce: 1, t: '傷害 +9、穿透 +1' }, { amount: 2, t: '怨靈 +2' }] }
};
const EVOS = {
  holyblade: { name: '聖光裁決', from: 'sword', kind: 'holy', desc: '360° 聖光斬擊，範圍與傷害大幅提升。', base: { dmg: 75, cd: 0.95, area: 4.4, amount: 1, pierce: 0, speed: 0, dur: 0 } },
  meteor: { name: '隕石術', from: 'firebolt', kind: 'fire', desc: '召喚隕石砸向敵群，造成大範圍爆炸。', base: { dmg: 95, cd: 1.5, area: 3.1, amount: 3, pierce: 0, speed: 0, dur: 0.8 } },
  arrowstorm: { name: '箭雨風暴', kind: 'phys', from: 'arrows', desc: '萬箭齊發並降下箭雨。', base: { dmg: 24, cd: 0.55, area: 2.6, amount: 9, pierce: 3, speed: 21, dur: 2 } },
  bloodaxes: { name: '嗜血旋斧', from: 'axes', kind: 'phys', desc: '大量嗜血飛斧盤旋而出，命中時吸取生命。', base: { dmg: 40, cd: 1.15, area: 1.3, amount: 6, pierce: 99, speed: 15, dur: 1.8 } },
  soulring: { name: '靈魂之環', from: 'orbs', kind: 'holy', desc: '永不熄滅的靈魂球環繞全身。', base: { dmg: 30, cd: 0, area: 3.2, amount: 7, pierce: 0, speed: 4.2, dur: 0 } },
  thunderstorm: { name: '雷霆風暴', from: 'chain', kind: 'light', desc: '雷雲籠罩戰場，落雷連續轟擊敵人。', base: { dmg: 80, cd: 0.8, area: 2.4, amount: 3, pierce: 4, speed: 0, dur: 0.7 } },
  blizzard: { name: '暴風雪', from: 'nova', kind: 'frost', desc: '身周捲起暴風雪，持續凍傷並減緩敵人。', base: { dmg: 24, cd: 0.35, area: 5.6, amount: 1, pierce: 0, speed: 0, dur: 1.2 } },
  inferno_aura: { name: '煉獄之環', from: 'aura', kind: 'fire', desc: '光環化為煉獄之火，點燃一切靠近的敵人。', base: { dmg: 17, cd: 0.32, area: 3.5, amount: 1, pierce: 0, speed: 0, dur: 0 } },
  thousand: { name: '千刃風暴', from: 'daggers', kind: 'phys', desc: '飛刀如暴雨般朝四面八方傾瀉。', base: { dmg: 17, cd: 0.065, area: 1, amount: 4, pierce: 2, speed: 22, dur: 0 } },
  lichguard: { name: '巫妖護衛', from: 'minions', kind: 'dark', desc: '巫妖加入亡者軍團，施放暗影閃電。', base: { dmg: 30, cd: 0.6, area: 5, amount: 4, pierce: 3, speed: 0, dur: 0 } },
  plague: { name: '瘟疫之雲', from: 'poison', kind: 'poison', desc: '巨大的瘟疫雲飄向敵群，被感染的敵人死亡時會擴散。', base: { dmg: 14, cd: 3.2, area: 3.6, amount: 2, pierce: 0, speed: 0, dur: 7 } },
  reaper: { name: '死神之鐮', from: 'spirits', kind: 'dark', desc: '巨大的鐮刀螺旋飛出，收割一切。', base: { dmg: 62, cd: 1.9, area: 1.5, amount: 3, pierce: 99, speed: 0, dur: 4 } }
};
const WEAPON_IDS = Object.keys(WEAPONS);
const EVO_IDS = Object.keys(EVOS);
const ALL_WEAPONS = {};
WEAPON_IDS.forEach(id => {
  const w = WEAPONS[id];
  ALL_WEAPONS[id] = Object.assign({ id, iconId: 'w_' + id, maxLevel: 6, evolved: false,
    levelDesc: [w.desc].concat(w.up.map(u => u.t)) }, w);
});
EVO_IDS.forEach(id => {
  const w = EVOS[id];
  ALL_WEAPONS[id] = Object.assign({ id, iconId: 'w_' + id, maxLevel: 1, evolved: true, up: [], levelDesc: [w.desc],
    evoPassive: WEAPONS[w.from].evoPassive }, w);
  WEAPONS[w.from].evo = id;
});

const PASSIVES = {
  might: { name: '力量', desc: '傷害 +10%', iconId: 'p_might' },
  haste: { name: '急速', desc: '冷卻 −7%', iconId: 'p_haste' },
  area: { name: '範圍', desc: '攻擊範圍 +10%', iconId: 'p_area' },
  multishot: { name: '分裂', desc: '投射物數量 +1（第 1、3、5 級）', iconId: 'p_multishot' },
  duration: { name: '持久', desc: '效果持續 +12%', iconId: 'p_duration' },
  armor: { name: '護甲', desc: '受到傷害 −1、減傷 +3%', iconId: 'p_armor' },
  vitality: { name: '體魄', desc: '最大生命 +20', iconId: 'p_vitality' },
  regen: { name: '再生', desc: '每秒回復 0.3 生命', iconId: 'p_regen' },
  swift: { name: '疾行', desc: '移動速度 +8%', iconId: 'p_swift' },
  magnet: { name: '磁力', desc: '拾取範圍 +30%', iconId: 'p_magnet' },
  luck: { name: '幸運', desc: '幸運 +10%（更多選項、寶箱與掉落）', iconId: 'p_luck' },
  crit: { name: '致命', desc: '暴擊率 +5%、暴擊傷害 +10%', iconId: 'p_crit' }
};
Object.keys(PASSIVES).forEach(id => { PASSIVES[id].id = id; PASSIVES[id].maxLevel = 5; });
const PASSIVE_IDS = Object.keys(PASSIVES);

/* Enemies. beh: behaviour code */
const ENEMIES = {
  skeleton: { name: '骷髏兵', hp: 11, speed: 2.5, dmg: 6, r: 0.42, xp: 1, beh: 'walk', color: '#d8d2bc' },
  zombie: { name: '腐屍', hp: 32, speed: 1.55, dmg: 9, r: 0.52, xp: 2, beh: 'walk', color: '#6f8a5a' },
  bat: { name: '血蝠', hp: 6, speed: 4.1, dmg: 4, r: 0.32, xp: 1, beh: 'bat', fly: true, color: '#a03040' },
  ghoul: { name: '食屍鬼', hp: 20, speed: 3.0, dmg: 8, r: 0.44, xp: 2, beh: 'lunge', color: '#8a7a6a' },
  spider: { name: '毒蛛', hp: 15, speed: 3.2, dmg: 6, r: 0.46, xp: 2, beh: 'zigzag', color: '#4a6a2a' },
  imp: { name: '小惡魔', hp: 15, speed: 2.8, dmg: 6, r: 0.4, xp: 2, beh: 'ranged', shot: 'e_fireball', range: 7.5, color: '#e05a2a' },
  cultist: { name: '邪教徒', hp: 28, speed: 2.0, dmg: 8, r: 0.46, xp: 3, beh: 'caster', shot: 'e_bolt', range: 8, color: '#6a3a8a' },
  wraith: { name: '怨靈', hp: 24, speed: 2.6, dmg: 10, r: 0.46, xp: 3, beh: 'blink', fly: true, color: '#9ab8e8' },
  golem: { name: '石魔', hp: 150, speed: 1.25, dmg: 22, r: 1.0, xp: 10, beh: 'stomp', color: '#7a7066' },
  bomber: { name: '爆裂蟲', hp: 10, speed: 3.7, dmg: 26, r: 0.42, xp: 2, beh: 'bomber', color: '#e0a030' },
  deathknight: { name: '亡靈騎士', hp: 95, speed: 2.0, dmg: 20, r: 0.62, xp: 8, beh: 'charger', color: '#4a5a7a' },
  shaman: { name: '骨巫', hp: 42, speed: 1.9, dmg: 6, r: 0.46, xp: 4, beh: 'healer', range: 6, color: '#c8b070' },
  hound: { name: '獄犬', hp: 16, speed: 4.0, dmg: 6, r: 0.46, xp: 2, beh: 'walk', pack: 4, color: '#b0401a' },
  frostling: { name: '冰魔', hp: 21, speed: 2.4, dmg: 7, r: 0.42, xp: 3, beh: 'ranged', shot: 'e_frost', range: 7, color: '#7ac8f0' },
  boss_bonelord: { name: '骸骨領主', hp: 5200, speed: 2.4, dmg: 26, r: 1.7, xp: 300, beh: 'boss', boss: true, scale: 3.4, color: '#e8dcb0' },
  boss_broodmother: { name: '蛛后', hp: 5600, speed: 2.6, dmg: 24, r: 1.9, xp: 300, beh: 'boss', boss: true, scale: 3.6, color: '#3a5a2a' },
  boss_pyrelord: { name: '熔火暴君', hp: 6200, speed: 2.3, dmg: 30, r: 1.9, xp: 300, beh: 'boss', boss: true, scale: 3.6, color: '#ff6a2a' },
  boss_frostlich: { name: '霜骨巫妖', hp: 5400, speed: 2.4, dmg: 26, r: 1.5, xp: 300, beh: 'boss', boss: true, fly: true, scale: 3.2, color: '#a8e0ff' }
};
Object.keys(ENEMIES).forEach(id => { ENEMIES[id].id = id; ENEMIES[id].iconId = 'e_' + id; if (!ENEMIES[id].scale) ENEMIES[id].scale = 1; });
const BEH = { walk: 0, bat: 1, lunge: 2, zigzag: 3, ranged: 4, caster: 5, blink: 6, stomp: 7, bomber: 8, charger: 9, healer: 10, boss: 11 };

const ELITE_AFFIXES = {
  swift: { name: '迅捷', color: '#ffe04a', desc: '移動速度大幅提升' },
  burning: { name: '烈焰', color: '#ff8a2a', desc: '經過之處留下火焰' },
  frozen: { name: '冰霜', color: '#6ae8ff', desc: '攻擊會使你減速，死亡時爆發寒氣' },
  vampiric: { name: '吸血', color: '#d0203a', desc: '攻擊時吸取生命並持續回復' },
  shielded: { name: '護盾', color: '#f0f4ff', desc: '受到可再生的護盾保護' },
  splitting: { name: '分裂', color: '#b060ff', desc: '死亡時分裂成多隻' }
};
Object.keys(ELITE_AFFIXES).forEach(id => { ELITE_AFFIXES[id].id = id; ELITE_AFFIXES[id].iconId = 'a_' + id; });
const AFFIX_IDS = Object.keys(ELITE_AFFIXES);

const DIFFICULTIES = {
  normal: { id: 'normal', name: '普通', idx: 0, hp: 1, dmg: 1, speed: 1, elite: 1, loot: 0, gold: 1, color: '#c8c8c8' },
  nightmare: { id: 'nightmare', name: '噩夢', idx: 1, hp: 2.3, dmg: 1.5, speed: 1.05, elite: 1.4, loot: 1, gold: 1.5, color: '#7aa8ff' },
  hell: { id: 'hell', name: '煉獄', idx: 2, hp: 5, dmg: 2.2, speed: 1.1, elite: 1.8, loot: 2, gold: 2.2, color: '#ff8a3a' },
  torment: { id: 'torment', name: '折磨', idx: 3, hp: 11, dmg: 3.2, speed: 1.15, elite: 2.3, loot: 3, gold: 3.2, color: '#ff3a5a' }
};
const DIFF_IDS = Object.keys(DIFFICULTIES);

const TALENTS = {
  hp: { name: '生命', desc: '最大生命 +10', max: 10, cost: 60, grow: 1.35, iconId: 't_hp' },
  dmg: { name: '傷害', desc: '傷害 +4%', max: 10, cost: 80, grow: 1.4, iconId: 't_dmg' },
  cd: { name: '冷卻', desc: '冷卻 −2.5%', max: 8, cost: 100, grow: 1.45, iconId: 't_cd' },
  speed: { name: '移速', desc: '移動速度 +3%', max: 5, cost: 70, grow: 1.4, iconId: 't_speed' },
  armor: { name: '護甲', desc: '護甲 +1', max: 5, cost: 120, grow: 1.5, iconId: 't_armor' },
  regen: { name: '再生', desc: '每秒回復 +0.1 生命', max: 5, cost: 90, grow: 1.45, iconId: 't_regen' },
  pickup: { name: '拾取', desc: '拾取範圍 +10%', max: 5, cost: 50, grow: 1.35, iconId: 't_pickup' },
  xp: { name: '經驗', desc: '經驗 +5%', max: 10, cost: 70, grow: 1.35, iconId: 't_xp' },
  gold: { name: '金幣', desc: '金幣 +8%', max: 10, cost: 60, grow: 1.35, iconId: 't_gold' },
  luck: { name: '幸運', desc: '幸運 +5%', max: 5, cost: 90, grow: 1.45, iconId: 't_luck' },
  revive: { name: '復活', desc: '死亡時復活一次', max: 2, cost: 600, grow: 2.5, iconId: 't_revive' },
  reroll: { name: '重抽', desc: '升級重抽次數 +1', max: 5, cost: 80, grow: 1.5, iconId: 't_reroll' },
  banish: { name: '放逐', desc: '放逐次數 +1', max: 3, cost: 100, grow: 1.6, iconId: 't_banish' },
  startLv: { name: '起始等級', desc: '開局立即升級 +1 次', max: 3, cost: 250, grow: 1.8, iconId: 't_startLv' }
};
Object.keys(TALENTS).forEach(id => { TALENTS[id].id = id; });
export function talentCost(id, level) { const t = TALENTS[id]; return Math.round(t.cost * Math.pow(t.grow, level) / 5) * 5; }

const SLOTS = { weapon: '武器', helm: '頭盔', armor: '護甲', ring: '戒指', amulet: '護符' };
const ITEMS = {
  w_blade: { slot: 'weapon', name: '符文長劍' }, w_staff: { slot: 'weapon', name: '深淵法杖' }, w_bow: { slot: 'weapon', name: '夜鴉長弓' },
  h_helm: { slot: 'helm', name: '鐵面盔' }, h_hood: { slot: 'helm', name: '影紗兜帽' }, h_crown: { slot: 'helm', name: '骨冠' },
  a_plate: { slot: 'armor', name: '聖紋板甲' }, a_robe: { slot: 'armor', name: '星紋法袍' }, a_leather: { slot: 'armor', name: '獸皮軟甲' },
  r_ring: { slot: 'ring', name: '血玉戒指' }, r_band: { slot: 'ring', name: '銀月指環' }, r_signet: { slot: 'ring', name: '黑曜印戒' },
  m_amulet: { slot: 'amulet', name: '灰燼護符' }, m_charm: { slot: 'amulet', name: '魂石墜飾' }, m_relic: { slot: 'amulet', name: '古神聖物' }
};
Object.keys(ITEMS).forEach(id => { ITEMS[id].id = id; ITEMS[id].iconId = 'i_' + id; });
const ITEM_IDS = Object.keys(ITEMS);
const ITEM_AFFIXES = {
  dmg: { name: '傷害', fmt: '+{v}% 傷害', min: 4, max: 10, int: true },
  hp: { name: '生命', fmt: '+{v} 生命', min: 8, max: 20, int: true },
  crit: { name: '暴擊', fmt: '+{v}% 暴擊率', min: 2, max: 6, int: true },
  critdmg: { name: '暴擊傷害', fmt: '+{v}% 暴擊傷害', min: 8, max: 20, int: true },
  area: { name: '範圍', fmt: '+{v}% 範圍', min: 4, max: 12, int: true },
  cdr: { name: '冷卻', fmt: '冷卻 −{v}%', min: 2, max: 6, int: true },
  speed: { name: '移速', fmt: '+{v}% 移動速度', min: 2, max: 6, int: true },
  armor: { name: '護甲', fmt: '+{v} 護甲', min: 1, max: 2, int: true },
  regen: { name: '再生', fmt: '每秒回復 +{v} 生命', min: 0.1, max: 0.4, int: false },
  pickup: { name: '拾取', fmt: '+{v}% 拾取範圍', min: 8, max: 20, int: true },
  xp: { name: '經驗', fmt: '+{v}% 經驗', min: 3, max: 8, int: true },
  gold: { name: '金幣', fmt: '+{v}% 金幣', min: 5, max: 15, int: true },
  killheal: { name: '擊殺回復', fmt: '擊殺回復 {v} 生命', min: 0.2, max: 0.6, int: false },
  luck: { name: '幸運', fmt: '+{v}% 幸運', min: 4, max: 10, int: true },
  dur: { name: '持續', fmt: '+{v}% 持續時間', min: 4, max: 10, int: true }
};
Object.keys(ITEM_AFFIXES).forEach(id => { ITEM_AFFIXES[id].id = id; });
const ITEM_AFFIX_IDS = Object.keys(ITEM_AFFIXES);
const LEGENDARIES = {
  phoenix: { name: '不死鳥之羽', desc: '死亡時復活一次（可與天賦疊加）。' },
  thorns: { name: '荊棘之心', desc: '受到接觸傷害時，對攻擊者造成 300% 反傷。' },
  frostbite: { name: '霜咬', desc: '攻擊有 8% 機率凍結敵人 1 秒。' },
  ember: { name: '餘燼', desc: '擊殺敵人有 15% 機率引發火焰爆炸。' },
  bloodpact: { name: '血契', desc: '造成傷害的 1% 轉化為生命（每秒最多 4）。' },
  echo: { name: '回響', desc: '所有武器投射物 +1。' },
  shadowstep: { name: '疾影', desc: '衝刺時釋放暗影新星傷害周圍敵人，衝刺冷卻 −25%。' },
  greed: { name: '貪婪', desc: '金幣 +50%、經驗 +20%。' },
  titan: { name: '泰坦之軀', desc: '最大生命 +40%、範圍 +20%、移速 −8%。' },
  stormcall: { name: '天雷', desc: '每 2.5 秒落雷轟擊畫面中的隨機敵人。' }
};
Object.keys(LEGENDARIES).forEach(id => { LEGENDARIES[id].id = id; LEGENDARIES[id].iconId = 'l_' + id; });
const LEG_IDS = Object.keys(LEGENDARIES);
const RARITIES = {
  common: { id: 'common', name: '普通', color: '#d6d6d6', affixes: 1, mult: 1, salvage: 6 },
  magic: { id: 'magic', name: '魔法', color: '#5aa8ff', affixes: 2, mult: 1.1, salvage: 15 },
  rare: { id: 'rare', name: '稀有', color: '#ffd84a', affixes: 3, mult: 1.25, salvage: 40 },
  legendary: { id: 'legendary', name: '傳說', color: '#ff9a2a', affixes: 4, mult: 1.4, salvage: 120 }
};
const RARITY_IDS = Object.keys(RARITIES);

const SHRINES = {
  shrine_power: { name: '力量祭壇', desc: '30 秒內傷害 +40%', color: '#ff5a4a' },
  shrine_haste: { name: '迅捷祭壇', desc: '30 秒內冷卻 −30%、移速 +15%', color: '#ffe04a' },
  shrine_guard: { name: '守護祭壇', desc: '30 秒內受到傷害 −50%', color: '#6ab8ff' },
  shrine_fortune: { name: '財富祭壇', desc: '30 秒內經驗 +50%、金幣 +100%、拾取範圍加倍', color: '#5aff9a' }
};
Object.keys(SHRINES).forEach(id => { SHRINES[id].id = id; });
const SHRINE_IDS = Object.keys(SHRINES);

export const DATA = {
  heroes: HEROES, weapons: ALL_WEAPONS, passives: PASSIVES, enemies: ENEMIES, stages: STAGES, items: ITEMS,
  affixes: ELITE_AFFIXES, itemAffixes: ITEM_AFFIXES, legendaries: LEGENDARIES, rarities: RARITIES, slots: SLOTS,
  difficulties: DIFFICULTIES, talents: TALENTS, shrines: SHRINES,
  ids: { heroes: HERO_IDS, stages: STAGE_IDS, weapons: WEAPON_IDS, evolutions: EVO_IDS, passives: PASSIVE_IDS,
    enemies: Object.keys(ENEMIES), affixes: AFFIX_IDS, difficulties: DIFF_IDS, items: ITEM_IDS, itemAffixes: ITEM_AFFIX_IDS,
    legendaries: LEG_IDS, rarities: RARITY_IDS, talents: Object.keys(TALENTS), shrines: SHRINE_IDS }
};

/* =====================================================================
 * Obstacles (deterministic from cell hash)
 * ===================================================================== */
const OB_CELL = 7, OB_DENS = 0.36;
const STAGE_SEED = { graveyard: 1013, catacombs: 2029, inferno: 3037, frostkeep: 4049 };
const OB = { x: 0, z: 0, r: 0, kind: '', seed: 0 };
function obstacleInCell(stageId, cx, cz) {
  const st = STAGES[stageId] || STAGES.graveyard;
  const s = STAGE_SEED[st.id];
  if (hash3(cx, cz, s) > OB_DENS) return false;
  const x = (cx + 0.18 + 0.64 * hash3(cx, cz, s + 1)) * OB_CELL;
  const z = (cz + 0.18 + 0.64 * hash3(cx, cz, s + 2)) * OB_CELL;
  if (x * x + z * z < 30) return false; // keep the spawn clear
  const list = st.obstacles;
  let tot = 0;
  for (let i = 0; i < list.length; i++) tot += list[i][2];
  let pick = hash3(cx, cz, s + 3) * tot, k = 0;
  for (; k < list.length - 1; k++) { pick -= list[k][2]; if (pick < 0) break; }
  OB.x = x; OB.z = z; OB.kind = list[k][0];
  OB.r = list[k][1] * (0.85 + 0.3 * hash3(cx, cz, s + 4));
  OB.seed = (hash3(cx, cz, s + 5) * 1e6) | 0;
  return true;
}
export function obstaclesNear(stageId, x, z, range) {
  const out = [];
  const c0 = Math.floor((x - range) / OB_CELL), c1 = Math.floor((x + range) / OB_CELL);
  const d0 = Math.floor((z - range) / OB_CELL), d1 = Math.floor((z + range) / OB_CELL);
  for (let cx = c0; cx <= c1; cx++) for (let cz = d0; cz <= d1; cz++) {
    if (obstacleInCell(stageId, cx, cz)) {
      const dx = OB.x - x, dz = OB.z - z;
      if (Math.abs(dx) <= range + OB.r && Math.abs(dz) <= range + OB.r) out.push({ x: OB.x, z: OB.z, r: OB.r, kind: OB.kind, seed: OB.seed });
    }
  }
  return out;
}
/** pushes ent out of nearby obstacles; returns 0 if none, else sign hint for tangent steering. */
function collideObstacles(stageId, ent, r, tx, tz) {
  const cx0 = Math.floor(ent.x / OB_CELL), cz0 = Math.floor(ent.z / OB_CELL);
  let hit = 0;
  for (let cx = cx0 - 1; cx <= cx0 + 1; cx++) for (let cz = cz0 - 1; cz <= cz0 + 1; cz++) {
    if (!obstacleInCell(stageId, cx, cz)) continue;
    const dx = ent.x - OB.x, dz = ent.z - OB.z, rr = OB.r + r;
    const d2 = dx * dx + dz * dz;
    if (d2 < rr * rr) {
      const d = Math.sqrt(d2) || 0.001;
      const nx = dx / d, nz = dz / d;
      ent.x = OB.x + nx * rr; ent.z = OB.z + nz * rr;
      // which way round: tangent toward target
      const cross = nx * tz - nz * tx;
      hit = cross >= 0 ? 1 : -1;
      OB._nx = nx; OB._nz = nz;
    }
  }
  return hit;
}
function insideObstacle(stageId, x, z, r) {
  const cx0 = Math.floor(x / OB_CELL), cz0 = Math.floor(z / OB_CELL);
  for (let cx = cx0 - 1; cx <= cx0 + 1; cx++) for (let cz = cz0 - 1; cz <= cz0 + 1; cz++) {
    if (!obstacleInCell(stageId, cx, cz)) continue;
    const dx = x - OB.x, dz = z - OB.z, rr = OB.r + r;
    if (dx * dx + dz * dz < rr * rr) return true;
  }
  return false;
}

/* =====================================================================
 * Spatial grid (counting sort, no allocation)
 * ===================================================================== */
const MAXE = 1400;
const G = 72, CS = 2.2, GN = G * G;
const cellStart = new Int32Array(GN + 1), cellFill = new Int32Array(GN), cellItems = new Int32Array(MAXE), entCell = new Int32Array(MAXE);
const qBuf = new Int32Array(MAXE);
let gridOX = 0, gridOZ = 0, gridN = 0;
function cellOf(x, z) {
  let cx = Math.floor((x - gridOX) / CS), cz = Math.floor((z - gridOZ) / CS);
  if (cx < 0) cx = 0; else if (cx >= G) cx = G - 1;
  if (cz < 0) cz = 0; else if (cz >= G) cz = G - 1;
  return cz * G + cx;
}
function buildGrid(E, n, px, pz) {
  gridOX = Math.floor(px / CS) * CS - (G * CS) / 2;
  gridOZ = Math.floor(pz / CS) * CS - (G * CS) / 2;
  cellStart.fill(0);
  gridN = n;
  for (let i = 0; i < n; i++) { const c = cellOf(E[i].x, E[i].z); entCell[i] = c; cellStart[c + 1]++; }
  for (let c = 0; c < GN; c++) cellStart[c + 1] += cellStart[c];
  for (let c = 0; c < GN; c++) cellFill[c] = cellStart[c];
  for (let i = 0; i < n; i++) cellItems[cellFill[entCell[i]]++] = i;
}
/** fill qBuf with indices of enemies whose cell overlaps the circle; returns count (caller does exact test) */
function queryCircle(x, z, r) {
  let cx0 = Math.floor((x - r - gridOX) / CS), cx1 = Math.floor((x + r - gridOX) / CS);
  let cz0 = Math.floor((z - r - gridOZ) / CS), cz1 = Math.floor((z + r - gridOZ) / CS);
  if (cx1 < 0 || cz1 < 0 || cx0 >= G || cz0 >= G) return 0;
  if (cx0 < 0) cx0 = 0; if (cz0 < 0) cz0 = 0; if (cx1 >= G) cx1 = G - 1; if (cz1 >= G) cz1 = G - 1;
  let n = 0;
  for (let cz = cz0; cz <= cz1; cz++) {
    const row = cz * G;
    for (let cx = cx0; cx <= cx1; cx++) {
      const c = row + cx;
      for (let k = cellStart[c], e = cellStart[c + 1]; k < e; k++) qBuf[n++] = cellItems[k];
    }
  }
  return n;
}

/* =====================================================================
 * Items
 * ===================================================================== */
function rollRarity(rng, diffIdx, minR, luck) {
  // weights per difficulty: common, magic, rare, legendary
  const w = [60 - diffIdx * 12, 30 + diffIdx * 3, 8.5 + diffIdx * 6, 1.5 + diffIdx * 3];
  w[2] *= luck; w[3] *= luck;
  for (let i = 0; i < minR; i++) w[i] = 0;
  let tot = w[0] + w[1] + w[2] + w[3], p = rng() * tot, k = 0;
  for (; k < 3; k++) { p -= w[k]; if (p < 0) break; }
  return RARITY_IDS[k];
}
export function generateItem(rngOrSeed, opts) {
  opts = opts || {};
  const rng = typeof rngOrSeed === 'function' ? rngOrSeed : mulberry32((rngOrSeed >>> 0) || 1);
  const diffIdx = opts.difficulty != null ? (typeof opts.difficulty === 'number' ? opts.difficulty : (DIFFICULTIES[opts.difficulty] || DIFFICULTIES.normal).idx) : 0;
  const minR = opts.minRarity ? RARITY_IDS.indexOf(opts.minRarity) : 0;
  const rarity = opts.rarity || rollRarity(rng, diffIdx, Math.max(0, minR), opts.luck || 1);
  const R = RARITIES[rarity];
  let baseId = opts.base;
  if (!baseId) {
    let pool = ITEM_IDS;
    if (opts.slot) pool = ITEM_IDS.filter(id => ITEMS[id].slot === opts.slot);
    baseId = pool[Math.floor(rng() * pool.length)];
  }
  const base = ITEMS[baseId];
  const ids = ITEM_AFFIX_IDS.slice();
  const affixes = [];
  for (let i = 0; i < R.affixes; i++) {
    const k = Math.floor(rng() * ids.length);
    const id = ids.splice(k, 1)[0];
    const A = ITEM_AFFIXES[id];
    let v = (A.min + (A.max - A.min) * rng()) * R.mult * (1 + 0.25 * diffIdx);
    v = A.int ? Math.max(1, Math.round(v)) : Math.round(v * 10) / 10;
    affixes.push({ id, v });
  }
  const legendary = rarity === 'legendary' ? LEG_IDS[Math.floor(rng() * LEG_IDS.length)] : null;
  const uid = 'it' + Math.floor(rng() * 2e9).toString(36) + Math.floor(rng() * 2e9).toString(36);
  const item = { uid, base: baseId, slot: base.slot, name: legendary ? LEGENDARIES[legendary].name : base.name, rarity,
    ilvl: diffIdx, affixes, legendary, iconId: base.iconId };
  item.power = itemPower(item);
  return item;
}
export function itemPower(item) {
  let p = 0;
  for (const a of item.affixes) { const A = ITEM_AFFIXES[a.id]; if (A) p += (a.v / A.max) * 10; }
  if (item.legendary) p += 25;
  return Math.round(p);
}
export function describeAffix(a) { const A = ITEM_AFFIXES[a.id]; return A ? A.fmt.replace('{v}', a.v) : a.id; }
export function salvageValue(item) { return Math.round((RARITIES[item.rarity] || RARITIES.common).salvage * (1 + 0.5 * (item.ilvl || 0))); }

/* =====================================================================
 * Stats
 * ===================================================================== */
function baseStats() {
  return { might: 1, cd: 1, area: 1, amount: 0, duration: 1, armor: 0, dr: 0, maxHp: 100, regen: 0, speed: 1, magnet: 1,
    luck: 1, crit: 0.05, critMult: 1.6, xp: 1, gold: 1, revive: 0, killHeal: 0, dashCharges: 1, dashCd: 3, lifesteal: 0,
    thorns: 0, freezeChance: 0, ember: 0, stormcall: 0, shadowstep: 0, hpMult: 1 };
}
/** meta: { talents: {id: level}, equipped: [item|null...] } → applied onto stats S */
function applyMeta(S, meta) {
  if (!meta) return;
  const T = meta.talents || {};
  const lv = id => Math.max(0, Math.min(TALENTS[id].max, T[id] | 0));
  S.maxHp += 10 * lv('hp'); S.might += 0.04 * lv('dmg'); S.cd *= 1 - 0.025 * lv('cd'); S.speed += 0.03 * lv('speed');
  S.armor += lv('armor'); S.regen += 0.1 * lv('regen'); S.magnet += 0.1 * lv('pickup'); S.xp += 0.05 * lv('xp');
  S.gold += 0.08 * lv('gold'); S.luck += 0.05 * lv('luck'); S.revive += lv('revive');
  const eq = meta.equipped || [];
  const list = Array.isArray(eq) ? eq : Object.keys(eq).map(k => eq[k]);
  for (const it of list) {
    if (!it || !it.affixes) continue;
    for (const a of it.affixes) {
      const v = +a.v || 0;
      switch (a.id) {
        case 'dmg': S.might += v / 100; break; case 'hp': S.maxHp += v; break; case 'crit': S.crit += v / 100; break;
        case 'critdmg': S.critMult += v / 100; break; case 'area': S.area += v / 100; break; case 'cdr': S.cd *= 1 - v / 100; break;
        case 'speed': S.speed += v / 100; break; case 'armor': S.armor += v; break; case 'regen': S.regen += v; break;
        case 'pickup': S.magnet += v / 100; break; case 'xp': S.xp += v / 100; break; case 'gold': S.gold += v / 100; break;
        case 'killheal': S.killHeal += v; break; case 'luck': S.luck += v / 100; break; case 'dur': S.duration += v / 100; break;
      }
    }
    switch (it.legendary) {
      case 'phoenix': S.revive += 1; break; case 'thorns': S.thorns += 3; break; case 'frostbite': S.freezeChance += 0.08; break;
      case 'ember': S.ember += 0.15; break; case 'bloodpact': S.lifesteal += 0.01; break; case 'echo': S.amount += 1; break;
      case 'shadowstep': S.shadowstep = 1; S.dashCd *= 0.75; break; case 'greed': S.gold += 0.5; S.xp += 0.2; break;
      case 'titan': S.hpMult *= 1.4; S.area += 0.2; S.speed -= 0.08; break; case 'stormcall': S.stormcall = 1; break;
    }
  }
}
function metaCounts(meta) {
  const T = (meta && meta.talents) || {};
  return { rerolls: 2 + Math.min(5, T.reroll | 0), banishes: 1 + Math.min(3, T.banish | 0), skips: 2, startLv: Math.min(3, T.startLv | 0) };
}
function xpForLevel(L) { return L === 1 ? 4 : L < 20 ? 2 + L * 9 : L < 40 ? 182 + (L - 20) * 15 : 482 + (L - 40) * 24; }

/* weapon stat computation (no allocation: writes into out) */
function weaponStats(id, level, out) {
  const W = ALL_WEAPONS[id];
  const b = W.base;
  out.dmg = b.dmg; out.cd = b.cd; out.area = b.area; out.amount = b.amount; out.pierce = b.pierce; out.speed = b.speed; out.dur = b.dur;
  for (let i = 0; i < level - 1 && i < W.up.length; i++) {
    const u = W.up[i];
    if (u.dmg) out.dmg += u.dmg; if (u.cd) out.cd += u.cd; if (u.area) out.area += u.area; if (u.amount) out.amount += u.amount;
    if (u.pierce) out.pierce += u.pierce; if (u.speed) out.speed += u.speed; if (u.dur) out.dur += u.dur;
  }
  return out;
}

/* =====================================================================
 * createGame
 * ===================================================================== */
export function createGame(opts) {
  opts = opts || {};
  const stageId = STAGES[opts.stage] ? opts.stage : 'graveyard';
  const heroId = HEROES[opts.hero] ? opts.hero : 'knight';
  const diffId = DIFFICULTIES[opts.difficulty] ? opts.difficulty : 'normal';
  const seed = (opts.seed == null ? 12345 : opts.seed) >>> 0;
  const meta = opts.meta || null;
  const ST = STAGES[stageId], HD = HEROES[heroId], DF = DIFFICULTIES[diffId];
  const rng = mulberry32(seed || 1);
  const rnd = (a, b) => a + rng() * (b - a);
  let nextId = 1;
  const events = [];
  let hitEvents = 0;

  const S = baseStats();
  const counts = metaCounts(meta);

  const player = { x: 0, z: 0, rot: 0, moveX: 0, moveZ: 0, speed: 0, hp: 100, maxHp: 100, shield: 0, level: 1, xp: 0, xpNext: xpForLevel(1),
    dashing: 0, dashCd: 0, dashCdMax: 3, invuln: 0, hurt: 0, hero: heroId, alive: true, pickupR: 1.8, auraR: 0, auraKind: '',
    dashCharges: 1, dashMax: 1, _dashT: 0, _dx: 0, _dz: 1, _slow: 0, _slowAmt: 0, _knightT: 0, _webT: 0, _lsBudget: 0, _ifr: 0 };
  const state = {
    time: 0, phase: 'play', stage: stageId, difficulty: diffId, hero: heroId, seed, timeLimit: ST.timeLimit, kills: 0, gold: 0, wave: 1,
    bossHp: null, endless: false, player, weapons: [], passives: [], enemies: [], projectiles: [], zones: [], allies: [], pickups: [],
    shrines: [], buffs: [], rerolls: counts.rerolls, banishes: counts.banishes, skips: counts.skips, pendingLevels: 0,
    chestsOpened: 0, elitesKilled: 0, _hurtBy: {}, bossKilled: false, revives: 0, banished: [], stats: S, dmgTaken: 0
  };
  const view = { halfW: 13, halfH: 10 };
  const input = { mx: 0, mz: 0, dash: false };
  let choices = [];
  let chestRewards = null;
  let summaryCache = null;
  let bossSpawned = false, nextEndlessBoss = 0, endlessCount = 0;
  let eliteIdx = 0, nextShrine = 55, spawnAcc = 0, lastWave = 1, stormT = 2.5, ringT = 0;
  const weaponTmp = { dmg: 0, cd: 0, area: 0, amount: 0, pierce: 0, speed: 0, dur: 0 };
  const E = state.enemies, P = state.projectiles, Z = state.zones, A = state.allies, K = state.pickups;

  // pools
  const poolE = [], poolP = [], poolZ = [], poolK = [];

  /* ---------- stats ---------- */
  function recalc() {
    const old = S.maxHp * S.hpMult;
    Object.assign(S, baseStats());
    const hs = HD.stats;
    S.maxHp = hs.maxHp; S.speed = hs.speed; S.armor = hs.armor; S.might = hs.might; S.area = hs.area; S.cd = hs.cd; S.crit = hs.crit;
    if (hs.duration) S.duration = hs.duration; if (hs.amount) S.amount += hs.amount; if (hs.dash) S.dashCharges += hs.dash; if (hs.killHeal) S.killHeal += hs.killHeal;
    applyMeta(S, meta);
    for (const ps of state.passives) {
      const L = ps.level;
      switch (ps.id) {
        case 'might': S.might += 0.1 * L; break; case 'haste': S.cd *= 1 - 0.07 * L; break; case 'area': S.area += 0.1 * L; break;
        case 'multishot': S.amount += L >= 5 ? 3 : L >= 3 ? 2 : 1; break; case 'duration': S.duration += 0.12 * L; break;
        case 'armor': S.armor += L; S.dr += 0.03 * L; break; case 'vitality': S.maxHp += 20 * L; break; case 'regen': S.regen += 0.3 * L; break;
        case 'swift': S.speed += 0.08 * L; break; case 'magnet': S.magnet += 0.3 * L; break; case 'luck': S.luck += 0.1 * L; break;
        case 'crit': S.crit += 0.05 * L; S.critMult += 0.1 * L; break;
      }
    }
    for (const b of state.buffs) {
      if (b.kind === 'shrine_power') S.might += 0.4;
      else if (b.kind === 'shrine_haste') { S.cd *= 0.7; S.speed += 0.15; }
      else if (b.kind === 'shrine_guard') S.dr += 0.5;
      else if (b.kind === 'shrine_fortune') { S.xp += 0.5; S.gold += 1; S.magnet *= 2; }
    }
    S.cd = Math.max(0.35, S.cd); S.dr = Math.min(0.75, S.dr);
    const mh = Math.round(S.maxHp * S.hpMult);
    if (old > 0 && mh > player.maxHp) player.hp += mh - player.maxHp;
    player.maxHp = mh; player.hp = Math.min(player.hp, mh);
    player.pickupR = 2.5 * S.magnet;
    player.dashMax = S.dashCharges; player.dashCdMax = S.dashCd;
    if (player.dashCharges > player.dashMax) player.dashCharges = player.dashMax;
    let aura = '';
    player.auraR = 0;
    for (const w of state.weapons) {
      if (w.id === 'aura' || w.id === 'inferno_aura') {
        weaponStats(w.id, w.level, weaponTmp);
        player.auraR = weaponTmp.area * S.area; aura = w.id === 'aura' ? 'holy' : 'fire';
      }
    }
    player.auraKind = aura;
  }

  /* ---------- helpers ---------- */
  function ev(o) { events.push(o); }
  function text(x, z, t, color) { ev({ type: 'text', x, z, text: t, color: color || '#fff' }); }

  function newEnemy(type) {
    const D = ENEMIES[type] || ENEMIES.skeleton;
    let e = poolE.pop();
    if (!e) e = { _ht: new Float32Array(4) };
    e.id = nextId++; e.type = D.id; e.x = 0; e.z = 0; e.rot = 0; e.r = D.r; e.hp = 1; e.maxHp = 1; e.scale = D.scale; e.elite = false;
    e.affix = ''; e.boss = !!D.boss; e.flash = 0; e.frozen = 0; e.burning = 0; e.poisoned = 0; e.slowed = 0; e.anim = 'spawn'; e.animT = 0;
    e.flying = !!D.fly; e.age = 0;
    e._D = D; e._beh = BEH[D.beh]; e._spd = D.speed; e._dmg = D.dmg; e._xp = D.xp; e._atk = 0; e._st = 0; e._t = rng() * 2; e._a = 0; e._b = 0;
    e._burnDps = 0; e._poisDps = 0; e._slowAmt = 0; e._shield = 0; e._shieldMax = 0; e._shT = 0; e._dead = false; e._kx = 0; e._kz = 0;
    e._clone = false; e._phase = 1; e._acd = 2; e._busy = 0; e._seq = 0; e._ang = 0; e._fireT = 0; e._tick = 0; e._plague = false; e._mini = false;
    e._ht[0] = e._ht[1] = e._ht[2] = e._ht[3] = -9;
    e._side = rng() < 0.5 ? -1 : 1;
    return e;
  }
  function stageMul() { return 1 + (ST.mult - 1) * Math.min(1, 0.35 + state.time / 320); }
  function scaleHp() {
    const t = state.time;
    let m = stageMul() * DF.hp * (1 + t / 85 + (t / 220) * (t / 220));
    if (state.endless) m *= 1 + (t - state.timeLimit) / 60;
    return m;
  }
  function scaleDmg() {
    const t = state.time;
    let m = (1 + 0.3 * (stageMul() - 1)) * DF.dmg * (1 + t / 240);
    if (state.endless) m *= 1 + (t - state.timeLimit) / 150;
    return m;
  }
  function spawnEnemy(type, x, z, opt) {
    if (E.length >= MAXE - 2) return null;
    if (E.length >= 520 && !(opt && opt.elite) && !(ENEMIES[type] && ENEMIES[type].boss)) return null;
    const e = newEnemy(type);
    const D = e._D;
    let hp = D.hp * scaleHp();
    if (D.boss) hp = D.hp * 3.8 * ST.mult * DF.hp * (state.endless ? 1 + endlessCount * 0.8 : 1);
    e.x = x; e.z = z;
    e._spd = D.speed * DF.speed * (0.92 + rng() * 0.16) * (1 + Math.min(0.25, state.time / 1600));
    e._dmg = D.dmg * scaleDmg();
    if (D.boss) { e._spd = D.speed * DF.speed; e._dmg = D.dmg * DF.dmg * (1 + 0.3 * (ST.mult - 1)) * 1.8 * (state.endless ? 1 + endlessCount * 0.4 : 1); }
    if (opt && opt.elite) {
      e.elite = true; hp *= 9; e.scale = 1.6 * D.scale; e.r = D.r * 1.5; e._dmg *= 1.5; e._xp = D.xp * 10;
      e.affix = opt.affix || AFFIX_IDS[Math.floor(rng() * AFFIX_IDS.length)];
      if (e.affix === 'swift') e._spd *= 1.55;
      if (e.affix === 'shielded') { e._shieldMax = hp * 0.4; e._shield = e._shieldMax; }
      ev({ type: 'spawn', x, z, enemy: e.type });
    }
    if (opt && opt.mini) { hp *= 0.35; e.scale *= 0.7; e.r *= 0.75; e._mini = true; e._xp = Math.max(1, Math.round(D.xp / 2)); }
    if (opt && opt.hpMul) hp *= opt.hpMul;
    e.hp = e.maxHp = Math.max(1, Math.round(hp));
    E.push(e);
    return e;
  }

  function newProj(kind, owner, x, z, vx, vz, r, life, dmg) {
    if (P.length >= 900) return null;
    let p = poolP.pop();
    if (!p) p = { _hits: new Int32Array(24) };
    p.id = nextId++; p.kind = kind; p.owner = owner; p.x = x; p.y = 1; p.z = z; p.vx = vx; p.vz = vz;
    p.rot = Math.atan2(vx, vz); p.r = r; p.age = 0; p.life = life;
    p._dmg = dmg; p._pierce = 0; p._nh = 0; p._src = -1; p._mode = 0; p._a = 0; p._b = 0; p._c = 0; p._t = 0; p._tgt = null; p._tx = 0; p._tz = 0;
    p._kind = 'phys'; p._dead = false; p._slow = 0; p._area = 0; p._heal = 0;
    P.push(p);
    return p;
  }
  function newZone(kind, owner, x, z, r, life) {
    if (Z.length >= 260) return null;
    let q = poolZ.pop();
    if (!q) q = {};
    q.id = nextId++; q.kind = kind; q.owner = owner; q.x = x; q.z = z; q.r = r; q.age = 0; q.life = life;
    q.angle = 0; q.len = 0; q.width = 0;
    q._fx = ''; q._dmg = 0; q._tick = 0; q._period = 0.5; q._src = -1; q._srcId = 0; q._kind = ''; q._follow = false; q._dead = false; q._n = 0; q._tx = 0; q._tz = 0;
    Z.push(q);
    return q;
  }
  function newPickup(kind, x, z, value) {
    let k = poolK.pop();
    if (!k) k = {};
    k.id = nextId++; k.kind = kind; k.x = x; k.z = z; k.age = 0; k.value = value; k.magnet = false; k._dead = false; k._v = 0;
    K.push(k);
    return k;
  }

  /* ---------- damage ---------- */
  function rageMult() {
    if (heroId !== 'berserker') return 1;
    return 1 + 0.45 * (1 - player.hp / player.maxHp);
  }
  function necroMult() { return heroId === 'necro' ? 1 + Math.min(0.4, Math.floor(state.kills / 150) * 0.02) : 1; }
  let dmgMulCache = 1;
  function hitEnemy(e, base, kind, src, noCrit) {
    if (e._dead || e.hp <= 0) return 0;
    let dmg = base * dmgMulCache;
    let crit = false;
    if (!noCrit && rng() < S.crit) { dmg *= S.critMult; crit = true; }
    if (e.anim === 'spawn' && e.age < 0.15) dmg *= 0.5;
    if (e._shield > 0) {
      const ab = Math.min(e._shield, dmg * 0.7);
      e._shield -= ab; dmg -= ab; e._shT = 0;
    }
    dmg = Math.max(1, dmg);
    e.hp -= dmg; e.flash = 1;
    if (src >= 0 && src < state.weapons.length) state.weapons[src]._dmg += dmg;
    if (S.lifesteal > 0 && player._lsBudget > 0) { const h = Math.min(player._lsBudget, dmg * S.lifesteal); player._lsBudget -= h; healPlayer(h, true); }
    if (S.freezeChance > 0 && !e.boss && rng() < S.freezeChance) e.frozen = Math.max(e.frozen, 1);
    if (hitEvents < 70 && (crit || dmg >= 4 || rng() < 0.3)) { hitEvents++; ev({ type: 'hit', x: e.x, z: e.z, dmg: Math.round(dmg), crit, kind, target: 'e' }); }
    if (e.hp <= 0) killEnemy(e, kind);
    return dmg;
  }
  function knock(e, fromX, fromZ, amt) {
    if (e.boss || e.elite && amt < 3) return;
    const dx = e.x - fromX, dz = e.z - fromZ, d = Math.sqrt(dx * dx + dz * dz) || 1;
    const m = amt / Math.max(0.6, e.r * 1.6);
    e._kx += dx / d * m; e._kz += dz / d * m;
  }
  function killEnemy(e, kind) {
    if (e._dead) return;
    e._dead = true; e.hp = 0;
    state.kills++;
    if (!e._clone) {
      // drops
      const xpv = e._xp * (1 + state.time / 600);
      if (!e.boss) dropXp(e.x, e.z, xpv);
      const lk = S.luck;
      const r = rng();
      if (r < 0.035 * lk) newPickup('gold', e.x + rnd(-0.3, 0.3), e.z + rnd(-0.3, 0.3), 1 + Math.floor(rng() * 3 * (1 + state.time / 240)));
      else if (r < 0.035 * lk + 0.0035 * lk) newPickup('heart', e.x, e.z, 30);
      else if (r < 0.035 * lk + 0.0035 * lk + 0.0011 * lk) newPickup('magnet', e.x, e.z, 0);
      else if (r < 0.035 * lk + 0.0035 * lk + 0.0011 * lk + 0.0012 * lk) newPickup('bomb', e.x, e.z, 0);
      if (e.elite) {
        state.elitesKilled++;
        newPickup('chest', e.x, e.z, 1);
        newPickup('gold', e.x + 0.8, e.z, Math.round(10 * (1 + DF.idx)));
      }
    }
    if (S.killHeal > 0) healPlayer(S.killHeal, true);
    if (S.ember > 0 && rng() < S.ember) { ev({ type: 'explode', x: e.x, z: e.z, r: 2, kind: 'fire' }); areaDamage(e.x, e.z, 2, 20 * (1 + state.time / 120), 'fire', -1, false); }
    if (e._plague) {
      const q = newZone('plague', 'p', e.x, e.z, 1.6, 2.5);
      if (q) { q._dmg = e._b || 8; q._period = 0.5; q._kind = 'poison'; }
    }
    ev({ type: 'kill', x: e.x, z: e.z, enemy: e.type, elite: e.elite, boss: e.boss, rot: e.rot, scale: e.scale });
    // affix on death
    if (e.elite && e.affix === 'splitting') {
      for (let i = 0; i < 3; i++) {
        const a = i / 3 * TAU;
        const m = spawnEnemy(e.type, e.x + Math.sin(a) * 0.8, e.z + Math.cos(a) * 0.8, { mini: true, hpMul: 2 });
        if (m) m.anim = 'walk';
      }
    }
    if (e.elite && e.affix === 'frozen') {
      ev({ type: 'nova', x: e.x, z: e.z, r: 3, kind: 'frost' });
      const q = newZone('frost', 'e', e.x, e.z, 3, 4); if (q) { q._dmg = 0; }
    }
    if (e._beh === BEH.spider && !e.elite) {
      const q = newZone('e_poison', 'e', e.x, e.z, 0.9, 2.2); if (q) { q._dmg = e._dmg * 0.25; }
    }
    // remove telegraphs owned by this enemy
    for (let i = 0; i < Z.length; i++) if (Z[i]._srcId === e.id && Z[i].owner === 'e' && Z[i].kind.indexOf('telegraph') === 0) Z[i]._dead = true;
    if (e.boss) onBossKilled(e);
  }
  function dropXp(x, z, v) {
    v *= 1;
    if (K.length > 520) {
      // merge into an existing gem
      for (let t = 0; t < 6; t++) {
        const k = K[Math.floor(rng() * K.length)];
        if (k && !k._dead && (k.kind === 'xp_s' || k.kind === 'xp_m' || k.kind === 'xp_l')) {
          k.value += v; k.kind = k.value >= 25 ? 'xp_l' : k.value >= 5 ? 'xp_m' : 'xp_s'; return;
        }
      }
    }
    newPickup(v >= 25 ? 'xp_l' : v >= 5 ? 'xp_m' : 'xp_s', x, z, v);
  }
  function areaDamage(x, z, r, dmg, kind, src, knockAmt, freeze, slow) {
    const n = queryCircle(x, z, r + 2);
    let c = 0;
    for (let k = 0; k < n; k++) {
      const e = E[qBuf[k]];
      if (e._dead) continue;
      const dx = e.x - x, dz = e.z - z, rr = r + e.r;
      if (dx * dx + dz * dz > rr * rr) continue;
      hitEnemy(e, dmg, kind, src);
      if (knockAmt) knock(e, x, z, knockAmt);
      if (freeze && !e.boss) e.frozen = Math.max(e.frozen, freeze);
      if (slow) { e.slowed = Math.max(e.slowed, slow); e._slowAmt = Math.max(e._slowAmt, 0.5); }
      c++;
    }
    return c;
  }
  function healPlayer(h, quiet) {
    if (!player.alive || h <= 0) return;
    const before = player.hp;
    player.hp = Math.min(player.maxHp, player.hp + h);
    if (!quiet && player.hp > before) ev({ type: 'heal', amount: Math.round(player.hp - before) });
  }
  function hurtPlayer(dmg, src, kind) {
    if (!player.alive || state.phase !== 'play') return;
    if (player.invuln > 0 || player.dashing > 0 || (src && player._ifr > 0)) return;
    if (src) player._ifr = 0.15;
    dmg = dmg * (1 - S.dr) - S.armor;
    dmg = Math.max(1, dmg);
    if (src && src.elite && src.affix === 'vampiric') { src.hp = Math.min(src.maxHp, src.hp + dmg * 3); }
    if (src && src.elite && src.affix === 'frozen') { player._slow = 1.5; player._slowAmt = 0.4; }
    if (src && S.thorns > 0 && !src._dead) hitEnemy(src, dmg * S.thorns * 3, 'phys', -1, true);
    if (player.shield > 0) { const a = Math.min(player.shield, dmg); player.shield -= a; dmg -= a; }
    if (dmg <= 0) return;
    player.hp -= dmg; player.hurt = 1; state.dmgTaken += dmg;
    const hk = src ? src.type : (kind || 'phys');
    state._hurtBy[hk] = (state._hurtBy[hk] || 0) + dmg;
    ev({ type: 'hurt', dmg: Math.round(dmg) });
    ev({ type: 'hit', x: player.x, z: player.z, dmg: Math.round(dmg), crit: false, kind: kind || 'phys', target: 'p' });
    if (player.hp <= 0) {
      if (S.revive > state.revives) {
        state.revives++;
        player.hp = player.maxHp * 0.6; player.invuln = 2.5;
        ev({ type: 'nova', x: player.x, z: player.z, r: 7, kind: 'holy' });
        areaDamage(player.x, player.z, 7, 200 * (1 + state.time / 60), 'holy', -1, 6);
        text(player.x, player.z, '復活！', '#ffd84a');
        return;
      }
      player.hp = 0; player.alive = false; state.phase = 'dead';
      ev({ type: 'death' });
    }
  }

  /* ---------- targeting ---------- */
  function nearestEnemy(x, z, maxR, skipId) {
    let best = null, bd = maxR * maxR;
    // spiral rings in grid
    const n = queryCircle(x, z, Math.min(maxR, 12));
    for (let k = 0; k < n; k++) {
      const e = E[qBuf[k]];
      if (e._dead || e.id === skipId) continue;
      const dx = e.x - x, dz = e.z - z, d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = e; }
    }
    if (!best && maxR > 12) {
      for (let i = 0; i < E.length; i++) {
        const e = E[i]; if (e._dead || e.id === skipId) continue;
        const dx = e.x - x, dz = e.z - z, d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = e; }
      }
    }
    return best;
  }
  function randomVisibleEnemy() {
    if (!E.length) return null;
    for (let t = 0; t < 10; t++) {
      const e = E[Math.floor(rng() * E.length)];
      if (!e._dead && Math.abs(e.x - player.x) < view.halfW && Math.abs(e.z - player.z) < view.halfH) return e;
    }
    return nearestEnemy(player.x, player.z, 12, -1);
  }
  const chainPts = [];

  /* ---------- weapons ---------- */
  function fireWeapon(w, si) {
    const id = w.id;
    const ws = weaponStats(id, w.level, weaponTmp);
    const dmg = ws.dmg, area = ws.area * S.area, amount = Math.max(1, ws.amount + S.amount), dur = ws.dur * S.duration;
    const kind = ALL_WEAPONS[id].kind;
    const px = player.x, pz = player.z;
    switch (id) {
      case 'sword': case 'holyblade': {
        const holy = id === 'holyblade';
        const arc = holy ? TAU : 2.1;
        const n = holy ? 1 : Math.min(4, amount);
        let tgt = nearestEnemy(px, pz, area + 2.5, -1);
        let baseRot = tgt ? Math.atan2(tgt.x - px, tgt.z - pz) : player.rot;
        for (let i = 0; i < n; i++) {
          const rot = baseRot + (i === 1 ? Math.PI : i === 2 ? Math.PI / 2 : i === 3 ? -Math.PI / 2 : 0);
          ev({ type: 'slash', x: px, z: pz, rot, arc, range: area, kind: holy ? 'holy' : 'steel' });
          const c = queryCircle(px, pz, area + 2);
          for (let k = 0; k < c; k++) {
            const e = E[qBuf[k]]; if (e._dead) continue;
            const dx = e.x - px, dz = e.z - pz, d = Math.sqrt(dx * dx + dz * dz);
            if (d > area + e.r) continue;
            if (!holy) {
              let da = Math.atan2(dx, dz) - rot; da = Math.atan2(Math.sin(da), Math.cos(da));
              if (Math.abs(da) > arc / 2 + Math.atan2(e.r, Math.max(d, 0.1))) continue;
            }
            hitEnemy(e, dmg, holy ? 'holy' : 'phys', si);
            knock(e, px, pz, holy ? 2.2 : 1.4);
          }
        }
        ev({ type: 'cast', weapon: id, rot: baseRot });
        break;
      }
      case 'firebolt': {
        let last = -1;
        for (let i = 0; i < amount; i++) {
          const t = nearestEnemy(px, pz, 16, last) || nearestEnemy(px, pz, 16, -1);
          let a = t ? Math.atan2(t.x - px, t.z - pz) : player.rot;
          if (t) last = t.id;
          a += (i - (amount - 1) / 2) * 0.12;
          const p = newProj('firebolt', 'p', px + Math.sin(a) * 0.5, pz + Math.cos(a) * 0.5, Math.sin(a) * ws.speed, Math.cos(a) * ws.speed, 0.35, 1.6, dmg);
          if (p) { p._src = si; p._area = area; p._kind = 'fire'; p.y = 1.1; }
        }
        ev({ type: 'cast', weapon: id, rot: player.rot });
        break;
      }
      case 'meteor': {
        for (let i = 0; i < amount; i++) {
          const t = randomVisibleEnemy();
          const x = t ? t.x + rnd(-1, 1) : px + rnd(-6, 6), z = t ? t.z + rnd(-1, 1) : pz + rnd(-6, 6);
          const q = newZone('meteor_mark', 'p', x, z, area, ws.dur + i * 0.12);
          if (q) { q._fx = 'meteor_p'; q._dmg = dmg; q._src = si; }
        }
        ev({ type: 'cast', weapon: id, rot: player.rot });
        break;
      }
      case 'arrows': case 'arrowstorm': {
        const storm = id === 'arrowstorm';
        const t = nearestEnemy(px, pz, 16, -1);
        const base = t ? Math.atan2(t.x - px, t.z - pz) : player.rot;
        const spread = storm ? 0.16 : 0.13;
        for (let i = 0; i < amount; i++) {
          const a = base + (i - (amount - 1) / 2) * spread;
          const p = newProj('arrow', 'p', px, pz, Math.sin(a) * ws.speed, Math.cos(a) * ws.speed, 0.25, 1.1, dmg);
          if (p) { p._src = si; p._pierce = ws.pierce; p.y = 1.2; }
        }
        if (storm) {
          for (let i = 0; i < 2; i++) {
            const e = randomVisibleEnemy();
            if (!e) break;
            const q = newZone('arrowrain', 'p', e.x, e.z, area, ws.dur * S.duration);
            if (q) { q._dmg = dmg * 0.5; q._period = 0.25; q._src = si; q._kind = 'phys'; }
          }
        }
        ev({ type: 'cast', weapon: id, rot: base });
        break;
      }
      case 'axes': case 'bloodaxes': {
        const blood = id === 'bloodaxes';
        const at = nearestEnemy(px, pz, 10, -1);
        const aimA = at ? Math.atan2(at.x - px, at.z - pz) : player.rot;
        for (let i = 0; i < amount; i++) {
          const a = blood ? (i / amount) * TAU + state.time : aimA + (i % 2 ? 1 : -1) * (0.3 + Math.floor(i / 2) * 0.5) * (amount > 1 ? 1 : 0) - (i % 2 ? 1 : -1) * 0.25;
          const sp = ws.speed;
          const p = newProj(blood ? 'bloodaxe' : 'axe', 'p', px, pz, Math.sin(a) * sp, Math.cos(a) * sp, 0.55 * ws.area * (S.area * 0.5 + 0.5), dur, dmg);
          if (p) { p._src = si; p._pierce = 99; p._mode = 1; p._heal = blood ? 1 : 0; p.y = 1; p._a = sp; p._b = blood ? 1.6 : (i % 2 ? 1 : -1) * 1.2; }
        }
        ev({ type: 'cast', weapon: id, rot: player.rot });
        break;
      }
      case 'orbs': case 'soulring': {
        const ring = id === 'soulring';
        // remove existing orbs of this weapon
        for (let i = 0; i < P.length; i++) if (P[i]._src === si && (P[i].kind === 'orb' || P[i].kind === 'soulorb')) P[i]._dead = true;
        for (let i = 0; i < amount; i++) {
          const p = newProj(ring ? 'soulorb' : 'orb', 'p', px, pz, 0, 0, ring ? 0.55 : 0.42, ring ? 1e9 : dur, dmg);
          if (p) { p._src = si; p._mode = 2; p._a = (i / amount) * TAU; p._b = area; p._c = ws.speed; p.y = 1; }
        }
        ev({ type: 'cast', weapon: id, rot: player.rot });
        break;
      }
      case 'chain': {
        let from = null;
        for (let b = 0; b < amount; b++) {
          let e = b === 0 ? nearestEnemy(px, pz, 11, -1) : randomVisibleEnemy();
          if (!e) break;
          chainPts.length = 0;
          const pts = [{ x: px, z: pz }];
          let jumps = ws.pierce, prev = -1;
          while (e && jumps-- >= 0) {
            pts.push({ x: e.x, z: e.z });
            hitEnemy(e, dmg, 'light', si);
            prev = e.id;
            const fx = e.x, fz = e.z;
            e = nearestEnemyNotHit(fx, fz, ws.area, prev, pts);
          }
          ev({ type: 'chain', points: pts, kind: 'light' });
          from = pts;
        }
        if (from) ev({ type: 'cast', weapon: id, rot: player.rot });
        break;
      }
      case 'thunderstorm': {
        for (let i = 0; i < amount; i++) {
          const t = randomVisibleEnemy();
          if (!t) break;
          const q = newZone('lightning_mark', 'p', t.x, t.z, area, ws.dur + i * 0.1);
          if (q) { q._fx = 'thunder_p'; q._dmg = dmg; q._src = si; q._n = ws.pierce; }
        }
        break;
      }
      case 'nova': {
        ev({ type: 'nova', x: px, z: pz, r: area, kind: 'frost' });
        areaDamage(px, pz, area, dmg, 'frost', si, 1.2, dur, 2.5);
        ev({ type: 'cast', weapon: id, rot: player.rot });
        break;
      }
      case 'blizzard': {
        // persistent zone following the player
        let q = null;
        for (let i = 0; i < Z.length; i++) if (Z[i].kind === 'blizzard' && Z[i].owner === 'p') { q = Z[i]; break; }
        if (!q) { q = newZone('blizzard', 'p', px, pz, area, 1e9); if (q) { q._follow = true; q._kind = 'frost'; } }
        if (q) { q.r = area; q._dmg = dmg; q._period = ws.cd * S.cd; q._src = si; q._n = dur; }
        break;
      }
      case 'aura': case 'inferno_aura': {
        const fire = id === 'inferno_aura';
        const c = queryCircle(px, pz, area + 2);
        for (let k = 0; k < c; k++) {
          const e = E[qBuf[k]]; if (e._dead) continue;
          const dx = e.x - px, dz = e.z - pz, rr = area + e.r;
          if (dx * dx + dz * dz > rr * rr) continue;
          hitEnemy(e, dmg, fire ? 'fire' : 'holy', si, true);
          e.slowed = Math.max(e.slowed, 0.6); e._slowAmt = Math.max(e._slowAmt, fire ? 0.45 : 0.3);
          if (fire) { e.burning = Math.max(e.burning, 2); e._burnDps = Math.max(e._burnDps, dmg * 0.8 * dmgMulCache); }
        }
        break;
      }
      case 'daggers': {
        w._burst = amount; w._burstT = 0;
        break;
      }
      case 'thousand': {
        const n = Math.max(4, amount);
        w._spin = (w._spin || 0) + 0.23;
        for (let i = 0; i < n; i++) {
          const a = w._spin + (i / n) * TAU;
          const p = newProj('dagger', 'p', px, pz, Math.sin(a) * ws.speed, Math.cos(a) * ws.speed, 0.22, 0.8, dmg);
          if (p) { p._src = si; p._pierce = ws.pierce; p.y = 1; }
        }
        break;
      }
      case 'minions': case 'lichguard': {
        const lich = id === 'lichguard';
        const nSkel = lich ? 4 + S.amount : Math.min(9, amount);
        const nLich = lich ? Math.min(5, 2 + Math.floor(S.amount / 2) + 1) : 0;
        let cs = 0, cl = 0;
        for (let i = 0; i < A.length; i++) { if (A[i].type === 'skel') cs++; else if (A[i].type === 'lich') cl++; }
        while (cs < nSkel) { spawnAlly('skel', si); cs++; }
        while (cl < nLich) { spawnAlly('lich', si); cl++; }
        for (let i = 0; i < A.length; i++) { A[i]._dmg = lich ? (A[i].type === 'lich' ? dmg : dmg * 0.6) : dmg; A[i]._cdMax = ws.cd * S.cd; A[i]._src = si; A[i]._area = ws.area; A[i]._pierce = ws.pierce; }
        break;
      }
      case 'poison': {
        for (let i = 0; i < amount; i++) {
          const t = randomVisibleEnemy();
          const tx = t ? t.x + rnd(-1, 1) : px + rnd(-5, 5), tz = t ? t.z + rnd(-1, 1) : pz + rnd(-5, 5);
          const dx = tx - px, dz = tz - pz, d = Math.sqrt(dx * dx + dz * dz) || 1;
          const fl = 0.55 + Math.min(0.35, d / 30);
          const p = newProj('flask', 'p', px, pz, dx / fl, dz / fl, 0.25, fl, dmg);
          if (p) { p._src = si; p._mode = 3; p._area = area; p._t = dur; p._tx = tx; p._tz = tz; p.y = 1.2; }
        }
        ev({ type: 'cast', weapon: id, rot: player.rot });
        break;
      }
      case 'plague': {
        for (let i = 0; i < amount; i++) {
          const t = randomVisibleEnemy();
          const x = t ? t.x : px + rnd(-6, 6), z = t ? t.z : pz + rnd(-6, 6);
          const q = newZone('plague', 'p', x, z, area, dur);
          if (q) { q._dmg = dmg; q._period = 0.4; q._src = si; q._kind = 'poison'; q._n = 1; }
        }
        ev({ type: 'cast', weapon: id, rot: player.rot });
        break;
      }
      case 'spirits': {
        for (let i = 0; i < amount; i++) {
          const a = (i / amount) * TAU + rng();
          const p = newProj('spirit', 'p', px, pz, Math.sin(a) * ws.speed * 0.6, Math.cos(a) * ws.speed * 0.6, 0.35, dur, dmg);
          if (p) { p._src = si; p._mode = 4; p._a = ws.speed; p._pierce = ws.pierce; p.y = 1.2; p._kind = 'dark'; }
        }
        ev({ type: 'cast', weapon: id, rot: player.rot });
        break;
      }
      case 'reaper': {
        for (let i = 0; i < amount; i++) {
          const p = newProj('reaper', 'p', px, pz, 0, 0, 0.9 * ws.area * S.area, dur, dmg);
          if (p) { p._src = si; p._mode = 5; p._a = (i / amount) * TAU + rng(); p._b = 0.5; p._pierce = 99; p.y = 1; p._kind = 'dark'; }
        }
        ev({ type: 'cast', weapon: id, rot: player.rot });
        break;
      }
    }
  }
  function nearestEnemyNotHit(x, z, r, skip, pts) {
    const n = queryCircle(x, z, r);
    let best = null, bd = r * r;
    for (let k = 0; k < n; k++) {
      const e = E[qBuf[k]];
      if (e._dead || e.id === skip) continue;
      const dx = e.x - x, dz = e.z - z, d = dx * dx + dz * dz;
      if (d >= bd) continue;
      let used = false;
      for (let j = 1; j < pts.length; j++) if (pts[j].x === e.x && pts[j].z === e.z) { used = true; break; }
      if (used) continue;
      bd = d; best = e;
    }
    return best;
  }
  function spawnAlly(type, si) {
    const a = rng() * TAU;
    A.push({ id: nextId++, type, x: player.x + Math.sin(a) * 1.5, z: player.z + Math.cos(a) * 1.5, rot: a, anim: 'spawn', animT: 0,
      _cd: 0.5, _cdMax: 0.8, _dmg: 10, _src: si, _tgt: null, _area: 5, _pierce: 3, _ret: 0 });
  }
  function updateWeapons(dt) {
    for (let i = 0; i < state.weapons.length; i++) {
      const w = state.weapons[i];
      const ws = weaponStats(w.id, w.level, weaponTmp);
      let cd = ws.cd * S.cd;
      if (w.id === 'aura' || w.id === 'inferno_aura') cd = ws.cd; // tick rate not affected that much
      if (w.id === 'orbs') cd = ws.cd * S.cd + ws.dur * S.duration; // active + gap
      if (w.id === 'soulring') cd = 9999;
      if (w.id === 'minions' || w.id === 'lichguard') cd = 1;
      if (w.id === 'thousand') cd = ws.cd;
      if (w.id === 'blizzard') cd = 0.5;
      w._t += dt;
      if (w.id === 'soulring' && !w._fired) { w._fired = true; fireWeapon(w, i); }
      if (w._t >= cd) {
        w._t = 0;
        if (w.id !== 'soulring') fireWeapon(w, i);
      }
      w.cd = cd > 0 ? Math.min(1, w._t / cd) : 1;
      // dagger bursts
      if (w._burst > 0) {
        w._burstT -= dt;
        if (w._burstT <= 0) {
          w._burstT = 0.07; w._burst--;
          weaponStats(w.id, w.level, weaponTmp);
          let a = player.rot;
          if (player.moveX === 0 && player.moveZ === 0) { const t = nearestEnemy(player.x, player.z, 12, -1); if (t) a = Math.atan2(t.x - player.x, t.z - player.z); }
          a += (rng() - 0.5) * 0.12;
          const p = newProj('dagger', 'p', player.x, player.z, Math.sin(a) * weaponTmp.speed, Math.cos(a) * weaponTmp.speed, 0.22, 0.9, weaponTmp.dmg);
          if (p) { p._src = i; p._pierce = weaponTmp.pierce; p.y = 1; }
        }
      }
    }
  }

  /* ---------- projectiles ---------- */
  function projHit(p, e) {
    for (let j = 0; j < p._nh; j++) if (p._hits[j] === e.id) return false;
    if (p._nh < 24) p._hits[p._nh++] = e.id;
    return true;
  }
  function updateProjectiles(dt) {
    const px = player.x, pz = player.z;
    for (let i = 0; i < P.length; i++) {
      const p = P[i];
      if (p._dead) continue;
      p.age += dt;
      if (p.age >= p.life) {
        if (p.kind === 'firebolt') explodeFire(p);
        if (p._mode === 3) landFlask(p);
        if (p.kind === 'e_web') { const q = newZone('web', 'e', p.x, p.z, 1.6, 6); if (q) q._dmg = 0; }
        p._dead = true; continue;
      }
      if (p.owner === 'e') {
        p.x += p.vx * dt; p.z += p.vz * dt;
        const dx = p.x - px, dz = p.z - pz, rr = p.r + 0.45;
        if (dx * dx + dz * dz < rr * rr && player.alive) {
          if (player.invuln <= 0 && player.dashing <= 0) {
            hurtPlayer(p._dmg, null, p.kind === 'e_fireball' ? 'fire' : p.kind === 'e_frost' ? 'frost' : p.kind === 'e_web' ? 'poison' : 'dark');
            if (p.kind === 'e_frost') { player._slow = 1.2; player._slowAmt = 0.3; }
            if (p.kind === 'e_web') { player._slow = 2; player._slowAmt = 0.55; const q = newZone('web', 'e', p.x, p.z, 1.6, 5); if (q) q._dmg = 0; }
            p._dead = true;
          }
        }
        continue;
      }
      switch (p._mode) {
        case 1: { // boomerang axe
          const back = p.age > p.life * 0.45;
          if (!back) {
            // curve
            const c = Math.cos(p._b * dt), s = Math.sin(p._b * dt);
            const vx = p.vx * c + p.vz * s, vz = -p.vx * s + p.vz * c;
            p.vx = vx * (1 - 1.2 * dt); p.vz = vz * (1 - 1.2 * dt);
          } else {
            if (!p._c) { p._c = 1; p._nh = 0; }
            const dx = px - p.x, dz = pz - p.z, d = Math.sqrt(dx * dx + dz * dz) || 1;
            const sp = p._a * 1.3;
            p.vx += (dx / d * sp - p.vx) * Math.min(1, 6 * dt); p.vz += (dz / d * sp - p.vz) * Math.min(1, 6 * dt);
            if (d < 0.7) { p._dead = true; continue; }
          }
          p.x += p.vx * dt; p.z += p.vz * dt;
          p.rot += 14 * dt;
          break;
        }
        case 2: { // orbit
          p._a += p._c * dt;
          p.x = px + Math.sin(p._a) * p._b; p.z = pz + Math.cos(p._a) * p._b;
          p.rot = p._a + Math.PI / 2;
          break;
        }
        case 3: { // lobbed flask
          p.x += p.vx * dt; p.z += p.vz * dt;
          const f = p.age / p.life;
          p.y = 1.2 + 3.2 * f * (1 - f) * 4 * 0.5;
          p.rot += 10 * dt;
          continue; // no collision mid-air
        }
        case 4: { // homing spirit
          if (!p._tgt || p._tgt._dead || p._tgt.hp <= 0) { p._tgt = nearestEnemy(p.x, p.z, 14, -1); }
          if (p._tgt) {
            const dx = p._tgt.x - p.x, dz = p._tgt.z - p.z, d = Math.sqrt(dx * dx + dz * dz) || 1;
            p.vx += (dx / d * p._a - p.vx) * Math.min(1, 4 * dt); p.vz += (dz / d * p._a - p.vz) * Math.min(1, 4 * dt);
          }
          p.x += p.vx * dt; p.z += p.vz * dt; p.rot = Math.atan2(p.vx, p.vz);
          break;
        }
        case 5: { // reaper spiral
          p._a += 2.2 * dt; p._b += 2.6 * dt;
          p.x = px + Math.sin(p._a) * p._b; p.z = pz + Math.cos(p._a) * p._b;
          p.rot += 9 * dt;
          break;
        }
        default:
          p.x += p.vx * dt; p.z += p.vz * dt;
      }
      // collision with enemies
      const n = queryCircle(p.x, p.z, p.r + 2);
      for (let k = 0; k < n; k++) {
        const e = E[qBuf[k]];
        if (e._dead) continue;
        const dx = e.x - p.x, dz = e.z - p.z, rr = p.r + e.r;
        if (dx * dx + dz * dz > rr * rr) continue;
        if (p._mode === 2 || p._mode === 5) {
          const slot = p._mode === 2 ? 0 : 1;
          const per = p._mode === 2 ? 0.45 : 0.3;
          if (state.time - e._ht[slot] < per) continue;
          e._ht[slot] = state.time;
          hitEnemy(e, p._dmg, p._mode === 2 ? 'holy' : 'dark', p._src);
          knock(e, px, pz, 1);
          continue;
        }
        if (p.kind === 'firebolt') { explodeFire(p); p._dead = true; break; }
        if (!projHit(p, e)) continue;
        hitEnemy(e, p._dmg, p._mode === 4 ? 'dark' : 'phys', p._src);
        if (p._heal) healPlayer(0.6, true);
        if (p.kind !== 'axe' && p.kind !== 'bloodaxe') knock(e, p.x - p.vx, p.z - p.vz, 0.5);
        if (p._pierce-- <= 0) { p._dead = true; break; }
      }
    }
  }
  function explodeFire(p) {
    ev({ type: 'explode', x: p.x, z: p.z, r: p._area, kind: 'fire' });
    const n = queryCircle(p.x, p.z, p._area + 2);
    for (let k = 0; k < n; k++) {
      const e = E[qBuf[k]]; if (e._dead) continue;
      const dx = e.x - p.x, dz = e.z - p.z, rr = p._area + e.r;
      if (dx * dx + dz * dz > rr * rr) continue;
      hitEnemy(e, p._dmg, 'fire', p._src);
      e.burning = Math.max(e.burning, 1.5); e._burnDps = Math.max(e._burnDps, p._dmg * 0.2 * dmgMulCache);
    }
  }
  function landFlask(p) {
    const q = newZone('poison', 'p', p._tx, p._tz, p._area, p._t);
    if (q) { q._dmg = p._dmg; q._period = 0.4; q._src = p._src; q._kind = 'poison'; }
    ev({ type: 'explode', x: p._tx, z: p._tz, r: p._area, kind: 'poison' });
  }

  /* ---------- zones ---------- */
  function playerInLine(q, extra) {
    const dx = player.x - q.x, dz = player.z - q.z;
    const ca = Math.sin(q.angle), sa = Math.cos(q.angle);
    const along = dx * ca + dz * sa;
    const perp = Math.abs(dx * sa - dz * ca);
    return along >= -0.5 && along <= q.len + 0.5 && perp <= q.width / 2 + extra;
  }
  function resolveZone(q) {
    const pr = 0.45;
    switch (q._fx) {
      case 'meteor_p':
        ev({ type: 'strike', x: q.x, z: q.z, r: q.r, kind: 'meteor' });
        areaDamage(q.x, q.z, q.r, q._dmg, 'fire', q._src, 2.5);
        break;
      case 'thunder_p': {
        ev({ type: 'strike', x: q.x, z: q.z, r: q.r, kind: 'light' });
        areaDamage(q.x, q.z, q.r, q._dmg, 'light', q._src, 1);
        break;
      }
      case 'slam': case 'nova': case 'meteor_e': case 'pool': case 'leap': case 'stomp': {
        if (q._fx === 'leap') {
          const b = findById(q._srcId);
          if (b) { b.x = q.x; b.z = q.z; b.anim = 'attack'; b.animT = 0; }
        }
        const dx = player.x - q.x, dz = player.z - q.z, rr = q.r + pr;
        if (dx * dx + dz * dz < rr * rr) {
          hurtPlayer(q._dmg, null, q._kind || 'phys');
          if (q._fx === 'nova') { player._slow = 2; player._slowAmt = 0.5; }
        }
        if (q._fx === 'nova') ev({ type: 'nova', x: q.x, z: q.z, r: q.r, kind: q._kind || 'frost' });
        else if (q._fx === 'meteor_e') { ev({ type: 'strike', x: q.x, z: q.z, r: q.r, kind: 'meteor' }); const f = newZone('e_fire', 'e', q.x, q.z, q.r * 0.8, 3); if (f) f._dmg = q._dmg * 0.25; }
        else if (q._fx === 'pool') { ev({ type: 'explode', x: q.x, z: q.z, r: q.r, kind: 'poison' }); const f = newZone('e_poison', 'e', q.x, q.z, q.r, 5); if (f) f._dmg = q._dmg * 0.3; }
        else ev({ type: 'explode', x: q.x, z: q.z, r: q.r, kind: q._kind || 'phys' });
        break;
      }
      case 'bones': case 'firewave': case 'lances': case 'web': {
        const kind = q._fx === 'bones' ? 'e_bone' : q._fx === 'firewave' ? 'e_fireball' : q._fx === 'lances' ? 'e_frost' : 'e_web';
        const sx = Math.sin(q.angle), sz = Math.cos(q.angle);
        const sp = q._fx === 'web' ? 9 : q._fx === 'firewave' ? 11 : 16;
        const rows = q._fx === 'firewave' ? 3 : 1;
        for (let r = 0; r < rows; r++) {
          const off = (r - (rows - 1) / 2) * 0.9;
          const ox = q.x + sz * off, oz = q.z - sx * off;
          const p = newProj(kind, 'e', ox, oz, sx * sp, sz * sp, q._fx === 'firewave' ? 0.45 : 0.35, q.len / sp + 0.2, q._dmg);
          if (p) p.y = 1;
        }
        break;
      }
      case 'blizzard_e': {
        const f = newZone('blizzard', 'e', player.x, player.z, 3.6, 6);
        if (f) { f._dmg = q._dmg; f._follow = true; f._period = 0.5; }
        break;
      }
    }
  }
  function findById(id) { for (let i = 0; i < E.length; i++) if (E[i].id === id) return E[i]; return null; }
  function updateZones(dt) {
    for (let i = 0; i < Z.length; i++) {
      const q = Z[i];
      if (q._dead) continue;
      q.age += dt;
      if (q._follow && q.owner === 'p') { q.x = player.x; q.z = player.z; }
      else if (q._follow && q.owner === 'e') { q.x += (player.x - q.x) * Math.min(1, 0.7 * dt); q.z += (player.z - q.z) * Math.min(1, 0.7 * dt); }
      if (q.age >= q.life) {
        if (q._fx) resolveZone(q);
        q._dead = true; continue;
      }
      if (q._fx) continue; // telegraph / mark: no ticking
      q._tick -= dt;
      if (q._tick > 0) continue;
      q._tick = q._period;
      if (q.owner === 'p') {
        if (q.kind === 'plague' && q._n) {
          // drift toward the nearest enemy
          const t = nearestEnemy(q.x, q.z, 8, -1);
          if (t) { const dx = t.x - q.x, dz = t.z - q.z, d = Math.sqrt(dx * dx + dz * dz) || 1; q.x += dx / d * 1.2 * q._period; q.z += dz / d * 1.2 * q._period; }
        }
        const n = queryCircle(q.x, q.z, q.r + 2);
        for (let k = 0; k < n; k++) {
          const e = E[qBuf[k]]; if (e._dead) continue;
          const dx = e.x - q.x, dz = e.z - q.z, rr = q.r + e.r;
          if (dx * dx + dz * dz > rr * rr) continue;
          if (q.kind === 'poison' || q.kind === 'plague') {
            e.poisoned = Math.max(e.poisoned, 2); e._poisDps = Math.max(e._poisDps, q._dmg * 1.2 * dmgMulCache);
            if (q.kind === 'plague') { e._plague = true; e._b = q._dmg; }
            hitEnemy(e, q._dmg * 0.5, 'poison', q._src, true);
          } else if (q.kind === 'blizzard') {
            hitEnemy(e, q._dmg, 'frost', q._src);
            e.slowed = Math.max(e.slowed, 1); e._slowAmt = Math.max(e._slowAmt, 0.55);
            if (!e.boss && rng() < 0.06) e.frozen = Math.max(e.frozen, q._n || 1);
          } else {
            hitEnemy(e, q._dmg, q._kind || 'phys', q._src);
          }
        }
      } else {
        const dx = player.x - q.x, dz = player.z - q.z, rr = q.r + 0.3;
        if (dx * dx + dz * dz < rr * rr) {
          if (q.kind === 'web' || q.kind === 'frost') { player._slow = 0.6; player._slowAmt = q.kind === 'web' ? 0.55 : 0.4; }
          if (q.kind === 'blizzard') { player._slow = 0.6; player._slowAmt = 0.35; }
          if (q._dmg > 0) hurtPlayer(q._dmg, null, q.kind === 'e_poison' ? 'poison' : q.kind === 'blizzard' || q.kind === 'frost' ? 'frost' : 'fire');
        }
      }
    }
  }
  function telCircle(x, z, r, life, fx, dmg, kind, srcId) {
    const q = newZone('telegraph_circle', 'e', x, z, r, life);
    if (q) { q._fx = fx; q._dmg = dmg; q._kind = kind; q._srcId = srcId || 0; }
    return q;
  }
  function telLine(x, z, angle, len, width, life, fx, dmg, srcId) {
    const q = newZone('telegraph_line', 'e', x, z, 0, life);
    if (q) { q.angle = angle; q.len = len; q.width = width; q.r = len; q._fx = fx; q._dmg = dmg; q._srcId = srcId || 0; }
    return q;
  }

  /* ---------- allies ---------- */
  function updateAllies(dt) {
    for (let i = 0; i < A.length; i++) {
      const a = A[i];
      a.animT += dt;
      if (a.anim === 'spawn' && a.animT > 0.4) { a.anim = 'walk'; a.animT = 0; }
      a._cd -= dt;
      const lich = a.type === 'lich';
      if (!a._tgt || a._tgt._dead || a._ret > 0) a._tgt = a._ret > 0 ? null : nearestEnemy(a.x, a.z, lich ? 9 : 7, -1);
      a._ret -= dt;
      let tx, tz, sp = lich ? 5 : 6.2;
      const dpx = player.x - a.x, dpz = player.z - a.z, dp = Math.sqrt(dpx * dpx + dpz * dpz);
      if (dp > 9) { a._ret = 0.8; a._tgt = null; }
      if (dp > 22) { a.x = player.x + (rng() - 0.5) * 2; a.z = player.z + (rng() - 0.5) * 2; }
      if (a._tgt) {
        tx = a._tgt.x; tz = a._tgt.z;
        const dx = tx - a.x, dz = tz - a.z, d = Math.sqrt(dx * dx + dz * dz) || 1;
        const reach = lich ? 6 : a._tgt.r + 0.7;
        if (d <= reach) {
          if (a._cd <= 0) {
            a._cd = a._cdMax * (lich ? 2 : 1); a.anim = lich ? 'cast' : 'attack'; a.animT = 0;
            if (lich) {
              const pts = [{ x: a.x, z: a.z }];
              let e = a._tgt, j = a._pierce;
              while (e && j-- >= 0) { pts.push({ x: e.x, z: e.z }); hitEnemy(e, a._dmg, 'dark', a._src); e = nearestEnemyNotHit(e.x, e.z, 4, e.id, pts); }
              ev({ type: 'chain', points: pts, kind: 'dark' });
            } else {
              hitEnemy(a._tgt, a._dmg, 'phys', a._src); knock(a._tgt, a.x, a.z, 1);
              ev({ type: 'slash', x: a.x, z: a.z, rot: Math.atan2(dx, dz), arc: 1.4, range: 1.2, kind: 'bone' });
            }
          }
          a.rot = Math.atan2(dx, dz);
          sp = 0;
        } else {
          a.rot = Math.atan2(dx, dz);
          a.x += dx / d * sp * dt; a.z += dz / d * sp * dt;
          if (a.anim !== 'walk' && a.animT > 0.35) { a.anim = 'walk'; a.animT = 0; }
        }
      } else {
        // follow the player in formation
        const ang = (i / Math.max(1, A.length)) * TAU + state.time * 0.3;
        tx = player.x + Math.sin(ang) * 2; tz = player.z + Math.cos(ang) * 2;
        const dx = tx - a.x, dz = tz - a.z, d = Math.sqrt(dx * dx + dz * dz);
        if (d > 0.3) { const s = Math.min(d, (sp + 1) * dt); a.x += dx / d * s; a.z += dz / d * s; a.rot = Math.atan2(dx, dz); }
        if (a.anim !== 'walk' && a.animT > 0.35) { a.anim = 'walk'; a.animT = 0; }
      }
    }
  }

  /* ---------- enemies ---------- */
  function enemyShoot(e, kind, ang, speed, dmg) {
    const p = newProj(kind, 'e', e.x + Math.sin(ang) * e.r, e.z + Math.cos(ang) * e.r, Math.sin(ang) * speed, Math.cos(ang) * speed, kind === 'e_fireball' ? 0.38 : 0.3, 4, dmg);
    if (p) p.y = 1 + (e.flying ? 0.5 : 0);
    return p;
  }
  function setAnim(e, a) { if (e.anim !== a) { e.anim = a; e.animT = 0; } }
  function updateEnemies(dt) {
    const px = player.x, pz = player.z;
    const n = E.length;
    const reachX = view.halfW * 2 + 10, reachZ = view.halfH * 2 + 10;
    for (let i = 0; i < n; i++) {
      const e = E[i];
      if (e._dead) continue;
      e.age += dt; e.animT += dt;
      if (e.flash > 0) e.flash = Math.max(0, e.flash - dt * 5);
      if (e._atk > 0) e._atk -= dt;
      // DoTs
      if (e.burning > 0) { e.burning -= dt; e._tick += dt; e.hp -= e._burnDps * dt; if (e.burning <= 0) e._burnDps = 0; }
      if (e.poisoned > 0) { e.poisoned -= dt; e.hp -= e._poisDps * dt; if (e.poisoned <= 0) e._poisDps = 0; }
      if ((e.burning > 0 || e.poisoned > 0) && e._tick > 0.5) {
        e._tick = 0;
        if (hitEvents < 70) { hitEvents++; ev({ type: 'hit', x: e.x, z: e.z, dmg: Math.round((e._burnDps + e._poisDps) * 0.5), crit: false, kind: e.burning > 0 ? 'fire' : 'poison', target: 'e' }); }
      }
      if (e.hp <= 0) { killEnemy(e, 'fire'); continue; }
      if (e.slowed > 0) { e.slowed -= dt; if (e.slowed <= 0) e._slowAmt = 0; }
      if (e._shieldMax > 0) { e._shT += dt; if (e._shT > 4) e._shield = Math.min(e._shieldMax, e._shield + e._shieldMax * 0.15 * dt); }
      if (e.elite && e.affix === 'vampiric') e.hp = Math.min(e.maxHp, e.hp + e.maxHp * 0.01 * dt);
      if (e.elite && e.affix === 'burning') {
        e._fireT -= dt;
        if (e._fireT <= 0) { e._fireT = 0.7; const q = newZone('fire', 'e', e.x, e.z, 0.9, 3); if (q) { q._dmg = e._dmg * 0.4; } }
      }
      const dx0 = px - e.x, dz0 = pz - e.z;
      const dist = Math.sqrt(dx0 * dx0 + dz0 * dz0) || 0.001;
      const ux = dx0 / dist, uz = dz0 / dist;
      // relocate far enemies
      if (!e.boss && (Math.abs(dx0) > reachX || Math.abs(dz0) > reachZ)) { relocate(e); continue; }
      if (e.boss && dist > 30) { const a = rng() * TAU; e.x = px + Math.sin(a) * 14; e.z = pz + Math.cos(a) * 14; }
      if (e.anim === 'spawn') { if (e.animT > 0.45) setAnim(e, 'walk'); else { e._kx = e._kz = 0; continue; } }
      if (e.frozen > 0) { e.frozen -= dt; e._kx *= 0.8; e._kz *= 0.8; continue; }
      let spd = e._spd * (e.slowed > 0 ? 1 - e._slowAmt : 1);
      let vx = ux * spd, vz = uz * spd;
      let busy = false;
      switch (e._beh) {
        case BEH.bat: {
          e._a += dt * 4;
          const s = Math.sin(e._a) * 0.7;
          vx = (ux - uz * s) * spd; vz = (uz + ux * s) * spd;
          break;
        }
        case BEH.zigzag: {
          e._a += dt * 3;
          const s = Math.sin(e._a) * 0.9;
          vx = (ux - uz * s) * spd; vz = (uz + ux * s) * spd;
          break;
        }
        case BEH.lunge: {
          if (e._st === 0) {
            e._t -= dt;
            if (dist < 4.5 && e._t <= 0) { e._st = 1; e._b = 0.75; setAnim(e, 'windup'); e._ang = Math.atan2(ux, uz); }
          } else if (e._st === 1) {
            vx = vz = 0; busy = true; e._b -= dt;
            if (e._b <= 0) { e._st = 2; e._b = 0.4; setAnim(e, 'charge'); }
          } else {
            busy = true; e._b -= dt;
            vx = Math.sin(e._ang) * spd * 3.4; vz = Math.cos(e._ang) * spd * 3.4;
            if (e._b <= 0) { e._st = 0; e._t = 2.2; setAnim(e, 'walk'); }
          }
          break;
        }
        case BEH.ranged: case BEH.caster: {
          const range = e._D.range;
          if (e._beh === BEH.caster && dist < range * 0.6) { vx = -ux * spd * 0.5; vz = -uz * spd * 0.5; }
          else if (dist < range * 0.8) { vx = -uz * spd * 0.35 * e._side; vz = ux * spd * 0.35 * e._side; }
          e._t -= dt;
          if (e._st === 1) {
            vx = vz = 0; busy = true; e._b -= dt;
            if (e._b <= 0) {
              e._st = 0;
              if (e._a === 1) {
                for (let s = 0; s < 3; s++) { const a = rng() * TAU; const m = spawnEnemy('skeleton', e.x + Math.sin(a) * 1.5, e.z + Math.cos(a) * 1.5); }
              } else {
                const ang = Math.atan2(ux, uz);
                enemyShoot(e, e._D.shot, ang, e._D.shot === 'e_bolt' ? 7.5 : 7, e._dmg);
              }
              setAnim(e, 'walk');
            }
          } else if (e._t <= 0 && dist < range + 2 && Math.abs(dx0) < view.halfW + 1 && Math.abs(dz0) < view.halfH + 1) {
            e._st = 1; e._b = 0.6; e._t = 2.6 + rng() * 1.6;
            e._a = (e._beh === BEH.caster && rng() < 0.25) ? 1 : 0;
            setAnim(e, e._a === 1 ? 'summon' : 'cast');
          }
          break;
        }
        case BEH.blink: {
          e._t -= dt;
          if (e._st === 1) {
            busy = true; vx = vz = 0; e._b -= dt;
            if (e._b <= 0) {
              const a = Math.atan2(-ux, -uz) + (rng() - 0.5) * 1.6;
              const d = Math.max(2.2, dist * 0.45);
              e.x = px + Math.sin(a) * d; e.z = pz + Math.cos(a) * d;
              e._st = 0; setAnim(e, 'walk');
            }
          } else if (e._t <= 0 && dist > 5 && dist < 16) { e._st = 1; e._b = 0.7; e._t = 4 + rng() * 2; setAnim(e, 'cast'); }
          break;
        }
        case BEH.stomp: {
          if (e._st === 0) {
            e._t -= dt;
            if (dist < 3.2 && e._t <= 0) {
              e._st = 1; e._b = 1.0; setAnim(e, 'windup');
              telCircle(e.x, e.z, 3.2 * (e.elite ? 1.3 : 1), 1.0, 'stomp', e._dmg * 1.2, 'phys', e.id);
            }
          } else { busy = true; vx = vz = 0; e._b -= dt; if (e._b <= 0) { e._st = 0; e._t = 3.5; setAnim(e, 'attack'); } }
          break;
        }
        case BEH.bomber: {
          if (e._st === 0) {
            if (dist < 1.9) { e._st = 1; e._b = 0.85; setAnim(e, 'windup'); telCircle(e.x, e.z, 2.3, 0.85, '', 0, 'fire', e.id); }
          } else {
            busy = true; vx = vz = 0; e._b -= dt;
            if (e._b <= 0) {
              ev({ type: 'explode', x: e.x, z: e.z, r: 2.3, kind: 'fire' });
              const ddx = player.x - e.x, ddz = player.z - e.z;
              if (ddx * ddx + ddz * ddz < 2.75 * 2.75) hurtPlayer(e._dmg, null, 'fire');
              e._xp = 1;
              killEnemy(e, 'fire');
              // hurts nearby monsters too
              areaDamage(e.x, e.z, 2.3, 30, 'fire', -1, 2);
              continue;
            }
          }
          break;
        }
        case BEH.charger: {
          if (e._st === 0) {
            e._t -= dt;
            if (dist < 9 && dist > 2.5 && e._t <= 0) {
              e._st = 1; e._b = 0.9; setAnim(e, 'windup'); e._ang = Math.atan2(ux, uz);
              telLine(e.x, e.z, e._ang, 11, 1.4, 0.9, '', 0, e.id);
            }
          } else if (e._st === 1) {
            busy = true; vx = vz = 0; e._b -= dt; e.rot = e._ang;
            if (e._b <= 0) { e._st = 2; e._b = 11 / 14; setAnim(e, 'charge'); }
          } else {
            busy = true; e._b -= dt;
            vx = Math.sin(e._ang) * 14; vz = Math.cos(e._ang) * 14;
            if (e._b <= 0) { e._st = 0; e._t = 3.5; setAnim(e, 'walk'); }
          }
          break;
        }
        case BEH.healer: {
          if (dist < 5) { vx = -ux * spd * 0.5; vz = -uz * spd * 0.5; }
          e._t -= dt;
          if (e._st === 1) {
            busy = true; vx = vz = 0; e._b -= dt;
            if (e._b <= 0) {
              e._st = 0; setAnim(e, 'walk');
              ev({ type: 'nova', x: e.x, z: e.z, r: 5, kind: 'dark' });
              const c = queryCircle(e.x, e.z, 7);
              for (let k = 0; k < c; k++) {
                const o = E[qBuf[k]]; if (o._dead || o.boss) continue;
                const ddx = o.x - e.x, ddz = o.z - e.z; if (ddx * ddx + ddz * ddz > 25) continue;
                o.hp = Math.min(o.maxHp, o.hp + o.maxHp * 0.3);
                o._spd *= 1.04; if (o._spd > o._D.speed * 1.8) o._spd = o._D.speed * 1.8;
              }
            }
          } else if (e._t <= 0 && dist < 14) { e._st = 1; e._b = 0.9; e._t = 4.5; setAnim(e, 'cast'); }
          break;
        }
        case BEH.boss: {
          busy = bossThink(e, dt, ux, uz, dist);
          if (e._st === 9) { vx = Math.sin(e._ang) * 15; vz = Math.cos(e._ang) * 15; }
          else if (busy) { vx = vz = 0; }
          else if (e.type === 'boss_frostlich' || e._clone) {
            if (dist < 6) { vx = -ux * spd; vz = -uz * spd; } else if (dist < 8) { vx = -uz * spd * 0.6; vz = ux * spd * 0.6; }
          }
          break;
        }
      }
      // separation (not for bosses; cheap, capped)
      if (!e.boss && i < gridN) {
        const c = entCell[i];
        const cx = c % G, cz = (c / G) | 0;
        let sx = 0, sz = 0, cnt = 0, checks = 0;
        for (let oz = -1; oz <= 1 && cnt < 10; oz++) {
          const zz = cz + oz; if (zz < 0 || zz >= G) continue;
          for (let ox = -1; ox <= 1 && cnt < 10; ox++) {
            const xx = cx + ox; if (xx < 0 || xx >= G) continue;
            const cc = zz * G + xx;
            for (let k = cellStart[cc], end = cellStart[cc + 1]; k < end && checks < 28; k++) {
              checks++;
              const j = cellItems[k];
              if (j === i) continue;
              const o = E[j];
              if (o.flying !== e.flying) continue;
              const ddx = e.x - o.x, ddz = e.z - o.z, rr = e.r + o.r;
              const d2 = ddx * ddx + ddz * ddz;
              if (d2 < rr * rr && d2 > 1e-6) {
                const d = Math.sqrt(d2), push = (rr - d) / d;
                sx += ddx * push; sz += ddz * push;
                if (++cnt >= 10) break;
              } else if (d2 <= 1e-6) { sx += (rng() - 0.5) * 0.1; sz += (rng() - 0.5) * 0.1; }
            }
          }
        }
        e.x += sx * Math.min(1, 8 * dt) * 0.5; e.z += sz * Math.min(1, 8 * dt) * 0.5;
      }
      // move
      e.x += (vx + e._kx) * dt; e.z += (vz + e._kz) * dt;
      const kd = Math.max(0, 1 - 9 * dt); e._kx *= kd; e._kz *= kd;
      if (vx !== 0 || vz !== 0) { if (!busy || e._st === 2 || e._st === 9) e.rot = Math.atan2(vx, vz); }
      else if (!busy) e.rot = Math.atan2(ux, uz);
      // obstacles
      if (!e.flying && !e.boss) {
        const s = collideObstacles(stageId, e, e.r, ux, uz);
        if (s) { e.x += -OB._nz * s * spd * dt * 0.8; e.z += OB._nx * s * spd * dt * 0.8; }
      }
      // contact
      if (dist < e.r + 0.45 + 0.05 && e._atk <= 0 && player.alive) {
        e._atk = e.boss ? 0.8 : 0.85;
        if (!busy) setAnim(e, 'attack');
        hurtPlayer(e._dmg, e, 'phys');
      } else if (e.anim === 'attack' && e.animT > 0.4) setAnim(e, 'walk');
    }
  }
  function relocate(e) {
    const p = spawnPoint();
    e.x = p.x; e.z = p.z;
  }
  const SP = { x: 0, z: 0 };
  function spawnPoint() {
    const hw = view.halfW + 1.5, hh = view.halfH + 1.5;
    for (let t = 0; t < 6; t++) {
      let x, z;
      const mvx = player.moveX, mvz = player.moveZ;
      if ((mvx || mvz) && rng() < 0.45) {
        // ahead of movement
        const a = Math.atan2(mvx, mvz) + (rng() - 0.5) * 1.4;
        const sx = Math.sin(a), sz = Math.cos(a);
        const k = Math.min(hw / (Math.abs(sx) + 1e-6), hh / (Math.abs(sz) + 1e-6));
        x = sx * k; z = sz * k;
      } else {
        const per = 2 * (hw + hh), r = rng() * per;
        if (r < hw * 2) { x = -hw + r; z = rng() < 0.5 ? -hh : hh; }
        else { x = rng() < 0.5 ? -hw : hw; z = -hh + (r - hw * 2); }
      }
      SP.x = player.x + x; SP.z = player.z + z;
      if (!insideObstacle(stageId, SP.x, SP.z, 0.6)) break;
    }
    return SP;
  }

  /* ---------- bosses ---------- */
  function bossThink(e, dt, ux, uz, dist) {
    const B = e.type;
    const hpf = e.hp / e.maxHp;
    if (!e._clone) {
      const ph = hpf > 0.66 ? 1 : hpf > 0.33 ? 2 : 3;
      if (ph > e._phase) {
        e._phase = ph;
        ev({ type: 'bossPhase', n: ph });
        text(e.x, e.z, ph === 2 ? '首領狂怒！' : '首領垂死掙扎！', '#ff5a4a');
        e._spd *= 1.12; e._acd = Math.min(e._acd, 0.6);
      }
    }
    if (e._st === 9) { // charging
      e._busy -= dt;
      if (B === 'boss_pyrelord') { e._fireT -= dt; if (e._fireT <= 0) { e._fireT = 0.12; const q = newZone('e_fire', 'e', e.x, e.z, 1.1, 3); if (q) q._dmg = e._dmg * 0.25; } }
      if (e._busy <= 0) { e._st = 0; setAnim(e, 'walk'); e._acd = 1.2; }
      return true;
    }
    if (e._busy > 0) {
      e._busy -= dt;
      if (e._busy <= 0) {
        if (e._seq === 99) { // start charge after telegraph
          e._st = 9; e._busy = 14 / 15; setAnim(e, 'charge'); e._seq = 0; return true;
        }
        setAnim(e, 'walk');
      }
      return e._busy > 0;
    }
    e._acd -= dt;
    if (e._acd > 0) return false;
    const ph = e._phase, d = e._dmg, ang = Math.atan2(ux, uz);
    const fast = ph === 3 ? 0.75 : ph === 2 ? 0.88 : 1;
    const tele = Math.max(0.75, 1.0 * fast);
    if (e._clone) {
      setAnim(e, 'cast'); e._busy = 0.8; e._acd = 2.2;
      telLine(e.x, e.z, ang, 12, 0.8, 0.8, 'lances', d * 0.6, e.id);
      return true;
    }
    const pick = e._seq++ % 4;
    switch (B) {
      case 'boss_bonelord': {
        if (pick === 0 || (pick === 2 && dist < 5)) {
          setAnim(e, 'windup'); telCircle(e.x, e.z, 4.8, tele, 'slam', d * 1.3, 'phys', e.id); e._busy = tele + 0.2;
        } else if (pick === 1) {
          setAnim(e, 'cast');
          const nl = ph === 1 ? 3 : 5;
          for (let k = 0; k < nl; k++) telLine(e.x, e.z, ang + (k - (nl - 1) / 2) * 0.32, 16, 1.2, tele, 'bones', d, e.id);
          if (ph >= 2) for (let k = 0; k < 12; k++) telLine(e.x, e.z, (k / 12) * TAU + 0.13, 10, 0.9, tele + 0.5, 'bones', d * 0.8, e.id);
          e._busy = tele + 0.3;
        } else if (pick === 2) {
          setAnim(e, 'summon');
          const ns = ph === 1 ? 6 : 10;
          for (let k = 0; k < ns; k++) { const a = (k / ns) * TAU; spawnEnemy(ph === 3 && k % 2 ? 'deathknight' : 'skeleton', e.x + Math.sin(a) * 3, e.z + Math.cos(a) * 3, { hpMul: ph === 3 && k % 2 ? 0.5 : 1 }); }
          e._busy = 1;
        } else {
          if (ph >= 2) { setAnim(e, 'windup'); e._ang = ang; telLine(e.x, e.z, ang, 14, e.r * 2, tele, '', 0, e.id); e._busy = tele; e._seq = 99; e._acd = 0; return true; }
          setAnim(e, 'windup'); telCircle(player.x, player.z, 2.6, tele, 'slam', d, 'phys', e.id); e._busy = 0.6;
        }
        break;
      }
      case 'boss_broodmother': {
        if (pick === 0) {
          setAnim(e, 'cast');
          const nw = ph === 1 ? 3 : 5;
          for (let k = 0; k < nw; k++) telLine(e.x, e.z, ang + (k - (nw - 1) / 2) * 0.28, 14, 0.8, tele, 'web', d * 0.6, e.id);
          e._busy = tele + 0.2;
        } else if (pick === 1) {
          setAnim(e, 'summon');
          const ns = ph === 1 ? 8 : 12;
          for (let k = 0; k < ns; k++) { const a = (k / ns) * TAU; spawnEnemy('spider', e.x + Math.sin(a) * 2.5, e.z + Math.cos(a) * 2.5, { mini: true, hpMul: 1.5 }); }
          e._busy = 1;
        } else if (pick === 2) {
          setAnim(e, 'cast');
          const np = ph === 1 ? 3 : 5;
          for (let k = 0; k < np; k++) telCircle(player.x + (k ? rnd(-4, 4) : 0), player.z + (k ? rnd(-4, 4) : 0), 2.3, tele + k * 0.08, 'pool', d * 0.8, 'poison', e.id);
          e._busy = 0.8;
        } else {
          if (ph >= 2) { setAnim(e, 'charge'); telCircle(player.x, player.z, 3.4, tele + 0.2, 'leap', d * 1.4, 'phys', e.id); e._busy = tele + 0.4; }
          else { setAnim(e, 'windup'); telCircle(e.x, e.z, 4, tele, 'slam', d * 1.2, 'poison', e.id); e._busy = tele + 0.2; }
        }
        break;
      }
      case 'boss_pyrelord': {
        if (pick === 0) {
          setAnim(e, 'cast');
          const nl = ph === 1 ? 3 : ph === 2 ? 5 : 8;
          const sp = ph === 3 ? TAU / nl : 0.45;
          for (let k = 0; k < nl; k++) telLine(e.x, e.z, ang + (k - (nl - 1) / 2) * sp, 15, 2.4, tele, 'firewave', d, e.id);
          e._busy = tele + 0.3;
        } else if (pick === 1) {
          setAnim(e, 'summon');
          const nm = ph === 1 ? 6 : 10;
          for (let k = 0; k < nm; k++) telCircle(player.x + (k ? rnd(-6, 6) : 0), player.z + (k ? rnd(-6, 6) : 0), 2.1, tele + 0.2 + k * 0.1, 'meteor_e', d * 1.1, 'fire', e.id);
          e._busy = 0.9;
        } else if (pick === 2) {
          setAnim(e, 'windup'); e._ang = ang; telLine(e.x, e.z, ang, 14, e.r * 2, tele, '', 0, e.id); e._busy = tele; e._seq = 99; e._acd = 0;
          return true;
        } else {
          setAnim(e, 'windup'); telCircle(e.x, e.z, 5, tele, 'slam', d * 1.3, 'fire', e.id); e._busy = tele + 0.2;
          for (let k = 0; k < 6; k++) { const a = (k / 6) * TAU; spawnEnemy('imp', e.x + Math.sin(a) * 3, e.z + Math.cos(a) * 3); }
        }
        break;
      }
      case 'boss_frostlich': {
        if (pick === 0) {
          setAnim(e, 'cast'); telCircle(e.x, e.z, 6, tele, 'nova', d * 1.1, 'frost', e.id); e._busy = tele + 0.2;
        } else if (pick === 1) {
          setAnim(e, 'cast');
          const nl = ph === 1 ? 3 : 5;
          for (let k = 0; k < nl; k++) telLine(e.x, e.z, ang + (k - (nl - 1) / 2) * 0.22, 16, 0.8, tele, 'lances', d * 0.8, e.id);
          e._busy = tele + 0.2;
        } else if (pick === 2) {
          setAnim(e, 'cast'); telCircle(player.x, player.z, 3.6, tele + 0.2, 'blizzard_e', d * 0.2, 'frost', e.id); e._busy = 0.8;
        } else {
          setAnim(e, 'summon');
          const nc = ph === 1 ? 1 : 2;
          for (let k = 0; k < nc; k++) {
            const a = rng() * TAU;
            const c = spawnEnemy('boss_frostlich', e.x + Math.sin(a) * 4, e.z + Math.cos(a) * 4, { hpMul: 0.05 });
            if (c) { c.boss = false; c._clone = true; c.scale = 2.2; c.r = 1.0; c._acd = 1.5; c._xp = 0; c._dmg = e._dmg * 0.6; }
          }
          // blink away
          const a = rng() * TAU; e.x = player.x + Math.sin(a) * 9; e.z = player.z + Math.cos(a) * 9;
          e._busy = 1;
        }
        break;
      }
    }
    e._acd = (ph === 3 ? 1.1 : ph === 2 ? 1.5 : 2.0);
    return true;
  }
  function spawnBoss(type) {
    const a = rng() * TAU;
    const b = spawnEnemy(type, player.x + Math.sin(a) * (view.halfW * 0.8), player.z + Math.cos(a) * (view.halfH * 0.8));
    if (!b) return;
    b.anim = 'spawn'; b._acd = 2.5;
    ev({ type: 'spawn', x: b.x, z: b.z, enemy: b.type });
    text(b.x, b.z, ENEMIES[type].name + ' 降臨！', '#ff5a4a');
  }
  function onBossKilled(e) {
    newPickup('chest', e.x, e.z, 3);
    for (let i = 0; i < 12; i++) { const a = i / 12 * TAU; newPickup('gold', e.x + Math.sin(a) * 1.5, e.z + Math.cos(a) * 1.5, Math.round(8 * (1 + DF.idx))); }
    dropXp(e.x, e.z, 120);
    if (!state.bossKilled && !state.endless) {
      state.bossKilled = true;
      state.phase = 'win';
      // clear the field
      for (let i = 0; i < E.length; i++) if (!E[i]._dead) { E[i]._dead = true; ev({ type: 'kill', x: E[i].x, z: E[i].z, enemy: E[i].type, elite: E[i].elite, boss: E[i].boss, rot: E[i].rot, scale: E[i].scale }); }
      for (let i = 0; i < P.length; i++) if (P[i].owner === 'e') P[i]._dead = true;
      for (let i = 0; i < Z.length; i++) if (Z[i].owner === 'e') Z[i]._dead = true;
      ev({ type: 'win' });
    } else {
      state.bossKilled = true;
    }
  }

  /* ---------- director ---------- */
  function poolPick() {
    const t = state.endless ? 9999 : state.time;
    let tot = 0;
    const pool = ST.pool;
    for (let i = 0; i < pool.length; i++) if (pool[i][0] <= t) tot += pool[i][2] * (pool[i][0] > 0 && t - pool[i][0] < 30 ? 1.6 : 1);
    let r = rng() * tot;
    for (let i = 0; i < pool.length; i++) if (pool[i][0] <= t) { r -= pool[i][2] * (pool[i][0] > 0 && t - pool[i][0] < 30 ? 1.6 : 1); if (r < 0) return pool[i][1]; }
    return pool[0][1];
  }
  function targetCount() {
    const t = state.time;
    let n = 14 + 0.4 * t + 2.4 * (t / 60) * (t / 60);
    n *= 0.85 + 0.15 * DF.idx + 0.15;
    if (state.endless) n += (t - state.timeLimit) * 0.5;
    if (bossSpawned && !state.endless) n *= 0.45;
    return Math.min(MAXE - 100, n);
  }
  const ELITE_MARKS = [60, 120, 180, 240, 300, 360, 420, 450];
  function director(dt) {
    const t = state.time;
    // wave
    const wave = Math.floor(t / 30) + 1;
    if (wave !== lastWave) {
      lastWave = wave; state.wave = wave;
      if (wave % 2 === 0 && !bossSpawned) hordeRing();
    }
    // spawns
    const target = targetCount();
    let live = 0;
    for (let i = 0; i < E.length; i++) if (!E[i]._dead) live++;
    const deficit = target - live;
    if (deficit > 0) {
      spawnAcc += dt * Math.min(40, 2.4 + deficit * 1.2);
      while (spawnAcc >= 1) {
        spawnAcc -= 1;
        const type = poolPick();
        const D = ENEMIES[type];
        if (D.pack) {
          const p = spawnPoint();
          for (let k = 0; k < D.pack; k++) spawnEnemy(type, p.x + rnd(-1.2, 1.2), p.z + rnd(-1.2, 1.2));
          spawnAcc -= D.pack - 1;
        } else {
          const p = spawnPoint();
          spawnEnemy(type, p.x, p.z);
        }
      }
    }
    // elites
    if (!state.endless && eliteIdx < ELITE_MARKS.length && t >= ELITE_MARKS[eliteIdx]) {
      eliteIdx++;
      const ne = Math.max(1, Math.round(DF.elite * (eliteIdx >= 5 ? 1.5 : 1)));
      for (let k = 0; k < ne; k++) spawnElite();
    }
    if (state.endless) {
      ringT -= dt;
      if (ringT <= 0) { ringT = 40; spawnElite(); spawnElite(); }
    } else if (DF.idx > 0 && rng() < dt * 0.004 * DF.idx) spawnElite();
    // boss
    if (!bossSpawned && t >= state.timeLimit) {
      bossSpawned = true;
      spawnBoss(ST.boss);
    }
    if (state.endless && t >= nextEndlessBoss) {
      nextEndlessBoss = t + 150;
      endlessCount++;
      spawnBoss(STAGE_IDS.map(s => STAGES[s].boss)[Math.floor(rng() * 4)]);
    }
    // shrines
    if (t >= nextShrine) {
      nextShrine = t + 70 + rng() * 40;
      for (let k = 0; k < 8; k++) {
        const a = rng() * TAU, d = 9 + rng() * 5;
        const x = player.x + Math.sin(a) * d, z = player.z + Math.cos(a) * d;
        if (insideObstacle(stageId, x, z, 1.8)) continue;
        state.shrines.push({ id: nextId++, kind: SHRINE_IDS[Math.floor(rng() * SHRINE_IDS.length)], x, z, used: false, progress: 0, _t: 0 });
        break;
      }
    }
  }
  function spawnElite() {
    let type = poolPick();
    if (ENEMIES[type].pack) type = 'ghoul';
    const p = spawnPoint();
    spawnEnemy(type, p.x, p.z, { elite: true });
  }
  function hordeRing() {
    const types = ST.pool.filter(p => p[0] <= state.time);
    const type = state.time < 120 ? (stageId === 'inferno' ? 'imp' : stageId === 'catacombs' ? 'spider' : 'bat') : types[Math.floor(rng() * types.length)][1];
    const n = Math.min(60, 16 + Math.floor(state.time / 12));
    const R = Math.max(view.halfW, view.halfH) + 1;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU;
      const x = player.x + Math.sin(a) * R, z = player.z + Math.cos(a) * R;
      if (!ENEMIES[type].fly && insideObstacle(stageId, x, z, 0.4)) continue;
      spawnEnemy(type, x, z, { hpMul: 0.7 });
    }
    text(player.x, player.z - 2, '屍潮來襲！', '#ff9a5a');
  }

  /* ---------- player ---------- */
  function updatePlayer(dt) {
    let mx = input.mx, mz = input.mz;
    const ml = Math.sqrt(mx * mx + mz * mz);
    if (ml > 1) { mx /= ml; mz /= ml; }
    if (ml < 0.12) { mx = 0; mz = 0; }
    if (player.invuln > 0) player.invuln -= dt;
    if (player._ifr > 0) player._ifr -= dt;
    if (player.hurt > 0) player.hurt = Math.max(0, player.hurt - dt * 3);
    if (player._slow > 0) player._slow -= dt;
    // dash
    if (player.dashCharges < player.dashMax) {
      player._dashT += dt;
      if (player._dashT >= player.dashCdMax) { player._dashT = 0; player.dashCharges++; }
      player.dashCd = player.dashCharges < player.dashMax ? Math.max(0, player.dashCdMax - player._dashT) : 0;
      if (player.dashCharges > 0 && player.dashCharges < player.dashMax) player.dashCd = player.dashCd; // still recharging extra
    } else { player.dashCd = 0; player._dashT = 0; }
    if (input.dash) {
      input.dash = false;
      if (player.dashCharges > 0 && player.dashing <= 0) {
        player.dashCharges--;
        let dx = mx, dz = mz;
        if (!dx && !dz) { dx = Math.sin(player.rot); dz = Math.cos(player.rot); }
        const l = Math.sqrt(dx * dx + dz * dz) || 1;
        player._dx = dx / l; player._dz = dz / l;
        player.dashing = 0.0001; player.invuln = Math.max(player.invuln, 0.35);
        ev({ type: 'dash', x: player.x, z: player.z, rot: Math.atan2(player._dx, player._dz) });
        if (S.shadowstep) { ev({ type: 'nova', x: player.x, z: player.z, r: 3.5, kind: 'dark' }); areaDamage(player.x, player.z, 3.5, 40 * (1 + state.time / 120), 'dark', -1, 3); }
      }
    }
    let vx, vz, sp;
    if (player.dashing > 0) {
      player.dashing += dt / 0.22;
      sp = 5.2 * S.speed * 3.3;
      vx = player._dx * sp; vz = player._dz * sp;
      if (player.dashing >= 1) player.dashing = 0;
    } else {
      sp = 5.2 * S.speed * (player._slow > 0 ? 1 - player._slowAmt : 1);
      vx = mx * sp; vz = mz * sp;
    }
    player.x += vx * dt; player.z += vz * dt;
    const ms = Math.sqrt(vx * vx + vz * vz);
    player.speed = ms;
    if (ms > 0.01) { player.moveX = vx / ms; player.moveZ = vz / ms; player.rot = Math.atan2(vx, vz); }
    else { player.moveX = 0; player.moveZ = 0; }
    collideObstacles(stageId, player, 0.45, player.moveX, player.moveZ);
    // regen
    if (S.regen > 0) healPlayer(S.regen * dt, true);
    if (heroId === 'knight') {
      player._knightT += dt;
      if (player._knightT >= 10) { player._knightT = 0; player.shield = Math.min(player.maxHp * 0.2, player.shield + player.maxHp * 0.2); }
    }
    player._lsBudget = Math.min(4, player._lsBudget + 4 * dt);
    // legendary storm
    if (S.stormcall) {
      stormT -= dt;
      if (stormT <= 0) {
        stormT = 2.5;
        const e = randomVisibleEnemy();
        if (e) { ev({ type: 'strike', x: e.x, z: e.z, r: 2, kind: 'light' }); areaDamage(e.x, e.z, 2, 60 * (1 + state.time / 100), 'light', -1, 1); }
      }
    }
  }

  /* ---------- pickups & shrines ---------- */
  function updatePickups(dt) {
    const px = player.x, pz = player.z, pr = player.pickupR;
    for (let i = 0; i < K.length; i++) {
      const k = K[i];
      if (k._dead) continue;
      k.age += dt;
      const dx = px - k.x, dz = pz - k.z, d2 = dx * dx + dz * dz;
      if (!k.magnet && d2 < pr * pr && k.kind !== 'chest') k.magnet = true;
      if (k.kind === 'chest' && d2 < 1.1 * 1.1) { collect(k); continue; }
      if (k.magnet) {
        const d = Math.sqrt(d2) || 0.001;
        k._v = Math.min(22, k._v + 30 * dt);
        const s = Math.min(d, (k._v + player.speed) * dt);
        k.x += dx / d * s; k.z += dz / d * s;
        if (d < 0.55) { collect(k); continue; }
      } else if (d2 > 90 * 90 && k.kind !== 'chest') { k._dead = true; }
    }
    for (let i = state.shrines.length - 1; i >= 0; i--) {
      const s = state.shrines[i];
      const dx = px - s.x, dz = pz - s.z, d2 = dx * dx + dz * dz;
      if (s.used) { s._t += dt; if (s._t > 4) state.shrines.splice(i, 1); continue; }
      if (d2 > 70 * 70) { state.shrines.splice(i, 1); continue; }
      if (d2 < 1.8 * 1.8) s.progress = Math.min(1, s.progress + dt / 2); else s.progress = Math.max(0, s.progress - dt / 4);
      if (s.progress >= 1) {
        s.used = true; s._t = 0;
        let b = null;
        for (const x of state.buffs) if (x.kind === s.kind) b = x;
        if (b) b.t = 30; else state.buffs.push({ kind: s.kind, t: 30, max: 30 });
        recalc();
        ev({ type: 'shrine', kind: s.kind, x: s.x, z: s.z });
        text(s.x, s.z, SHRINES[s.kind].name, SHRINES[s.kind].color);
      }
    }
    let changed = false;
    for (let i = state.buffs.length - 1; i >= 0; i--) { state.buffs[i].t -= dt; if (state.buffs[i].t <= 0) { state.buffs.splice(i, 1); changed = true; } }
    if (changed) recalc();
  }
  function collect(k) {
    k._dead = true;
    switch (k.kind) {
      case 'xp_s': case 'xp_m': case 'xp_l': {
        let v = k.value * S.xp;
        player.xp += v;
        while (player.xp >= player.xpNext) {
          player.xp -= player.xpNext; player.level++; player.xpNext = xpForLevel(player.level);
          state.pendingLevels++;
          ev({ type: 'levelup', level: player.level });
        }
        break;
      }
      case 'gold': { const g = Math.max(1, Math.round(k.value * S.gold * DF.gold)); state.gold += g; break; }
      case 'heart': healPlayer(k.value + player.maxHp * 0.1); break;
      case 'magnet': for (let i = 0; i < K.length; i++) if (K[i].kind !== 'chest') K[i].magnet = true; break;
      case 'bomb': {
        ev({ type: 'explode', x: player.x, z: player.z, r: Math.max(view.halfW, view.halfH), kind: 'fire' });
        for (let i = 0; i < E.length; i++) {
          const e = E[i]; if (e._dead) continue;
          if (Math.abs(e.x - player.x) > view.halfW + 1 || Math.abs(e.z - player.z) > view.halfH + 1) continue;
          hitEnemy(e, e.boss ? e.maxHp * 0.04 / dmgMulCache : (e.elite ? e.maxHp * 0.3 : e.maxHp * 2 + 50) / dmgMulCache, 'fire', -1, true);
        }
        break;
      }
      case 'chest': openChest(k.value | 0); break;
    }
    ev({ type: 'pickup', kind: k.kind, x: k.x, z: k.z, value: k.value });
  }

  /* ---------- level-up choices ---------- */
  function ownedWeapon(id) { for (const w of state.weapons) if (w.id === id) return w; return null; }
  function ownedPassive(id) { for (const p of state.passives) if (p.id === id) return p; return null; }
  function evolvable() {
    const out = [];
    for (const w of state.weapons) {
      const W = ALL_WEAPONS[w.id];
      if (W.evolved || w.level < 6) continue;
      if (ownedPassive(W.evoPassive)) out.push(w.id);
    }
    return out;
  }
  function choiceFor(kind, id) {
    if (kind === 'weapon') {
      const W = ALL_WEAPONS[id], o = ownedWeapon(id);
      const lv = o ? o.level + 1 : 1;
      return { id, kind, name: W.name, desc: o ? W.up[lv - 2].t : W.desc, level: lv, maxLevel: 6, rarity: !o ? 'magic' : lv >= 6 ? 'rare' : lv >= 4 ? 'magic' : 'common', iconId: W.iconId, isNew: !o };
    }
    if (kind === 'passive') {
      const Pd = PASSIVES[id], o = ownedPassive(id);
      const lv = o ? o.level + 1 : 1;
      return { id, kind, name: Pd.name, desc: Pd.desc, level: lv, maxLevel: 5, rarity: !o ? 'magic' : lv >= 5 ? 'rare' : 'common', iconId: Pd.iconId, isNew: !o };
    }
    if (kind === 'evolution') {
      const W = ALL_WEAPONS[WEAPONS[id].evo];
      return { id: W.id, kind, from: id, name: W.name, desc: W.desc, level: 1, maxLevel: 1, rarity: 'legendary', iconId: W.iconId, isNew: true };
    }
    if (kind === 'gold') return { id: 'gold', kind, name: '金幣袋', desc: '獲得 ' + (25 + 5 * player.level) + ' 金幣', level: 0, maxLevel: 0, rarity: 'common', iconId: 'c_gold', value: 25 + 5 * player.level };
    return { id: 'heal', kind: 'heal', name: '生命藥水', desc: '回復 50% 生命', level: 0, maxLevel: 0, rarity: 'common', iconId: 'c_heal' };
  }
  function candidatePool() {
    const out = [];
    const ban = state.banished;
    const nW = state.weapons.length, nP = state.passives.length;
    for (const w of state.weapons) if (!ALL_WEAPONS[w.id].evolved && w.level < 6 && ban.indexOf(w.id) < 0) out.push(['weapon', w.id, 3]);
    for (const p of state.passives) if (p.level < 5 && ban.indexOf(p.id) < 0) out.push(['passive', p.id, 2]);
    if (nW < 6) for (const id of WEAPON_IDS) {
      if (ban.indexOf(id) >= 0 || ownedWeapon(id) || ownedWeapon(WEAPONS[id].evo)) continue;
      out.push(['weapon', id, nW < 3 ? 1.6 : 0.8]);
    }
    if (nP < 6) for (const id of PASSIVE_IDS) {
      if (ban.indexOf(id) >= 0 || ownedPassive(id)) continue;
      // favour passives that enable an owned weapon's evolution
      let w = 1;
      for (const ow of state.weapons) if (ALL_WEAPONS[ow.id].evoPassive === id && !ALL_WEAPONS[ow.id].evolved) w = 2.2;
      out.push(['passive', id, w]);
    }
    return out;
  }
  function rollChoices(n) {
    const pool = candidatePool();
    const res = [];
    while (res.length < n && pool.length) {
      let tot = 0; for (const c of pool) tot += c[2];
      let r = rng() * tot, k = 0;
      for (; k < pool.length - 1; k++) { r -= pool[k][2]; if (r < 0) break; }
      const c = pool.splice(k, 1)[0];
      res.push(choiceFor(c[0], c[1]));
    }
    if (!res.length) { res.push(choiceFor('gold')); res.push(choiceFor('heal')); }
    return res;
  }
  function numChoices() { return S.luck >= 1.3 || rng() < (S.luck - 1) * 2 ? 4 : 3; }
  function openLevelUp() {
    state.phase = 'levelup';
    choices = rollChoices(numChoices());
  }
  function applyChoice(c) {
    if (c.kind === 'weapon') {
      const o = ownedWeapon(c.id);
      if (o) o.level = Math.min(6, o.level + 1);
      else if (state.weapons.length < 6) state.weapons.push({ id: c.id, level: 1, cd: 0, _t: 0, _dmg: 0, _burst: 0, _burstT: 0, _fired: false });
    } else if (c.kind === 'passive') {
      const o = ownedPassive(c.id);
      if (o) o.level = Math.min(5, o.level + 1);
      else if (state.passives.length < 6) state.passives.push({ id: c.id, level: 1 });
    } else if (c.kind === 'evolution') {
      const o = ownedWeapon(c.from);
      if (o) {
        // clean up the old weapon's persistent things
        const si = state.weapons.indexOf(o);
        for (let i = 0; i < P.length; i++) if (P[i]._src === si && P[i].owner === 'p') P[i]._dead = true;
        o.id = c.id; o.level = 1; o._t = 0; o._fired = false;
        ev({ type: 'evolve', weapon: c.id });
        text(player.x, player.z, ALL_WEAPONS[c.id].name + '！', '#ff9a2a');
      }
    } else if (c.kind === 'gold') state.gold += c.value;
    else if (c.kind === 'heal') healPlayer(player.maxHp * 0.5);
    recalc();
  }
  function openChest(tier) {
    state.chestsOpened++;
    const rewards = [];
    const evo = evolvable();
    let n = 1;
    const r = rng();
    const lk = S.luck;
    if (tier >= 3) n = 3; else if (r < 0.1 * lk) n = 3; else if (r < 0.35 * lk) n = 2;
    for (const id of evo) { if (rewards.length < n) rewards.push(choiceFor('evolution', id)); }
    // upgrades of owned items
    const own = [];
    for (const w of state.weapons) if (!ALL_WEAPONS[w.id].evolved && w.level < 6) own.push(['weapon', w.id]);
    for (const p of state.passives) if (p.level < 5) own.push(['passive', p.id]);
    const taken = {};
    while (rewards.length < n && own.length) {
      const c = own.splice(Math.floor(rng() * own.length), 1)[0];
      if (taken[c[1]]) continue; taken[c[1]] = 1;
      rewards.push(choiceFor(c[0], c[1]));
    }
    while (rewards.length < n) rewards.push(rewards.length % 2 ? choiceFor('heal') : choiceFor('gold'));
    chestRewards = rewards;
    choices = rewards;
    if (state.phase === 'play' || state.phase === 'levelup') { chestReturn = state.phase; state.phase = 'chest'; }
  }
  let chestReturn = 'play';
  function afterChoice() {
    if (state.phase === 'dead' || state.phase === 'win') return;
    if (state.pendingLevels > 0) { openLevelUp(); }
    else { state.phase = 'play'; choices = []; }
  }

  /* ---------- step ---------- */
  function compact(arr, pool) {
    let w = 0;
    for (let i = 0; i < arr.length; i++) {
      const o = arr[i];
      if (o._dead) { if (pool && pool.length < 1500) pool.push(o); continue; }
      arr[w++] = o;
    }
    arr.length = w;
  }
  function step(dt) {
    state.time += dt;
    dmgMulCache = S.might * rageMult() * necroMult();
    director(dt);
    buildGrid(E, E.length, player.x, player.z);
    updatePlayer(dt);
    if (state.phase !== 'play') return;
    updateWeapons(dt);
    updateProjectiles(dt);
    updateZones(dt);
    updateAllies(dt);
    updateEnemies(dt);
    updatePickups(dt);
    compact(E, poolE); compact(P, poolP); compact(Z, poolZ); compact(K, poolK);
    // boss hp
    let b = null;
    for (let i = 0; i < E.length; i++) if (E[i].boss) { b = E[i]; break; }
    if (b) {
      if (!state.bossHp || state.bossHp._id !== b.id) state.bossHp = { cur: b.hp, max: b.maxHp, name: ENEMIES[b.type].name, _id: b.id };
      state.bossHp.cur = Math.max(0, b.hp); state.bossHp.max = b.maxHp;
    } else state.bossHp = null;
    if (state.phase === 'play' && state.pendingLevels > 0) openLevelUp();
  }

  /* ---------- summary ---------- */
  function buildSummary() {
    const lr = mulberry32((seed ^ 0x9e3779b9) + state.kills * 7 + Math.floor(state.time));
    const loot = [];
    const lk = S.luck;
    let nItems = Math.min(8, Math.floor(state.chestsOpened * 0.6 + state.elitesKilled * 0.2));
    if (state.time >= 180) nItems++;
    for (let i = 0; i < nItems; i++) loot.push(generateItem(lr, { difficulty: DF.idx, luck: lk }));
    if (state.bossKilled) {
      loot.push(generateItem(lr, { difficulty: DF.idx, minRarity: 'magic', luck: lk * 1.5 }));
      loot.push(generateItem(lr, { difficulty: DF.idx, minRarity: 'rare', luck: lk * 1.5 }));
    }
    const bonus = Math.round((Math.floor(state.time / 10) + (state.bossKilled ? 150 : 0)) * DF.gold * (1 + 0.15 * ST.order));
    return {
      time: state.time, kills: state.kills, gold: state.gold + bonus, goldCollected: state.gold, goldBonus: bonus, level: player.level,
      weapons: state.weapons.map(w => ({ id: w.id, level: w.level, dmg: Math.round(w._dmg) })),
      passives: state.passives.map(p => ({ id: p.id, level: p.level })),
      loot, win: state.bossKilled, stage: stageId, hero: heroId, difficulty: diffId, elitesKilled: state.elitesKilled,
      endless: state.endless, dmgTaken: Math.round(state.dmgTaken)
    };
  }

  /* ---------- public ---------- */
  recalc();
  player.hp = player.maxHp;
  player.dashCharges = player.dashMax;
  state.weapons.push({ id: HD.weapon, level: 1, cd: 0, _t: 0, _dmg: 0, _burst: 0, _burstT: 0, _fired: false });
  recalc();
  if (counts.startLv > 0) { state.pendingLevels += counts.startLv; }
  if (state.pendingLevels > 0) openLevelUp();

  const game = {
    state, events,
    setInput(i) {
      if (!i) return;
      input.mx = clamp(+i.mx || 0, -1, 1); input.mz = clamp(+i.mz || 0, -1, 1);
      if (i.dash) input.dash = true;
    },
    setViewExtents(hw, hh) { if (hw > 2 && hh > 2 && isFinite(hw) && isFinite(hh)) { view.halfW = Math.min(40, hw); view.halfH = Math.min(40, hh); } },
    update(dt) {
      if (!(dt > 0)) return;
      dt = Math.min(dt, 0.1);
      hitEvents = 0;
      if (state.phase !== 'play') return;
      const n = Math.max(1, Math.ceil(dt / (1 / 60) - 0.01));
      const h = dt / n;
      for (let i = 0; i < n && state.phase === 'play'; i++) step(h);
    },
    getChoices() { return state.phase === 'levelup' || state.phase === 'chest' ? choices : []; },
    choose(i) {
      if (state.phase === 'chest') {
        for (const c of chestRewards || []) applyChoice(c);
        chestRewards = null;
        state.phase = 'play';
        afterChoice();
        return true;
      }
      if (state.phase !== 'levelup') return false;
      const c = choices[i | 0];
      if (!c) return false;
      applyChoice(c);
      state.pendingLevels = Math.max(0, state.pendingLevels - 1);
      afterChoice();
      return true;
    },
    reroll() {
      if (state.phase !== 'levelup' || state.rerolls <= 0) return false;
      state.rerolls--;
      choices = rollChoices(choices.length || 3);
      return true;
    },
    banish(i) {
      if (state.phase !== 'levelup' || state.banishes <= 0) return false;
      const c = choices[i | 0];
      if (!c || (c.kind !== 'weapon' && c.kind !== 'passive')) return false;
      state.banishes--;
      state.banished.push(c.id);
      const others = choices.filter((x, k) => k !== (i | 0));
      const pool = candidatePool().filter(p => !others.some(o => o.id === p[1]));
      let rep = null;
      if (pool.length) { const p = pool[Math.floor(rng() * pool.length)]; rep = choiceFor(p[0], p[1]); }
      if (rep) choices[i | 0] = rep; else choices.splice(i | 0, 1);
      if (!choices.length) choices.push(choiceFor('gold'));
      return true;
    },
    skip() {
      if (state.phase !== 'levelup' || state.skips <= 0) return false;
      state.skips--;
      state.pendingLevels = Math.max(0, state.pendingLevels - 1);
      afterChoice();
      return true;
    },
    getSummary() {
      if (summaryCache && (state.phase === 'dead' || state.phase === 'win')) return summaryCache;
      summaryCache = buildSummary();
      return summaryCache;
    },
    continueEndless() {
      if (state.phase !== 'win') return false;
      state.phase = 'play'; state.endless = true; summaryCache = null;
      nextEndlessBoss = state.time + 150; ringT = 20;
      text(player.x, player.z, '無盡模式', '#ff5a4a');
      return true;
    },
    getStats() { return S; },
    weaponStats(id, level) { return Object.assign({}, weaponStats(id, level, weaponTmp)); },
    // debug/test helpers
    debug: {
      give(id, level) {
        if (ALL_WEAPONS[id]) {
          let o = ownedWeapon(id);
          if (!o) {
            if (ALL_WEAPONS[id].evolved) { const from = ownedWeapon(ALL_WEAPONS[id].from); if (from) { from.id = id; from.level = 1; o = from; } }
            if (!o) { if (state.weapons.length >= 6) state.weapons.pop(); o = { id, level: 1, cd: 0, _t: 0, _dmg: 0, _burst: 0, _burstT: 0, _fired: false }; state.weapons.push(o); }
          }
          o.level = Math.max(1, Math.min(ALL_WEAPONS[id].evolved ? 1 : 6, level || 1));
        } else if (PASSIVES[id]) {
          let o = ownedPassive(id);
          if (!o) { if (state.passives.length >= 6) state.passives.pop(); o = { id, level: 1 }; state.passives.push(o); }
          o.level = Math.max(1, Math.min(5, level || 1));
        }
        recalc();
      },
      spawn(type, n, opt) { const out = []; for (let i = 0; i < (n || 1); i++) { const p = spawnPoint(); const e = spawnEnemy(type, p.x, p.z, opt); if (e) out.push(e); } return out; },
      spawnAt(type, x, z, opt) { return spawnEnemy(type, x, z, opt); },
      killAll() { for (let i = 0; i < E.length; i++) if (!E[i]._dead && !E[i].boss) killEnemy(E[i], 'phys'); compact(E, poolE); },
      win() { for (let i = 0; i < E.length; i++) if (E[i].boss) killEnemy(E[i], 'holy'); if (!state.bossKilled) { state.bossKilled = true; state.phase = 'win'; ev({ type: 'win' }); } },
      setTime(t) { state.time = t; eliteIdx = 0; while (eliteIdx < ELITE_MARKS.length && ELITE_MARKS[eliteIdx] <= t) eliteIdx++; lastWave = Math.floor(t / 30) + 1; state.wave = lastWave; nextShrine = t + 20; },
      spawnBoss() { if (!bossSpawned) { bossSpawned = true; spawnBoss(ST.boss); } },
      chest(tier) { openChest(tier || 1); },
      heal() { player.hp = player.maxHp; },
      god(on) { player.invuln = on ? 1e9 : 0; },
      xp(v) { collect({ kind: 'xp_l', value: v, _dead: false, x: player.x, z: player.z }); if (state.phase === 'play' && state.pendingLevels > 0) openLevelUp(); },
      shrine(kind) { state.shrines.push({ id: nextId++, kind: kind || 'shrine_power', x: player.x + 3, z: player.z, used: false, progress: 0, _t: 0 }); },
      pickup(kind, value) { newPickup(kind, player.x + 2, player.z, value || 1); },
      projectiles(n) { for (let i = 0; i < n; i++) { const a = rng() * TAU, d = 6 + rng() * 6; const q = newProj('e_bolt', 'e', player.x + Math.sin(a) * d, player.z + Math.cos(a) * d, Math.sin(a) * 2, Math.cos(a) * 2, 0.3, 30, 1); } }
    }
  };
  return game;
}

/* =====================================================================
 * Simple bot (used by tests and the in-page autopilot)
 * ===================================================================== */
const BOT = { mx: 0, mz: 0, dash: false, _a: 0 };
const BOT_SC = new Float32Array(16);
export function botInput(game) {
  const s = game.state, p = s.player;
  if (BOT._g !== game) { BOT._g = game; BOT._a = 0; }
  const NDIR = 16;
  BOT_SC.fill(0);
  let close = 0, danger = false;
  const addThreat = (x, z, w, rad) => {
    const dx = x - p.x, dz = z - p.z, d = Math.sqrt(dx * dx + dz * dz) || 0.01;
    const ax = dx / d, az = dz / d;
    for (let k = 0; k < NDIR; k++) {
      const a = k / NDIR * Math.PI * 2, c = Math.sin(a) * ax + Math.cos(a) * az;
      if (c > -0.2) { const dd = Math.max(0.35, d - rad - 0.45); BOT_SC[k] -= w * (c + 0.2) * 2.5 / (dd * dd); }
    }
  };
  for (let i = 0; i < s.enemies.length; i++) {
    const e = s.enemies[i];
    const dx = p.x - e.x, dz = p.z - e.z, d2 = dx * dx + dz * dz;
    if (d2 > 100) continue;
    addThreat(e.x, e.z, e.boss ? 8 : e.elite ? 3 : 1, e.r);
    if (d2 < (2.2 + e.r) * (2.2 + e.r)) close++;
  }
  for (let i = 0; i < s.projectiles.length; i++) {
    const q = s.projectiles[i];
    if (q.owner !== 'e') continue;
    const dx = p.x - q.x, dz = p.z - q.z, d2 = dx * dx + dz * dz;
    if (d2 > 25) continue;
    if (dx * q.vx + dz * q.vz <= 0) continue; // moving away
    addThreat(q.x, q.z, 3, 0);
    const sp = Math.sqrt(q.vx * q.vx + q.vz * q.vz) || 1;
    const nx = -q.vz / sp, nz = q.vx / sp, side = (dx * nx + dz * nz) >= 0 ? 1 : -1;
    for (let k = 0; k < NDIR; k++) { const a = k / NDIR * Math.PI * 2; BOT_SC[k] += 4 / (d2 + 1) * side * (Math.sin(a) * nx + Math.cos(a) * nz); }
  }
  for (let i = 0; i < s.zones.length; i++) {
    const q = s.zones[i];
    if (q.owner !== 'e') continue;
    let inside = false, ex = 0, ez = 0;
    if (q.kind === 'telegraph_line') {
      const dx = p.x - q.x, dz = p.z - q.z, ca = Math.sin(q.angle), sa = Math.cos(q.angle);
      const along = dx * ca + dz * sa, perp = dx * sa - dz * ca;
      if (along > -1 && along < q.len + 1 && Math.abs(perp) < q.width / 2 + 1.2) { inside = true; const sg = perp >= 0 ? 1 : -1; ex = sa * sg; ez = -ca * sg; }
    } else {
      const dx = p.x - q.x, dz = p.z - q.z, d = Math.sqrt(dx * dx + dz * dz) || 0.01;
      if (d < q.r + 1.2) { inside = true; ex = dx / d; ez = dz / d; }
    }
    if (inside) {
      const w = q.kind.indexOf('telegraph') === 0 ? 30 : 6;
      if (q.kind.indexOf('telegraph') === 0) danger = true;
      for (let k = 0; k < NDIR; k++) { const a = k / NDIR * Math.PI * 2; BOT_SC[k] += w * (Math.sin(a) * ex + Math.cos(a) * ez); }
    }
  }
  // pickups / shrines attraction
  let best = null, bd = 1e9;
  for (let i = 0; i < s.pickups.length; i++) {
    const k = s.pickups[i];
    if (k.magnet) continue;
    const dx = k.x - p.x, dz = k.z - p.z, d2 = dx * dx + dz * dz;
    const w = k.kind === 'chest' ? 0.1 : k.kind === 'heart' ? (p.hp < p.maxHp * 0.7 ? 0.15 : 4) : k.kind === 'xp_s' ? 1 : 0.6;
    if (d2 < 300 && d2 * w < bd) { bd = d2 * w; best = k; }
  }
  for (let i = 0; i < s.shrines.length; i++) {
    const q = s.shrines[i]; if (q.used) continue;
    const dx = q.x - p.x, dz = q.z - p.z, d2 = dx * dx + dz * dz;
    if (d2 < 400 && d2 * 0.3 < bd) { bd = d2 * 0.3; best = q; }
  }
  if (best) {
    const dx = best.x - p.x, dz = best.z - p.z, d = Math.sqrt(dx * dx + dz * dz) || 1;
    for (let k = 0; k < NDIR; k++) { const a = k / NDIR * Math.PI * 2; BOT_SC[k] += 1.4 * (Math.sin(a) * dx / d + Math.cos(a) * dz / d); }
  }
  // engage: drift toward the nearest enemy when nothing is close (weapons need targets)
  if (close === 0) {
    let ne = null, nd = 1e9;
    for (let i = 0; i < s.enemies.length; i++) { const e = s.enemies[i]; const dx = e.x - p.x, dz = e.z - p.z, d2 = dx * dx + dz * dz; if (d2 < nd) { nd = d2; ne = e; } }
    if (ne && nd > 9) {
      const d = Math.sqrt(nd), dx = (ne.x - p.x) / d, dz = (ne.z - p.z) / d;
      for (let k = 0; k < NDIR; k++) { const a = k / NDIR * Math.PI * 2; BOT_SC[k] += 0.5 * (Math.sin(a) * dx + Math.cos(a) * dz); }
    }
  }
  // stay near origin-ish loosely, avoid obstacles, prefer continuing direction
  const obs = obstaclesNear(s.stage, p.x, p.z, 3.5);
  for (let k = 0; k < NDIR; k++) {
    const a = k / NDIR * Math.PI * 2, sx = Math.sin(a), sz = Math.cos(a);
    for (const o of obs) {
      const dx = o.x - p.x, dz = o.z - p.z, d = Math.sqrt(dx * dx + dz * dz) || 0.01;
      const c = (sx * dx + sz * dz) / d;
      if (c > 0.3 && d < o.r + 2.5) BOT_SC[k] -= 2 * c / Math.max(0.3, d - o.r);
    }
    BOT_SC[k] += 0.25 * Math.cos(a - BOT._a);
    BOT_SC[k] -= 0.0015 * (sx * p.x + sz * p.z);
  }
  let bk = 0;
  for (let k = 1; k < NDIR; k++) if (BOT_SC[k] > BOT_SC[bk]) bk = k;
  BOT._a = bk / NDIR * Math.PI * 2;
  BOT.mx = Math.sin(BOT._a); BOT.mz = Math.cos(BOT._a);
  BOT.dash = (close >= 5 || danger || (close >= 3 && p.hp < p.maxHp * 0.4)) && p.dashCharges > 0;
  return BOT;
}
export function botPick(game) {
  const c = game.getChoices();
  if (!c.length) return 0;
  const s = game.state;
  let best = 0, bs = -1e9;
  for (let i = 0; i < c.length; i++) {
    const x = c[i];
    let sc = 0;
    if (x.kind === 'evolution') sc = 100;
    else if (x.kind === 'weapon') sc = x.isNew ? (s.weapons.length < 4 ? 40 : 15) : 50 + x.level;
    else if (x.kind === 'passive') {
      sc = x.isNew ? 20 : 25;
      for (const w of s.weapons) if (DATA.weapons[w.id].evoPassive === x.id && !DATA.weapons[w.id].evolved) sc += 30;
      if (x.id === 'might' || x.id === 'vitality' || x.id === 'armor') sc += 6;
    } else sc = x.kind === 'heal' && s.player.hp < s.player.maxHp * 0.5 ? 10 : 1;
    if (sc > bs) { bs = sc; best = i; }
  }
  return best;
}
