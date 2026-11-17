/*
 * 深淵倖存者 — shell: loop, input, HUD/menus (DOM), audio, saves, 2D fallback view.
 */
import { createGame, DATA, obstaclesNear, botInput, botPick, talentCost, describeAffix, salvageValue, itemPower } from './core.js';

const KG = window.KG;
const $ = s => document.querySelector(s);
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtTime = t => { t = Math.max(0, Math.floor(t)); return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };
const fmtNum = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n));

/* =====================================================================
 * Save + settings
 * ===================================================================== */
const SLOT_IDS = Object.keys(DATA.slots);
function defSave() {
  return { v: 1, gold: 0, talents: {}, inventory: [], equipped: { weapon: null, helm: null, armor: null, ring: null, amulet: null },
    stats: { kills: 0, runs: 0, bestTime: 0, wins: 0, cleared: {}, maxDiff: -1, best: {} },
    last: { hero: 'knight', stage: 'graveyard', difficulty: 'normal' } };
}
function loadSave() {
  const s = KG.store.get('abyss:save', null);
  const d = defSave();
  if (!s || typeof s !== 'object') return d;
  const o = Object.assign(d, s);
  o.stats = Object.assign(defSave().stats, s.stats || {});
  o.equipped = Object.assign(defSave().equipped, s.equipped || {});
  o.last = Object.assign(defSave().last, s.last || {});
  if (!Array.isArray(o.inventory)) o.inventory = [];
  return o;
}
let save = loadSave();
function persist() { KG.store.set('abyss:save', save); }
const settings = Object.assign({ music: true, sfx: true, quality: 'auto', dmgNumbers: true, shake: true, stick: 'full' }, KG.store.get('abyss:settings', {}) || {});
function persistSettings() { KG.store.set('abyss:settings', settings); }

function heroUnlocked(id) {
  const u = DATA.heroes[id].unlock;
  if (!u) return true;
  if (u.kind === 'survive') return save.stats.bestTime >= u.v;
  if (u.kind === 'kills') return save.stats.kills >= u.v;
  if (u.kind === 'win') return save.stats.wins >= u.v;
  return true;
}
function heroProgress(id) {
  const u = DATA.heroes[id].unlock; if (!u) return '';
  if (u.kind === 'survive') return fmtTime(save.stats.bestTime) + ' / ' + fmtTime(u.v);
  if (u.kind === 'kills') return save.stats.kills + ' / ' + u.v;
  if (u.kind === 'win') return save.stats.wins + ' / ' + u.v;
  return '';
}
function stageUnlocked(id) {
  const u = DATA.stages[id].unlock;
  if (!u) return true;
  return save.stats.cleared[u.stage] != null;
}
function diffUnlocked(idx) { return idx <= (save.stats.maxDiff | 0) + 1 || idx === 0; }
function metaForRun() {
  return { talents: Object.assign({}, save.talents), equipped: SLOT_IDS.map(s => save.equipped[s]).filter(Boolean) };
}

/* =====================================================================
 * Icons (inline SVG, dark gothic + gold trim)
 * ===================================================================== */
const G = {
  // weapons
  sword: '<path d="M33 9l6 0 0 6-17 17-4-4z" fill="#dfe6ee" stroke="#6a7a8a"/><path d="M14 27l7 7-3 3-7-7z" fill="url(#agold)"/><path d="M12 35l-3 4 1 1 4-3z" fill="#7a5524"/>',
  holyblade: '<circle cx="24" cy="24" r="16" fill="none" stroke="#fff3b0" stroke-width="2" opacity=".7"/><path d="M33 9l6 0 0 6-17 17-4-4z" fill="#fffbe0" stroke="#e8c870"/><path d="M14 27l7 7-3 3-7-7z" fill="url(#agold)"/><path d="M24 3v6M24 39v6M3 24h6M39 24h6" stroke="#fff3b0" stroke-width="2"/>',
  firebolt: '<path d="M24 8c6 7 11 12 11 19a11 11 0 0 1-22 0c0-5 3-8 5-11 0 4 2 6 4 6-1-5 0-10 2-14z" fill="#ff7a2a"/><path d="M24 22c3 3 5 5 5 8a5 5 0 0 1-10 0c0-3 3-5 5-8z" fill="#ffe08a"/>',
  meteor: '<path d="M8 8l18 14M12 6l16 13M6 13l17 12" stroke="#ff9a3a" stroke-width="3" stroke-linecap="round"/><circle cx="31" cy="31" r="10" fill="#6a3a2a" stroke="#ff7a2a" stroke-width="2"/><circle cx="28" cy="29" r="2.5" fill="#ffb060"/><circle cx="34" cy="34" r="2" fill="#ffb060"/>',
  arrows: '<g stroke="#e0d0b0" stroke-width="2"><path d="M10 38L36 12"/><path d="M14 40L40 16" opacity=".8"/><path d="M8 34L32 10" opacity=".8"/></g><path d="M36 12l-7 1 6 6z" fill="#cfd8e0"/><path d="M40 16l-7 1 6 6z" fill="#cfd8e0"/><path d="M32 10l-7 1 6 6z" fill="#cfd8e0"/>',
  arrowstorm: '<g stroke="#e0d0b0" stroke-width="2"><path d="M10 6v20M18 10v22M26 4v22M34 9v22M42 6v18"/></g><g fill="#cfd8e0"><path d="M7 26h6l-3 6z"/><path d="M15 32h6l-3 6z"/><path d="M23 26h6l-3 6z"/><path d="M31 31h6l-3 6z"/><path d="M39 24h6l-3 6z"/></g>',
  axes: '<path d="M14 38L32 14" stroke="#7a5524" stroke-width="3.5" stroke-linecap="round"/><path d="M28 8c8 0 13 6 12 14l-6-2-4-6z" fill="#cfd8e0" stroke="#6a7a8a"/><path d="M26 18l-6-4c2-5 5-7 8-6z" fill="#aab4c0"/>',
  bloodaxes: '<path d="M12 38L30 14M36 38L18 14" stroke="#5a1a14" stroke-width="3.5" stroke-linecap="round"/><path d="M27 8c7 0 12 5 11 12l-6-2-3-5z" fill="#d84040"/><path d="M21 8c-7 0-12 5-11 12l6-2 3-5z" fill="#d84040"/><circle cx="24" cy="36" r="3" fill="#ff5050"/>',
  orbs: '<circle cx="24" cy="24" r="5" fill="#fff3b0"/><circle cx="24" cy="24" r="14" fill="none" stroke="#d9b25f" stroke-dasharray="3 4"/><circle cx="24" cy="10" r="4.5" fill="#bfe0ff"/><circle cx="36" cy="31" r="4.5" fill="#bfe0ff"/><circle cx="12" cy="31" r="4.5" fill="#bfe0ff"/>',
  soulring: '<circle cx="24" cy="24" r="15" fill="none" stroke="#b48aff" stroke-width="2"/><g fill="#d8c0ff"><circle cx="24" cy="9" r="4"/><circle cx="37" cy="16.5" r="4"/><circle cx="37" cy="31.5" r="4"/><circle cx="24" cy="39" r="4"/><circle cx="11" cy="31.5" r="4"/><circle cx="11" cy="16.5" r="4"/></g><circle cx="24" cy="24" r="4" fill="#fff"/>',
  chain: '<path d="M27 5L13 26h9l-5 17 18-24h-10z" fill="#ffe04a" stroke="#fff6b0"/>',
  thunderstorm: '<path d="M12 22a7 7 0 0 1 3-13 9 9 0 0 1 17 1 6 6 0 0 1 2 12z" fill="#5a5a7a" stroke="#9a9ac0"/><path d="M25 22l-7 11h6l-3 11 10-14h-6l3-8z" fill="#ffe04a"/>',
  nova: '<g stroke="#bfe8ff" stroke-width="2.5" stroke-linecap="round"><path d="M24 6v36M8.4 15l31.2 18M8.4 33l31.2-18"/></g><g stroke="#bfe8ff" stroke-width="2"><path d="M20 9l4 4 4-4M20 39l4-4 4 4"/></g><circle cx="24" cy="24" r="4" fill="#fff"/>',
  blizzard: '<path d="M8 18c8-8 24-8 32 2" fill="none" stroke="#9ec4e8" stroke-width="2.5"/><path d="M6 28c10-7 26-6 36 3" fill="none" stroke="#bfe8ff" stroke-width="2.5"/><g stroke="#fff" stroke-width="2"><path d="M24 30v12M19 33l10 6M29 33l-10 6"/></g>',
  aura: '<circle cx="24" cy="24" r="16" fill="none" stroke="#ffe08a" stroke-width="3" opacity=".9"/><circle cx="24" cy="24" r="11" fill="none" stroke="#fff3b0" stroke-width="1.5" opacity=".6"/><path d="M24 15c4 5 5 7 5 10a5 5 0 0 1-10 0c0-3 2-6 5-10z" fill="#fff3b0"/>',
  inferno_aura: '<circle cx="24" cy="24" r="16" fill="none" stroke="#ff5a1a" stroke-width="3"/><path d="M24 11c6 7 8 10 8 14a8 8 0 0 1-16 0c0-4 4-8 8-14z" fill="#ff7a2a"/><path d="M24 20c3 3 4 5 4 7a4 4 0 0 1-8 0c0-2 2-4 4-7z" fill="#ffe08a"/><g fill="#ff9a3a"><path d="M8 20l3 4-4 2z"/><path d="M40 20l-3 4 4 2z"/></g>',
  daggers: '<path d="M10 36L28 18l3 3-18 18z" fill="#dfe6ee"/><path d="M28 18l8-8-2 6z" fill="#dfe6ee"/><path d="M20 40l16-16 3 3-16 16z" fill="#cfd8e0" opacity=".85"/><path d="M36 24l6-6-1 5z" fill="#cfd8e0"/>',
  thousand: '<g fill="#dfe6ee"><path d="M24 4l3 10h-6z"/><path d="M24 44l-3-10h6z"/><path d="M4 24l10-3v6z"/><path d="M44 24l-10 3v-6z"/><path d="M10 10l9 5-4 4z"/><path d="M38 38l-9-5 4-4z"/><path d="M38 10l-5 9-4-4z"/><path d="M10 38l5-9 4 4z"/></g><circle cx="24" cy="24" r="4" fill="#d9b25f"/>',
  minions: '<path d="M24 8c-8 0-13 5-13 12 0 4 2 6 4 8v5h18v-5c2-2 4-4 4-8 0-7-5-12-13-12z" fill="#e8e0c8"/><circle cx="19" cy="21" r="3.5" fill="#1a1020"/><circle cx="29" cy="21" r="3.5" fill="#1a1020"/><path d="M18 33v5M22 33v5M26 33v5M30 33v5" stroke="#1a1020" stroke-width="1.5"/>',
  lichguard: '<path d="M14 12l4 5 6-8 6 8 4-5v7H14z" fill="url(#agold)"/><path d="M24 15c-7 0-11 4-11 10 0 3 2 5 3 7v5h16v-5c1-2 3-4 3-7 0-6-4-10-11-10z" fill="#c8e8ff"/><circle cx="19.5" cy="25" r="3" fill="#5ad0ff"/><circle cx="28.5" cy="25" r="3" fill="#5ad0ff"/>',
  poison: '<path d="M20 6h8v8l8 14a8 8 0 0 1-7 12H19a8 8 0 0 1-7-12l8-14z" fill="#3a5a2a" stroke="#a6e05a" stroke-width="1.5"/><path d="M14 30h20a8 8 0 0 1-5 9H19a8 8 0 0 1-5-9z" fill="#a6e05a"/><circle cx="21" cy="24" r="2" fill="#c8ff8a"/>',
  plague: '<path d="M12 30a8 8 0 0 1 2-15 10 10 0 0 1 19-1 8 8 0 0 1 3 16z" fill="#5a7a2a" stroke="#a6e05a"/><circle cx="19" cy="22" r="2.5" fill="#1a2010"/><circle cx="28" cy="22" r="2.5" fill="#1a2010"/><g fill="#a6e05a"><circle cx="14" cy="38" r="2"/><circle cx="24" cy="41" r="2.5"/><circle cx="34" cy="37" r="2"/></g>',
  spirits: '<path d="M24 7c-8 0-12 6-12 13v20l4-3 4 3 4-3 4 3 4-3 4 3V20c0-7-4-13-12-13z" fill="#b8d0ff" opacity=".9"/><circle cx="20" cy="20" r="2.5" fill="#1a1030"/><circle cx="28" cy="20" r="2.5" fill="#1a1030"/><path d="M21 27q3 3 6 0" stroke="#1a1030" fill="none"/>',
  reaper: '<path d="M30 6L18 42" stroke="#7a5524" stroke-width="3" stroke-linecap="round"/><path d="M30 6c-12-2-22 4-24 14 6-6 14-8 23-6z" fill="#cfd8e0" stroke="#8a9aaa"/><circle cx="30" cy="6" r="2.5" fill="url(#agold)"/>',
  // passives
  might: '<path d="M14 34l10-24 10 24-10-6z" fill="#d84a3a" stroke="#ff9a7a"/><path d="M10 40h28" stroke="url(#agold)" stroke-width="3"/>',
  haste: '<path d="M14 7h20M14 41h20M16 7c0 10 8 12 8 17s-8 7-8 17M32 7c0 10-8 12-8 17s8 7 8 17" fill="none" stroke="url(#agold)" stroke-width="2.5"/><path d="M19 37h10l-5-6z" fill="#ffe08a"/>',
  area: '<circle cx="24" cy="24" r="6" fill="#bfe0ff"/><circle cx="24" cy="24" r="12" fill="none" stroke="#7ab0ff" stroke-width="2"/><circle cx="24" cy="24" r="18" fill="none" stroke="#5a80d0" stroke-width="1.5" stroke-dasharray="4 3"/>',
  multishot: '<g stroke="#e0d0b0" stroke-width="2.5" stroke-linecap="round"><path d="M10 38L24 12M24 38V10M38 38L24 12"/></g><g fill="#cfd8e0"><path d="M24 6l-4 7h8z"/><path d="M9 12l2 8 5-6z"/><path d="M39 12l-2 8-5-6z"/></g>',
  duration: '<circle cx="24" cy="25" r="15" fill="#1a1420" stroke="url(#agold)" stroke-width="2.5"/><path d="M24 15v10l7 5" stroke="#f3d58a" stroke-width="2.5" fill="none" stroke-linecap="round"/><path d="M20 6h8" stroke="url(#agold)" stroke-width="3"/>',
  armor: '<path d="M24 6l15 5v11c0 10-7 17-15 20C16 39 9 32 9 22V11z" fill="#5a6a7a" stroke="url(#agold)" stroke-width="2"/><path d="M24 12v26M14 20h20" stroke="#d9b25f" stroke-width="2"/>',
  vitality: '<path d="M24 40C10 30 7 23 7 17a8 8 0 0 1 17-3 8 8 0 0 1 17 3c0 6-3 13-17 23z" fill="#c8302a" stroke="#ff8a7a"/><path d="M15 17a4 4 0 0 1 5-3" stroke="#ffb0a0" stroke-width="2" fill="none"/>',
  regen: '<path d="M24 40C10 30 7 23 7 17a8 8 0 0 1 17-3 8 8 0 0 1 17 3c0 6-3 13-17 23z" fill="#3a8a4a" stroke="#8aff9a"/><path d="M24 16v14M17 23h14" stroke="#e0ffe0" stroke-width="3.5"/>',
  swift: '<path d="M16 34l6-18h8l-2 10 8 4v6H16z" fill="#8a6d33" stroke="url(#agold)"/><path d="M4 22h10M6 28h9M8 34h7" stroke="#f3d58a" stroke-width="2" stroke-linecap="round"/>',
  magnet: '<path d="M12 10v14a12 12 0 0 0 24 0V10h-7v14a5 5 0 0 1-10 0V10z" fill="#c83a3a" stroke="#ff8a7a"/><path d="M12 10h7v6h-7zM29 10h7v6h-7z" fill="#dfe6ee"/>',
  luck: '<g fill="#4aa04a" stroke="#8ae08a"><circle cx="18" cy="18" r="6"/><circle cx="30" cy="18" r="6"/><circle cx="18" cy="30" r="6"/><circle cx="30" cy="30" r="6"/></g><path d="M24 24l8 16" stroke="#3a6a2a" stroke-width="2.5"/>',
  crit: '<circle cx="24" cy="24" r="14" fill="none" stroke="#ff5a4a" stroke-width="2.5"/><circle cx="24" cy="24" r="5" fill="#ff5a4a"/><path d="M24 4v10M24 34v10M4 24h10M34 24h10" stroke="#f3d58a" stroke-width="2.5"/>',
  // heroes
  h_knight: '<path d="M12 22c0-9 5-14 12-14s12 5 12 14v14H12z" fill="#9aa8b8" stroke="url(#agold)" stroke-width="2"/><path d="M15 23h18v4H15z" fill="#1a1420"/><path d="M24 8v28" stroke="#d9b25f" stroke-width="2"/><path d="M24 4c3 0 6 2 7 5" stroke="#c83a3a" stroke-width="3" fill="none"/>',
  h_mage: '<path d="M24 4L12 30h24z" fill="#3a4a9a" stroke="#7aa8ff"/><path d="M8 30h32l-3 5H11z" fill="#2a3a7a" stroke="url(#agold)"/><circle cx="26" cy="18" r="2.5" fill="#ffe08a"/><path d="M19 36v6M29 36v6" stroke="#7aa8ff" stroke-width="2"/>',
  h_ranger: '<path d="M24 6c-9 0-14 8-14 18 0 6 2 10 4 14h20c2-4 4-8 4-14 0-10-5-18-14-18z" fill="#2a4a2a" stroke="#7ad08a"/><path d="M17 26c2-5 12-5 14 0-3 3-11 3-14 0z" fill="#0a0a0a"/><circle cx="20.5" cy="25.5" r="1.5" fill="#bfffbf"/><circle cx="27.5" cy="25.5" r="1.5" fill="#bfffbf"/>',
  h_necro: '<path d="M24 6c-9 0-14 6-14 14 0 5 3 9 6 11v8h16v-8c3-2 6-6 6-11 0-8-5-14-14-14z" fill="#e8e0c8" stroke="#b48aff"/><path d="M15 20l6 2-1 4-5-1zM33 20l-6 2 1 4 5-1z" fill="#6a2a9a"/><path d="M20 34h8" stroke="#1a1020" stroke-width="2"/><path d="M10 14c-4-2-5-6-3-9M38 14c4-2 5-6 3-9" stroke="#b48aff" stroke-width="2" fill="none"/>',
  h_berserker: '<path d="M14 18c0-7 4-11 10-11s10 4 10 11v12H14z" fill="#8a5a3a" stroke="url(#agold)"/><path d="M14 16C8 14 6 9 7 4c3 4 6 6 8 7zM34 16c6-2 8-7 7-12-3 4-6 6-8 7z" fill="#e8dcc0"/><path d="M17 22h14" stroke="#1a1010" stroke-width="3"/><path d="M14 30c3 8 17 8 20 0" fill="#a0522d"/>',
  // items
  i_w_blade: '<path d="M32 8l6 0 0 6-16 16-5-5z" fill="#cfe0ff" stroke="#7aa8ff"/><path d="M13 26l8 8-3 3-8-8z" fill="url(#agold)"/><path d="M28 14l4 4" stroke="#5aa8ff" stroke-width="2"/>',
  i_w_staff: '<path d="M14 42L30 14" stroke="#6a4a2a" stroke-width="3.5" stroke-linecap="round"/><circle cx="32" cy="12" r="6" fill="#8a5aff" stroke="#d8c0ff"/><path d="M26 10c2-4 8-5 11-1" stroke="url(#agold)" stroke-width="2" fill="none"/>',
  i_w_bow: '<path d="M14 6c18 4 22 26 4 36" fill="none" stroke="#7a5524" stroke-width="3.5"/><path d="M15 7L18 41" stroke="#e0d0b0" stroke-width="1.2"/><path d="M8 24h26" stroke="#e0d0b0" stroke-width="1.8"/><path d="M34 24l-6-3v6z" fill="#cfd8e0"/>',
  i_h_helm: '<path d="M11 26c0-10 6-16 13-16s13 6 13 16v10H11z" fill="#8a96a6" stroke="url(#agold)" stroke-width="2"/><path d="M15 25h18v3H15zM24 28v8" stroke="#1a1420" stroke-width="2.5"/>',
  i_h_hood: '<path d="M24 7c-10 0-15 9-15 20 0 6 1 10 3 14h24c2-4 3-8 3-14 0-11-5-20-15-20z" fill="#3a2a4a" stroke="#9a7ad0"/><path d="M16 28c3-6 13-6 16 0-4 4-12 4-16 0z" fill="#0a0810"/>',
  i_h_crown: '<path d="M8 34l2-20 8 9 6-12 6 12 8-9 2 20z" fill="#e8e0c8" stroke="url(#agold)" stroke-width="2"/><circle cx="24" cy="28" r="3" fill="#c83a3a"/><path d="M10 38h28" stroke="url(#agold)" stroke-width="3"/>',
  i_a_plate: '<path d="M10 12l8-4h12l8 4-2 10 2 18H10l2-18z" fill="#9aa8b8" stroke="url(#agold)" stroke-width="2"/><path d="M24 10v30M16 22h16" stroke="#d9b25f" stroke-width="2"/>',
  i_a_robe: '<path d="M16 8h16l6 32H10z" fill="#3a3a8a" stroke="#7aa8ff"/><path d="M24 8v32" stroke="url(#agold)" stroke-width="2"/><circle cx="24" cy="20" r="3" fill="#ffe08a"/>',
  i_a_leather: '<path d="M12 10l7-3h10l7 3-2 30H14z" fill="#7a5034" stroke="#c8905a"/><path d="M14 18h20M14 26h20M14 34h20" stroke="#4a2a1a" stroke-width="1.5"/>',
  i_r_ring: '<circle cx="24" cy="28" r="11" fill="none" stroke="url(#agold)" stroke-width="4"/><path d="M18 14l6-7 6 7-6 6z" fill="#c8202a" stroke="#ff8a8a"/>',
  i_r_band: '<circle cx="24" cy="26" r="12" fill="none" stroke="#dfe6ee" stroke-width="5"/><circle cx="24" cy="26" r="12" fill="none" stroke="#7aa8ff" stroke-width="1" stroke-dasharray="2 3"/><path d="M30 10a6 6 0 1 0 0 8 5 5 0 0 1 0-8z" fill="#cfe0ff"/>',
  i_r_signet: '<circle cx="24" cy="29" r="10" fill="none" stroke="url(#agold)" stroke-width="4"/><rect x="16" y="8" width="16" height="12" rx="3" fill="#1a1420" stroke="url(#agold)" stroke-width="2"/><path d="M21 14h6" stroke="#9a7ad0" stroke-width="2"/>',
  i_m_amulet: '<path d="M12 6c2 10 7 14 12 14s10-4 12-14" fill="none" stroke="url(#agold)" stroke-width="2"/><circle cx="24" cy="30" r="10" fill="#4a2a1a" stroke="url(#agold)" stroke-width="2.5"/><path d="M24 23c3 4 4 6 4 8a4 4 0 0 1-8 0c0-2 1-4 4-8z" fill="#ff8a3a"/>',
  i_m_charm: '<path d="M14 6l10 12 10-12" fill="none" stroke="#9aa8b8" stroke-width="2"/><path d="M24 18l9 10-9 14-9-14z" fill="#3a8aa8" stroke="#bfe8ff"/><path d="M24 22l4 6-4 7-4-7z" fill="#bfe8ff" opacity=".7"/>',
  i_m_relic: '<circle cx="24" cy="24" r="15" fill="#2a1a2a" stroke="url(#agold)" stroke-width="2.5"/><path d="M24 12v24M14 20l20 8M34 20l-20 8" stroke="#b48aff" stroke-width="2"/><circle cx="24" cy="24" r="4" fill="#ffe08a"/>',
  // misc / talents
  c_gold: '<circle cx="24" cy="24" r="14" fill="url(#agold)" stroke="#7a5524" stroke-width="2"/><circle cx="24" cy="24" r="9" fill="none" stroke="#7a5524" stroke-width="1.5"/><path d="M24 17v14M20 20h7M20 28h7" stroke="#7a5524" stroke-width="2"/>',
  c_heal: '<path d="M19 6h10v6l7 10v16a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4V22l7-10z" fill="#5a1a1a" stroke="#ff8a7a"/><path d="M14 26h20v12a3 3 0 0 1-3 3H17a3 3 0 0 1-3-3z" fill="#e0403a"/><path d="M24 28v10M19 33h10" stroke="#fff" stroke-width="2.5"/>',
  t_xp: '<path d="M24 6l12 12-12 24-12-24z" fill="#3a7aff" stroke="#bfe0ff"/><path d="M12 18h24M24 6l-5 12 5 24 5-24z" stroke="#bfe0ff" fill="none"/>',
  t_revive: '<path d="M24 42C24 30 10 26 10 14 16 18 20 18 24 6c4 12 8 12 14 8 0 12-14 16-14 28z" fill="#ff8a2a" stroke="#ffe08a"/><path d="M24 36c0-8-5-10-5-16 3 2 4 2 5-3 1 5 2 5 5 3 0 6-5 8-5 16z" fill="#ffe08a"/>',
  t_reroll: '<path d="M36 18a13 13 0 1 0 1 10" fill="none" stroke="url(#agold)" stroke-width="3.5" stroke-linecap="round"/><path d="M38 8v11H27z" fill="#f3d58a"/>',
  t_banish: '<circle cx="24" cy="24" r="14" fill="none" stroke="#c83a3a" stroke-width="3.5"/><path d="M14 14l20 20" stroke="#c83a3a" stroke-width="3.5"/>',
  t_startLv: '<path d="M24 6l14 16h-8v18H18V22h-8z" fill="url(#agold)" stroke="#7a5524"/>',
  shrine_power: '<path d="M14 40h20l-3-24h-14z" fill="#3a2a2a" stroke="#ff5a4a"/><path d="M24 6c4 5 5 7 5 9a5 5 0 0 1-10 0c0-2 1-4 5-9z" fill="#ff5a4a"/>',
  skip: '<path d="M10 12l14 12-14 12zM24 12l14 12-14 12z" fill="url(#agold)"/>'
};
const ALIAS = { t_hp: 'vitality', t_dmg: 'might', t_cd: 'haste', t_speed: 'swift', t_armor: 'armor', t_regen: 'regen', t_pickup: 'magnet', t_gold: 'c_gold', t_luck: 'luck' };
const RCOL = { common: '#c8c8c8', magic: '#5aa8ff', rare: '#ffd84a', legendary: '#ff9a2a' };
function iconSvg(id, opt) {
  let key = String(id || '').replace(/^w_/, '').replace(/^p_/, '');
  if (ALIAS[id]) key = ALIAS[id];
  let g = G[key] || G[id];
  if (!g && /^e_/.test(id)) g = '<circle cx="24" cy="24" r="12" fill="#5a4a5a"/>';
  if (!g) g = '<path d="M24 10l12 14-12 14-12-14z" fill="url(#agold)"/>';
  const rc = opt && opt.rarity ? RCOL[opt.rarity] : null;
  return '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="46" height="46" rx="8" fill="url(#abg)" stroke="' + (rc || '#8a6d33') + '" stroke-width="' + (rc ? 2.2 : 1.5) + '"/>' +
    '<path d="M4 9V4h5M39 4h5v5M44 39v5h-5M9 44H4v-5" fill="none" stroke="' + (rc || '#d9b25f') + '" stroke-width="1.5" opacity=".9"/>' + g + '</svg>';
}
function itemIcon(item) { return iconSvg(item.iconId, { rarity: item.rarity }); }

/* =====================================================================
 * Audio
 * ===================================================================== */
const sfxThrottle = {};
function sfx(name) {
  if (!audioUnlocked) return;
  if (!settings.sfx || KG.isMuted()) return;
  const now = performance.now();
  const gap = { hit: 70, kill: 55, gem: 45, shoot: 90, slash: 120 }[name] || 0;
  if (gap && now - (sfxThrottle[name] || 0) < gap) return;
  sfxThrottle[name] = now;
  const N = KG.note;
  switch (name) {
    case 'hit': N(140 + Math.random() * 40, 0.06, 'square', 0.03, 0, 70); break;
    case 'kill': N(220 + Math.random() * 80, 0.08, 'triangle', 0.035, 0, 90); break;
    case 'gem': N(1200 + Math.random() * 400, 0.05, 'sine', 0.04); break;
    case 'gold': KG.sound('coin'); break;
    case 'slash': N(600, 0.09, 'sawtooth', 0.025, 0, 180); break;
    case 'shoot': N(520, 0.06, 'triangle', 0.025, 0, 300); break;
    case 'boom': N(90, 0.3, 'sawtooth', 0.08, 0, 35); KG.sound('hit'); break;
    case 'zap': N(1400, 0.08, 'square', 0.03, 0, 300); N(900, 0.1, 'square', 0.025, 0.04, 200); break;
    case 'frost': N(1800, 0.25, 'sine', 0.04, 0, 600); break;
    case 'levelup': [392, 523, 659, 784].forEach((f, i) => N(f, 0.16, 'triangle', 0.08, i * 0.07)); break;
    case 'pick': N(700, 0.07, 'triangle', 0.1); break;
    case 'hurt': N(110, 0.18, 'sawtooth', 0.09, 0, 60); break;
    case 'dash': KG.sound('whoosh'); break;
    case 'chest': [523, 659, 784, 1047, 1319].forEach((f, i) => N(f, 0.22, 'triangle', 0.08, i * 0.09)); break;
    case 'evolve': [262, 330, 392, 523, 659, 784, 1047].forEach((f, i) => N(f, 0.3, 'sawtooth', 0.04, i * 0.08)); break;
    case 'boss': N(55, 1.2, 'sawtooth', 0.12, 0, 40); N(82, 1.2, 'square', 0.05, 0.1, 60); break;
    case 'elite': N(160, 0.5, 'sawtooth', 0.06, 0, 90); break;
    case 'shrine': [660, 880, 1100].forEach((f, i) => N(f, 0.3, 'sine', 0.08, i * 0.1)); break;
    case 'heal': N(660, 0.15, 'sine', 0.07, 0, 990); break;
    case 'death': [220, 185, 147, 110].forEach((f, i) => N(f, 0.5, 'triangle', 0.1, i * 0.22)); break;
    case 'win': KG.sound('win'); break;
    case 'click': N(500, 0.05, 'triangle', 0.08); break;
    case 'buy': KG.sound('coin'); break;
    case 'error': N(160, 0.15, 'square', 0.06); break;
  }
}
// background music: dark ambient + war drums, scheduled one bar ahead
const music = { on: false, nextBar: 0, bar: 0, timer: 0, intense: 0 };
const ROOTS = [73.42, 73.42, 87.31, 65.41, 73.42, 98.0, 87.31, 82.41]; // D2 D2 F2 C2 D2 G2 F2 E2
function scheduleBar() {
  const now = performance.now() / 1000;
  const bpm = music.intense > 1 ? 112 : music.intense > 0 ? 96 : 76;
  const beat = 60 / bpm, step = beat / 2;
  const base = Math.max(0, music.nextBar - now);
  const root = ROOTS[music.bar % ROOTS.length];
  const v = 1;
  const N = KG.note;
  if (music.intense >= 0) {
    // pad (two long notes)
    N(root * 2, beat * 4, 'triangle', 0.022 * v, base);
    N(root * 3, beat * 4, 'sine', 0.014 * v, base + 0.05);
    N(root * 2.4, beat * 4, 'sine', 0.01 * v, base + 0.1);
  }
  if (music.intense > 0) {
    // drums
    const kick = [0, 3, 4, 6].concat(music.intense > 1 ? [7] : []);
    for (const k of kick) N(70, 0.22, 'sine', 0.13 * v, base + k * step, 38);
    for (const k of [2, 6]) N(180, 0.12, 'triangle', 0.05 * v, base + k * step, 90);
    // bass
    for (let s = 0; s < 8; s += 2) N(root, step * 1.6, 'sawtooth', 0.025 * v, base + s * step);
    if (music.bar % 2 === 1) N(root * 4 * (music.bar % 4 === 1 ? 1.19 : 1.33), beat * 1.5, 'square', 0.012 * v, base + 4 * step);
  } else {
    // menu: sparse bell
    N(root * 6, beat * 2, 'sine', 0.018, base + beat);
  }
  music.bar++;
  music.nextBar = Math.max(music.nextBar, now) + beat * 4;
}
let audioUnlocked = false;
['pointerdown', 'keydown'].forEach(t => addEventListener(t, () => { audioUnlocked = true; }, { once: true, capture: true }));
function musicTick() {
  if (!audioUnlocked) return;
  if (!music.on || !settings.music || KG.isMuted() || document.hidden) { music.nextBar = 0; return; }
  const now = performance.now() / 1000;
  if (music.nextBar - now < 0.35) scheduleBar();
}
setInterval(musicTick, 120);

/* =====================================================================
 * 2D fallback view (same API as view3d.js)
 * ===================================================================== */
function createView2D({ canvas }) {
  const ctx = canvas.getContext('2d');
  let W = 1, H = 1, dpr = 1, scale = 30, camX = 0, camZ = 0, stage = 'graveyard', hero = 'knight', mode = 'menu', q = 2, t = 0;
  let shakeA = 0, sx = 0, sz = 0, flashA = 0, flashC = '#fff', focX = 0.5, focY = 0.5;
  const fx = [];
  const ST = DATA.stages;
  function addFx(o) { if (fx.length > 120) fx.shift(); fx.push(o); }
  function toS(x, z) { return [(x - camX) * scale + W / 2 + sx, (z - camZ) * scale + H / 2 + sz]; }
  const OBC = { tomb: '#5a6a6a', deadtree: '#3a3028', lantern: '#c8a040', pillar: '#6a6a5a', rubble: '#5a5248', brazier: '#c86a2a', spike: '#5a3a30',
    basalt: '#3a2a28', lavavent: '#ff6a1a', icecrystal: '#8ad0f0', statue: '#a8b8c8', pine: '#2a4a3a' };
  const KC = { fire: '#ff7a2a', frost: '#9ae0ff', light: '#ffe04a', poison: '#8ae04a', holy: '#fff0a0', dark: '#b48aff', phys: '#ffffff', steel: '#e0e8f0', meteor: '#ff5a1a', bone: '#e8e0c8' };
  return {
    kind: '2d',
    autoQuality: false,
    resize(w, h, d) { W = w; H = h; dpr = d; canvas.width = Math.round(w * d); canvas.height = Math.round(h * d); scale = clamp(Math.min(w, h) / 19, 18, 44); },
    setStage(s) { stage = s; }, setHero(h) { hero = h; }, setMode(m) { mode = m; },
    setMenuFocus(fx, fy) { focX = clamp(+fx || 0.5, 0.05, 0.95); focY = clamp(+fy || 0.5, 0.05, 0.95); },
    getViewExtents() { return { halfW: W / 2 / scale, halfH: H / 2 / scale }; },
    worldToScreen(x, y, z) { return { x: (x - camX) * scale + W / 2 + sx, y: (z - camZ) * scale + H / 2 + sz - (y || 0) * scale * 0.6 }; },
    setQuality(v) { q = v; }, getQuality() { return q; },
    shake(a) { shakeA = Math.min(1.2, shakeA + a); }, flash(c, a) { flashC = c || '#fff'; flashA = Math.min(0.6, a || 0.3); },
    dispose() {},
    renderMenu(dt) {
      t += dt;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const st = ST[stage] || ST.graveyard;
      const g = ctx.createRadialGradient(W / 2, H * 0.62, 10, W / 2, H * 0.6, Math.max(W, H) * 0.7);
      g.addColorStop(0, '#3a2418'); g.addColorStop(0.35, st.colors.ground); g.addColorStop(1, '#050408');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      // rune circle
      const mcx = W * focX, mcy = H * focY + 50;
      ctx.save(); ctx.translate(mcx, mcy); ctx.scale(1, 0.4); ctx.rotate(t * 0.15);
      ctx.strokeStyle = 'rgba(217,178,95,.35)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, 120, 0, TAU); ctx.stroke(); ctx.beginPath(); ctx.arc(0, 0, 95, 0, TAU); ctx.stroke();
      for (let i = 0; i < 8; i++) { ctx.rotate(TAU / 8); ctx.beginPath(); ctx.moveTo(95, 0); ctx.lineTo(120, 10); ctx.stroke(); }
      ctx.restore();
      // fire
      const fx0 = mcx - 30, fy0 = mcy;
      for (let i = 0; i < 6; i++) {
        const a = Math.sin(t * 6 + i) * 4;
        ctx.fillStyle = i % 2 ? 'rgba(255,140,40,.55)' : 'rgba(255,220,120,.5)';
        ctx.beginPath(); ctx.ellipse(fx0 + a + (i - 3) * 4, fy0 - 10 - i * 3, 9 - i, 18 - i * 2, 0, 0, TAU); ctx.fill();
      }
      // hero silhouette
      const hc = (DATA.heroes[hero] || DATA.heroes.knight).color;
      ctx.fillStyle = '#0a0810'; ctx.strokeStyle = hc; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(fx0 + 60, fy0 - 26, 14, 26, 0, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(fx0 + 60, fy0 - 58, 10, 0, TAU); ctx.fill(); ctx.stroke();
      // embers
      for (let i = 0; i < 30; i++) {
        const p = (t * 0.2 + i * 0.137) % 1;
        ctx.fillStyle = 'rgba(255,170,80,' + (1 - p).toFixed(2) + ')';
        ctx.fillRect(fx0 + Math.sin(i * 12.3 + t) * 40 * p + (i % 5 - 2) * 8, fy0 - p * 220, 2, 2);
      }
    },
    render(s, events, dt) {
      t += dt;
      const p = s.player;
      camX += (p.x - camX) * Math.min(1, dt * 10); camZ += (p.z - camZ) * Math.min(1, dt * 10);
      if (Math.abs(p.x - camX) > 8 || Math.abs(p.z - camZ) > 8) { camX = p.x; camZ = p.z; }
      shakeA = Math.max(0, shakeA - dt * 2.5);
      sx = (Math.random() - 0.5) * shakeA * 14; sz = (Math.random() - 0.5) * shakeA * 14;
      for (const e of events) {
        if (e.type === 'slash' || e.type === 'explode' || e.type === 'nova' || e.type === 'strike' || e.type === 'chain' || e.type === 'dash')
          addFx({ e, t: 0, life: e.type === 'chain' ? 0.18 : e.type === 'slash' ? 0.22 : 0.35 });
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const st = ST[s.stage] || ST.graveyard;
      ctx.fillStyle = st.colors.ground; ctx.fillRect(0, 0, W, H);
      // floor tiles
      const ext = this.getViewExtents();
      ctx.strokeStyle = 'rgba(255,255,255,.05)'; ctx.lineWidth = 1;
      const gs = 3, x0 = Math.floor((camX - ext.halfW) / gs) * gs, z0 = Math.floor((camZ - ext.halfH) / gs) * gs;
      ctx.beginPath();
      for (let x = x0; x < camX + ext.halfW + gs; x += gs) { const [a] = toS(x, 0); ctx.moveTo(a, 0); ctx.lineTo(a, H); }
      for (let z = z0; z < camZ + ext.halfH + gs; z += gs) { const [, b] = toS(0, z); ctx.moveTo(0, b); ctx.lineTo(W, b); }
      ctx.stroke();
      // zones
      for (const zn of s.zones) {
        const [a, b] = toS(zn.x, zn.z);
        const life = zn.life > 1e6 ? 0.5 : zn.age / zn.life;
        if (zn.kind === 'telegraph_line') {
          ctx.save(); ctx.translate(a, b); ctx.rotate(-zn.angle + Math.PI / 2);
          ctx.fillStyle = 'rgba(255,40,30,' + (0.15 + 0.25 * life) + ')';
          ctx.fillRect(0, -zn.width / 2 * scale, zn.len * scale, zn.width * scale);
          ctx.fillStyle = 'rgba(255,80,60,.5)'; ctx.fillRect(0, -zn.width / 2 * scale, zn.len * scale * life, zn.width * scale);
          ctx.restore(); continue;
        }
        let col = 'rgba(255,40,30,.25)';
        switch (zn.kind) {
          case 'poison': case 'e_poison': col = 'rgba(120,220,60,.25)'; break; case 'plague': col = 'rgba(100,160,40,.3)'; break;
          case 'fire': case 'e_fire': col = 'rgba(255,110,30,.3)'; break; case 'frost': case 'blizzard': col = 'rgba(150,210,255,.2)'; break;
          case 'arrowrain': col = 'rgba(230,220,200,.18)'; break; case 'lightning_mark': col = 'rgba(255,230,80,.3)'; break;
          case 'meteor_mark': col = 'rgba(255,90,30,.3)'; break; case 'web': col = 'rgba(230,230,230,.22)'; break;
        }
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(a, b, zn.r * scale, 0, TAU); ctx.fill();
        if (zn.kind === 'telegraph_circle' || zn.kind.endsWith('_mark')) {
          ctx.strokeStyle = zn.kind === 'telegraph_circle' ? 'rgba(255,60,40,.9)' : 'rgba(255,220,120,.8)'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(a, b, zn.r * scale, 0, TAU); ctx.stroke();
          ctx.beginPath(); ctx.arc(a, b, zn.r * scale * life, 0, TAU); ctx.stroke();
        }
      }
      // obstacles
      const obs = obstaclesNear(s.stage, camX, camZ, Math.max(ext.halfW, ext.halfH) + 2);
      for (const o of obs) {
        const [a, b] = toS(o.x, o.z);
        ctx.fillStyle = OBC[o.kind] || '#555';
        ctx.beginPath(); ctx.arc(a, b, o.r * scale, 0, TAU); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 2; ctx.stroke();
      }
      // shrines
      for (const sh of s.shrines) {
        const [a, b] = toS(sh.x, sh.z);
        const c = (DATA.shrines[sh.kind] || {}).color || '#fff';
        ctx.strokeStyle = sh.used ? 'rgba(255,255,255,.2)' : c; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(a, b, 1.8 * scale, 0, TAU); ctx.stroke();
        ctx.fillStyle = c; ctx.fillRect(a - 6, b - 16, 12, 22);
        if (sh.progress > 0) { ctx.beginPath(); ctx.arc(a, b, 1.8 * scale + 4, -Math.PI / 2, -Math.PI / 2 + TAU * sh.progress); ctx.stroke(); }
      }
      // pickups
      for (const k of s.pickups) {
        const [a, b] = toS(k.x, k.z);
        if (a < -20 || b < -20 || a > W + 20 || b > H + 20) continue;
        let c = '#4a8aff', r = 4;
        switch (k.kind) {
          case 'xp_m': c = '#4ae07a'; r = 5; break; case 'xp_l': c = '#ff4a5a'; r = 6; break; case 'gold': c = '#ffd84a'; r = 4; break;
          case 'heart': c = '#ff3a5a'; r = 7; break; case 'magnet': c = '#c83a3a'; r = 7; break; case 'bomb': c = '#222'; r = 7; break; case 'chest': c = '#d9b25f'; r = 11; break;
        }
        ctx.fillStyle = c;
        if (k.kind === 'chest') { ctx.fillRect(a - r, b - r * 0.7, r * 2, r * 1.4); ctx.strokeStyle = '#fff3b0'; ctx.strokeRect(a - r, b - r * 0.7, r * 2, r * 1.4); }
        else { ctx.beginPath(); ctx.moveTo(a, b - r); ctx.lineTo(a + r * 0.75, b); ctx.lineTo(a, b + r); ctx.lineTo(a - r * 0.75, b); ctx.fill(); }
      }
      // allies
      for (const al of s.allies) {
        const [a, b] = toS(al.x, al.z);
        ctx.fillStyle = al.type === 'lich' ? '#8ad8ff' : '#e8e0c8';
        ctx.beginPath(); ctx.arc(a, b, 0.4 * scale, 0, TAU); ctx.fill();
        ctx.strokeStyle = '#6a4aaa'; ctx.lineWidth = 2; ctx.stroke();
      }
      // enemies
      for (const e of s.enemies) {
        const [a, b] = toS(e.x, e.z);
        const r = e.r * scale;
        if (a < -r - 10 || b < -r - 10 || a > W + r + 10 || b > H + r + 10) continue;
        const D = DATA.enemies[e.type];
        let col = D ? D.color : '#a0a';
        if (e.flash > 0.5) col = '#ffffff';
        else if (e.frozen > 0) col = '#bfe8ff';
        ctx.globalAlpha = e.anim === 'spawn' ? Math.min(1, e.animT / 0.45) : e.type === 'wraith' ? 0.7 : 1;
        if (e.elite || e.boss) {
          ctx.fillStyle = e.elite ? ((DATA.affixes[e.affix] || {}).color || '#fff') : '#ff3a2a';
          ctx.globalAlpha *= 0.35; ctx.beginPath(); ctx.arc(a, b, r + 6, 0, TAU); ctx.fill(); ctx.globalAlpha = 1;
        }
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(a, b, r, 0, TAU); ctx.fill();
        ctx.strokeStyle = e.anim === 'windup' || e.anim === 'charge' ? '#ff3a2a' : 'rgba(0,0,0,.6)'; ctx.lineWidth = e.anim === 'windup' ? 3 : 1.5; ctx.stroke();
        ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(a + Math.sin(e.rot) * r, b + Math.cos(e.rot) * r); ctx.stroke();
        if (e.burning > 0 || e.poisoned > 0) { ctx.fillStyle = e.burning > 0 ? '#ff7a2a' : '#8ae04a'; ctx.fillRect(a - 2, b - r - 6, 4, 4); }
        if (e.boss) { ctx.fillStyle = '#ffd84a'; ctx.beginPath(); ctx.moveTo(a - 12, b - r); ctx.lineTo(a - 8, b - r - 12); ctx.lineTo(a, b - r - 4); ctx.lineTo(a + 8, b - r - 12); ctx.lineTo(a + 12, b - r); ctx.fill(); }
        ctx.globalAlpha = 1;
      }
      // player aura
      if (p.auraR > 0) {
        const [a, b] = toS(p.x, p.z);
        ctx.fillStyle = p.auraKind === 'fire' ? 'rgba(255,90,30,.15)' : 'rgba(255,240,160,.13)';
        ctx.beginPath(); ctx.arc(a, b, p.auraR * scale, 0, TAU); ctx.fill();
      }
      // player
      {
        const [a, b] = toS(p.x, p.z);
        const hc = (DATA.heroes[p.hero] || DATA.heroes.knight).color;
        ctx.globalAlpha = p.invuln > 0 && Math.floor(t * 20) % 2 ? 0.5 : 1;
        ctx.fillStyle = p.hurt > 0.5 ? '#ff6a5a' : hc;
        ctx.beginPath(); ctx.arc(a, b, 0.45 * scale, 0, TAU); ctx.fill();
        ctx.strokeStyle = '#fff3b0'; ctx.lineWidth = 2; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(a + Math.sin(p.rot) * 0.8 * scale, b + Math.cos(p.rot) * 0.8 * scale); ctx.stroke();
        if (p.shield > 0) { ctx.strokeStyle = 'rgba(190,230,255,.8)'; ctx.beginPath(); ctx.arc(a, b, 0.62 * scale, 0, TAU); ctx.stroke(); }
        ctx.globalAlpha = 1;
      }
      // projectiles
      for (const pr of s.projectiles) {
        const [a, b] = toS(pr.x, pr.z);
        if (a < -20 || b < -20 || a > W + 20 || b > H + 20) continue;
        let c = '#fff';
        switch (pr.kind) {
          case 'firebolt': case 'e_fireball': c = '#ff7a2a'; break; case 'arrow': case 'dagger': c = '#e8e8e8'; break;
          case 'axe': c = '#c8d0d8'; break; case 'bloodaxe': c = '#e03a3a'; break; case 'orb': c = '#bfe0ff'; break; case 'soulorb': c = '#d8c0ff'; break;
          case 'flask': c = '#8ae04a'; break; case 'spirit': c = '#b8d0ff'; break; case 'reaper': c = '#9aa8b8'; break;
          case 'e_bolt': c = '#b060ff'; break; case 'e_web': c = '#f0f0f0'; break; case 'e_bone': c = '#e8e0c8'; break; case 'e_frost': c = '#8ad8ff'; break;
        }
        ctx.fillStyle = c;
        const yb = (pr.y - 1) * scale * 0.6;
        if (pr.kind === 'arrow' || pr.kind === 'dagger' || pr.kind === 'e_frost' || pr.kind === 'e_bone') {
          ctx.strokeStyle = c; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(a - Math.sin(pr.rot) * 14, b - Math.cos(pr.rot) * 14); ctx.stroke();
        } else { ctx.beginPath(); ctx.arc(a, b - yb, Math.max(3, pr.r * scale), 0, TAU); ctx.fill(); }
      }
      // fx
      for (let i = fx.length - 1; i >= 0; i--) {
        const f = fx[i]; f.t += dt;
        if (f.t >= f.life) { fx.splice(i, 1); continue; }
        const e = f.e, k = f.t / f.life, col = KC[e.kind] || '#fff';
        ctx.globalAlpha = 1 - k; ctx.strokeStyle = col; ctx.fillStyle = col;
        if (e.type === 'slash') {
          const [a, b] = toS(e.x, e.z);
          ctx.lineWidth = 6 * (1 - k) + 1;
          const start = Math.PI / 2 - e.rot - e.arc / 2;
          ctx.beginPath(); ctx.arc(a, b, e.range * scale * (0.7 + 0.3 * k), start, start + e.arc); ctx.stroke();
        } else if (e.type === 'chain') {
          ctx.lineWidth = 3; ctx.beginPath();
          e.points.forEach((pt, j) => { const [a, b] = toS(pt.x, pt.z); if (j) ctx.lineTo(a + (Math.random() - 0.5) * 6, b + (Math.random() - 0.5) * 6); else ctx.moveTo(a, b); });
          ctx.stroke();
        } else if (e.type === 'dash') {
          const [a, b] = toS(e.x, e.z); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(a, b, 10 + k * 20, 0, TAU); ctx.stroke();
        } else {
          const [a, b] = toS(e.x, e.z);
          ctx.lineWidth = 3;
          ctx.globalAlpha = (1 - k) * 0.5; ctx.beginPath(); ctx.arc(a, b, e.r * scale * (0.5 + 0.5 * k), 0, TAU); ctx.fill();
          ctx.globalAlpha = 1 - k; ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      // vignette + flash
      if (p.hp / p.maxHp < 0.3) { ctx.fillStyle = 'rgba(160,0,0,' + (0.12 + 0.08 * Math.sin(t * 6)) + ')'; ctx.fillRect(0, 0, W, H); }
      if (flashA > 0) { ctx.globalAlpha = flashA; ctx.fillStyle = flashC; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; flashA = Math.max(0, flashA - dt * 2); }
    }
  };
}

/* =====================================================================
 * View setup
 * ===================================================================== */
const glCv = $('#gl'), c2d = $('#c2d'), fxCv = $('#fx');
const fctx = fxCv.getContext('2d');
let view = null, viewKind = '2d', viewError = '';
async function initView() {
  const forced = new URLSearchParams(location.search).get('view');
  if (forced !== '2d') {
    try {
      const mod = await import('./view3d.js').catch(e => { viewError = 'import: ' + (e && e.message); return null; });
      if (mod && mod.createView) {
        view = mod.createView({ canvas: glCv, lowEnd: !!KG.lowEnd });
        viewKind = '3d';
      }
    } catch (e) { view = null; viewError = 'create: ' + (e && e.message); console.warn('view3d failed, using 2D view', e); }
  }
  if (!view) {
    glCv.style.display = 'none'; c2d.style.display = 'block';
    view = createView2D({ canvas: c2d });
    viewKind = '2d';
  }
  applyQuality();
}
function applyQuality() {
  if (!view) return;
  if ('showDamageNumbers' in view || viewKind === '3d') view.showDamageNumbers = !!settings.dmgNumbers;
  if ('shakeScale' in view || viewKind === '3d') view.shakeScale = settings.shake ? 1 : 0;
  if (settings.quality === 'auto') { view.autoQuality = true; }
  else { view.autoQuality = false; try { view.setQuality(+settings.quality); } catch (e) { /* ignore */ } }
}
let W = 1, H = 1, DPR = 1;
function layout() {
  const r = (viewKind === '3d' ? glCv : c2d).getBoundingClientRect();
  W = Math.max(1, Math.round(r.width || innerWidth)); H = Math.max(1, Math.round(r.height || innerHeight)); DPR = window.devicePixelRatio || 1;
  fxCv.width = Math.round(W * DPR); fxCv.height = Math.round(H * DPR);
  if (view) { try { view.resize(W, H, DPR); } catch (e) { console.warn(e); } }
  if (typeof applyMenuFocus === 'function' && screen !== 'game') applyMenuFocus();
  document.body.classList.toggle('nodash', !isTouch && !touchUsed);
}
addEventListener('resize', layout);
if (window.visualViewport) visualViewport.addEventListener('resize', layout);
addEventListener('orientationchange', () => setTimeout(layout, 120));

/* =====================================================================
 * Input
 * ===================================================================== */
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
let touchUsed = false;
const keys = {};
const inp = { mx: 0, mz: 0, dash: false };
const stick = { id: null, ox: 0, oy: 0, x: 0, y: 0, active: false };
const stickEl = $('#stick'), knobEl = $('#knob');
const touchEl = $('#touch');
touchEl.addEventListener('pointerdown', e => {
  if (screen !== 'game' || !game || game.state.phase !== 'play') return;
  if (e.pointerType === 'touch') { touchUsed = true; document.body.classList.remove('nodash'); }
  if (settings.stick === 'left' && e.clientX > W * 0.6 && e.pointerType === 'touch') { inp.dash = true; return; }
  if (stick.id !== null) return;
  stick.id = e.pointerId; stick.ox = e.clientX; stick.oy = e.clientY; stick.x = 0; stick.y = 0; stick.active = true;
  stickEl.style.display = 'block'; stickEl.style.left = e.clientX + 'px'; stickEl.style.top = e.clientY + 'px';
  knobEl.style.transform = 'translate(0px,0px)';
  try { touchEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  e.preventDefault();
});
touchEl.addEventListener('pointermove', e => {
  if (e.pointerId !== stick.id) return;
  let dx = e.clientX - stick.ox, dy = e.clientY - stick.oy;
  const R = 50, d = Math.hypot(dx, dy);
  if (d > R) {
    // floating: drag the base along
    const k = (d - R) / d; stick.ox += dx * k; stick.oy += dy * k; dx -= dx * k; dy -= dy * k;
    stickEl.style.left = stick.ox + 'px'; stickEl.style.top = stick.oy + 'px';
  }
  stick.x = dx / R; stick.y = dy / R;
  knobEl.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px)';
  e.preventDefault();
});
function endStick(e) {
  if (e.pointerId !== stick.id) return;
  stick.id = null; stick.active = false; stick.x = stick.y = 0; stickEl.style.display = 'none';
}
touchEl.addEventListener('pointerup', endStick);
touchEl.addEventListener('pointercancel', endStick);
$('#dashbtn').addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); inp.dash = true; if (e.pointerType === 'touch') touchUsed = true; });
$('#pausebtn').addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); togglePause(); });
addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  keys[k] = true;
  if (screen === 'game') {
    if (k === ' ' || k === 'shift') { inp.dash = true; e.preventDefault(); }
    if (k === 'p' || k === 'escape') { togglePause(); e.preventDefault(); }
    if (game && (game.state.phase === 'levelup') && /^[1-4]$/.test(k)) { const b = document.querySelectorAll('.card')[+k - 1]; if (b) b.click(); }
    if (game && game.state.phase === 'chest' && (k === 'enter' || k === ' ')) { const b = $('#chestok'); if (b) b.click(); }
    if (k.startsWith('arrow')) e.preventDefault();
  }
});
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
let padDashPrev = false, padPausePrev = false;
function readInput() {
  let mx = 0, mz = 0;
  if (keys.a || keys.arrowleft) mx -= 1; if (keys.d || keys.arrowright) mx += 1;
  if (keys.w || keys.arrowup) mz -= 1; if (keys.s || keys.arrowdown) mz += 1;
  if (stick.active) { mx += stick.x; mz += stick.y; }
  try {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) {
      if (!gp) continue;
      const ax = gp.axes[0] || 0, az = gp.axes[1] || 0;
      if (Math.hypot(ax, az) > 0.2) { mx += ax; mz += az; }
      const dsh = !!(gp.buttons[0] && gp.buttons[0].pressed) || !!(gp.buttons[5] && gp.buttons[5].pressed);
      if (dsh && !padDashPrev) inp.dash = true; padDashPrev = dsh;
      const pz = !!(gp.buttons[9] && gp.buttons[9].pressed);
      if (pz && !padPausePrev) togglePause(); padPausePrev = pz;
      break;
    }
  } catch (e) { /* ignore */ }
  const l = Math.hypot(mx, mz);
  if (l > 1) { mx /= l; mz /= l; }
  inp.mx = mx; inp.mz = mz;
}

/* =====================================================================
 * Game control
 * ===================================================================== */
let game = null, screen = 'title', paused = false, botOn = false, runOpts = null, prevPhase = '', phaseShownAt = 0;
let acc = 0;
const STEP = 1 / 60;
function startRun(opts) {
  opts = Object.assign({}, save.last, opts || {});
  if (!DATA.heroes[opts.hero]) opts.hero = 'knight';
  if (!DATA.stages[opts.stage]) opts.stage = 'graveyard';
  if (!DATA.difficulties[opts.difficulty]) opts.difficulty = 'normal';
  runOpts = opts;
  save.last = { hero: opts.hero, stage: opts.stage, difficulty: opts.difficulty }; persist();
  const seed = opts.seed != null ? opts.seed : (Math.random() * 2 ** 31) | 0;
  game = createGame({ stage: opts.stage, hero: opts.hero, difficulty: opts.difficulty, seed, meta: metaForRun() });
  view.setStage(opts.stage); view.setHero(opts.hero); view.setMode('game');
  const ex = view.getViewExtents(); game.setViewExtents(ex.halfW, ex.halfH);
  screen = 'game'; paused = false; acc = 0; prevPhase = ''; buildSig = ''; dmgTexts.length = 0;
  closeMenu();
  $('#hud').classList.add('on');
  music.on = true; music.intense = 1; music.nextBar = 0;
  showHint(isTouch ? '在畫面任意處拖曳移動，右下角衝刺' : 'WASD／方向鍵移動 · 空白鍵衝刺 · P 暫停');
  layout();
}
function showHint(t) { const h = $('#hint'); h.textContent = t; h.style.opacity = 1; clearTimeout(showHint.t); showHint.t = setTimeout(() => { h.style.opacity = 0; }, 4200); }
function togglePause() {
  if (screen !== 'game' || !game) return;
  if (game.state.phase !== 'play') return;
  paused = !paused;
  sfx('click');
  if (paused) showPause(); else closeMenu();
}
document.addEventListener('visibilitychange', () => { if (document.hidden && screen === 'game' && game && game.state.phase === 'play' && !paused) { paused = true; showPause(); } });

/* =====================================================================
 * Event handling (sfx, shake, floating text)
 * ===================================================================== */
const dmgTexts = [];
function addText(x, z, text, color, size, life) {
  if (viewKind === '3d') return; // the 3D view draws numbers/texts itself
  if (dmgTexts.length > 60) dmgTexts.shift();
  dmgTexts.push({ x, z, text, color, size: size || 14, t: 0, life: life || 0.75, ox: (Math.random() - 0.5) * 0.6 });
}
const KCOL = { fire: '#ffa060', frost: '#a8e8ff', light: '#fff07a', poison: '#a6f06a', holy: '#fff3b0', dark: '#d0a8ff', phys: '#ffffff' };
function handleEvents(evs) {
  let shake = 0;
  for (const e of evs) {
    switch (e.type) {
      case 'hit':
        if (e.target === 'p') break;
        sfx('hit');
        if (settings.dmgNumbers && (e.crit || dmgTexts.length < 34)) addText(e.x, e.z, String(e.dmg), e.crit ? '#ffd84a' : KCOL[e.kind] || '#fff', e.crit ? 19 : 13, e.crit ? 0.9 : 0.6);
        break;
      case 'kill': sfx('kill'); if (e.boss) { shake += 1; sfx('boom'); } else if (e.elite) shake += 0.3; break;
      case 'slash': sfx('slash'); break;
      case 'cast': if (e.weapon === 'firebolt' || e.weapon === 'arrows' || e.weapon === 'spirits') sfx('shoot'); break;
      case 'explode': sfx('boom'); shake += e.r > 4 ? 0.25 : 0.04; break;
      case 'strike': sfx(e.kind === 'light' ? 'zap' : 'boom'); shake += 0.1; break;
      case 'chain': sfx('zap'); break;
      case 'nova': sfx('frost'); break;
      case 'pickup': if (e.kind.startsWith('xp')) sfx('gem'); else if (e.kind === 'gold') sfx('gold'); else if (e.kind === 'chest') sfx('chest'); else sfx('pick'); break;
      case 'levelup': sfx('levelup'); break;
      case 'hurt': sfx('hurt'); shake += 0.2; KG.vibrate(25); if (viewKind !== '3d' && view.flash) view.flash('#ff2020', 0.18); break;
      case 'dash': sfx('dash'); break;
      case 'evolve': sfx('evolve'); banner(DATA.weapons[e.weapon].name + ' 覺醒！'); if (viewKind !== '3d' && view.flash) view.flash('#ffd890', 0.35); break;
      case 'spawn': if (DATA.enemies[e.enemy] && DATA.enemies[e.enemy].boss) { sfx('boss'); shake += 0.8; banner(DATA.enemies[e.enemy].name + ' 降臨'); music.intense = 2; } else sfx('elite'); break;
      case 'bossPhase': sfx('boss'); shake += 0.5; break;
      case 'shrine': sfx('shrine'); break;
      case 'heal': sfx('heal'); { const p = game.state.player; addText(p.x, p.z, '+' + e.amount, '#7aff8a', 16, 0.9); } break;
      case 'text': addText(e.x, e.z, e.text, e.color, 20, 1.6); break;
      case 'death': sfx('death'); shake += 0.6; break;
      case 'win': sfx('win'); break;
    }
  }
  // the 3D view shakes on these events itself (scaled by view.shakeScale); only the 2D fallback needs shell shake
  if (viewKind !== '3d' && shake && settings.shake && view.shake) view.shake(Math.min(1, shake));
}
function banner(text) {
  const d = document.createElement('div'); d.className = 'toastab'; d.textContent = text; document.body.appendChild(d);
  setTimeout(() => d.remove(), 1700);
}
function drawFx(dt) {
  fctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  fctx.clearRect(0, 0, W, H);
  if (screen !== 'game' || !game) return;
  fctx.textAlign = 'center'; fctx.textBaseline = 'middle';
  for (let i = dmgTexts.length - 1; i >= 0; i--) {
    const d = dmgTexts[i];
    d.t += dt;
    if (d.t >= d.life) { dmgTexts.splice(i, 1); continue; }
    const k = d.t / d.life;
    const p = view.worldToScreen(d.x + d.ox, 1.8 + k * 1.2, d.z);
    if (!p || !isFinite(p.x)) continue;
    const sc = k < 0.15 ? 0.6 + k / 0.15 * 0.5 : 1.1 - Math.min(0.1, (k - 0.15));
    fctx.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
    fctx.font = '900 ' + Math.round(d.size * sc) + 'px "Noto Sans TC", sans-serif';
    fctx.lineWidth = 3; fctx.strokeStyle = 'rgba(0,0,0,.85)';
    fctx.strokeText(d.text, p.x, p.y); fctx.fillStyle = d.color; fctx.fillText(d.text, p.x, p.y);
  }
  fctx.globalAlpha = 1;
  // mini hp bar under the hero (2D view only)
  const pl = game.state.player;
  if (pl.alive && viewKind !== '3d') {
    const p = view.worldToScreen(pl.x, 0, pl.z);
    if (p && isFinite(p.x)) {
      const w = 40, f = clamp(pl.hp / pl.maxHp, 0, 1);
      fctx.fillStyle = 'rgba(0,0,0,.7)'; fctx.fillRect(p.x - w / 2 - 1, p.y + 16, w + 2, 6);
      fctx.fillStyle = f < 0.3 ? '#ff4a3a' : '#e0504a'; fctx.fillRect(p.x - w / 2, p.y + 17, w * f, 4);
    }
  }
}

/* =====================================================================
 * HUD
 * ===================================================================== */
let buildSig = '';
const hudCache = {};
function setText(id, v) { if (hudCache[id] !== v) { hudCache[id] = v; $(id).textContent = v; } }
function setStyle(el, prop, v) { const k = el.id + prop; if (hudCache[k] !== v) { hudCache[k] = v; el.style[prop] = v; } }
function updateHUD() {
  const s = game.state, p = s.player;
  setStyle($('#xpfill'), 'width', (clamp(p.xp / p.xpNext, 0, 1) * 100).toFixed(1) + '%');
  const left = s.timeLimit - s.time;
  setText('#timer', !s.bossKilled && left > 0 && left <= 30 ? '首領 ' + Math.ceil(left) : fmtTime(s.time));
  const tw = !s.bossKilled && left > 0 && left <= 30;
  if (hudCache.tw !== tw) { hudCache.tw = tw; $('#timer').classList.toggle('warn', tw); }
  const sub = '擊殺 ' + s.kills + '　金幣 ' + s.gold + (s.endless ? '　無盡' : '');
  setText('#subinfo', sub);
  setStyle($('#hpfill'), 'width', (clamp(p.hp / p.maxHp, 0, 1) * 100).toFixed(1) + '%');
  setStyle($('#shfill'), 'width', (clamp(p.shield / p.maxHp, 0, 1) * 100).toFixed(1) + '%');
  setText('#hptext', Math.ceil(p.hp) + ' / ' + p.maxHp);
  setText('#lvtext', 'Lv ' + p.level);
  setText('#wavetext', '第 ' + s.wave + ' 波');
  if (s.bossHp) {
    if (!hudCache.boss) { hudCache.boss = 1; $('#boss').classList.add('on'); }
    setText('#bossname', s.bossHp.name);
    setStyle($('#bossfill'), 'width', (clamp(s.bossHp.cur / s.bossHp.max, 0, 1) * 100).toFixed(1) + '%');
  } else if (hudCache.boss) { hudCache.boss = 0; $('#boss').classList.remove('on'); }
  // slots
  const sig = s.weapons.map(w => w.id + w.level).join() + '|' + s.passives.map(q => q.id + q.level).join() + '|' + s.buffs.map(b => b.kind).join();
  if (sig !== buildSig) {
    buildSig = sig;
    let h = '';
    for (let i = 0; i < 6; i++) {
      const w = s.weapons[i];
      if (w) { const D = DATA.weapons[w.id]; h += '<div class="slot">' + iconSvg(D.iconId, D.evolved ? { rarity: 'legendary' } : null) + '<i class="' + (D.evolved || w.level >= 6 ? 'max' : '') + '">' + (D.evolved ? '★' : w.level) + '</i></div>'; }
      else h += '<div class="slot"></div>';
    }
    $('#wslots').innerHTML = h;
    h = '';
    for (let i = 0; i < 6; i++) {
      const q = s.passives[i];
      if (q) h += '<div class="slot">' + iconSvg(DATA.passives[q.id].iconId) + '<i class="' + (q.level >= 5 ? 'max' : '') + '">' + q.level + '</i></div>';
      else h += '<div class="slot"></div>';
    }
    $('#pslots').innerHTML = h;
    $('#buffs').innerHTML = s.buffs.map(b => '<span style="color:' + DATA.shrines[b.kind].color + '">' + esc(DATA.shrines[b.kind].name.replace('祭壇', '')) + '</span>').join('');
  }
  // dash ring
  const frac = p.dashCharges >= p.dashMax ? 1 : clamp(1 - p.dashCd / p.dashCdMax, 0, 1);
  setStyle($('#dashring'), 'strokeDashoffset', (289 * (1 - frac)).toFixed(0));
  const cool = p.dashCharges <= 0;
  if (hudCache.cool !== cool) { hudCache.cool = cool; $('#dashbtn').classList.toggle('cool', cool); }
  setText('#dashch', p.dashMax > 1 ? p.dashCharges + '/' + p.dashMax : '');
}

/* =====================================================================
 * Menus
 * ===================================================================== */
const menu = $('#menu');
function openMenu(html, dim) {
  menu.innerHTML = html; menu.classList.add('on'); menu.classList.toggle('dim', !!dim); menu.classList.toggle('sheetmode', html.indexOf('class="sw ') >= 0); menu.scrollTop = 0;
}
function closeMenu() { menu.classList.remove('on'); menu.innerHTML = ''; }
function on(sel, fn) { const el = menu.querySelector(sel); if (el) el.addEventListener('click', e => { fn(e); }); }
function onAll(sel, fn) { menu.querySelectorAll(sel).forEach(el => el.addEventListener('click', e => fn(el, e))); }
function goldBar() { return '<div class="goldbar">' + iconSvg('c_gold') + '<span>' + save.gold + '</span></div>'; }
function toMenuMode() {
  screen = 'menu'; game = null; paused = false;
  $('#hud').classList.remove('on');
  stickEl.style.display = 'none'; stick.id = null; stick.active = false;
  if (view) { view.setMode('menu'); view.setStage(save.last.stage); view.setHero(save.last.hero); }
  music.on = true; music.intense = -1; music.nextBar = 0;
}

/* ---------- sheet layout: header / scrolling body / pinned footer ---------- */
// cls: 'dock' (hero/stage select: bottom ≤60% in portrait, right panel in landscape), 'side' (title),
//      'full' (talents / equipment / settings / pause / summary), 'center' (small dialogs), 'bare' (choice cards)
function sheet(cls, head, body, foot) {
  return '<div class="sw ' + cls + '"><div class="sheet">' + (head ? '<div class="shead">' + head + '</div>' : '') +
    '<div class="sbody">' + body + '</div>' + (foot ? '<div class="sfoot">' + foot + '</div>' : '') + '</div></div>';
}
function keepScroll(fn) {
  const b = menu.querySelector('.sbody'); const t = b ? b.scrollTop : 0;
  fn();
  const n = menu.querySelector('.sbody'); if (n) n.scrollTop = t;
}
// where the 3D menu camera puts the hero: 'hero' = clear area above/left of a docked panel, 'default' = centre
let menuFocusMode = 'default';
function setFocus(mode) { menuFocusMode = mode; applyMenuFocus(); }
function applyMenuFocus() {
  if (!view || typeof view.setMenuFocus !== 'function') return;
  const land = W >= H;
  try {
    if (menuFocusMode === 'hero') { if (land) view.setMenuFocus(0.26, 0.5); else view.setMenuFocus(0.5, 0.24); }
    else if (menuFocusMode === 'title') { if (land) view.setMenuFocus(0.3, 0.52); else view.setMenuFocus(0.5, 0.3); }
    else view.setMenuFocus(0.5, 0.5);
  } catch (e) { /* ignore */ }
}

function showTitle() {
  toMenuMode();
  setFocus('title');
  openMenu(sheet('side', '<h1 class="logo">深淵倖存者</h1><div class="sub">ABYSS · SURVIVORS</div>',
    goldBar() + '<div class="note">最佳存活 ' + fmtTime(save.stats.bestTime) + '　累計擊殺 ' + save.stats.kills + '　勝利 ' + save.stats.wins + '</div>' +
    '<div class="note">自動攻擊，只需移動與衝刺。收集靈魂寶石升級，撐到第 8 分鐘擊敗首領！</div>',
    '<button class="btn primary wide" id="b-start">開始冒險</button><button class="btn" id="b-tal">天賦</button><button class="btn" id="b-eq">裝備</button><button class="btn dark" id="b-set">設定</button>'));
  on('#b-start', () => { sfx('click'); showHeroSelect(); });
  on('#b-tal', () => { sfx('click'); showTalents(); });
  on('#b-eq', () => { sfx('click'); showEquip(); });
  on('#b-set', () => { sfx('click'); showSettings(showTitle); });
}

function heroStatsHtml(id) {
  const s = DATA.heroes[id].stats;
  const row = (n, v, mx, t) => '<div class="statrow"><span>' + n + '</span><div class="bar"><b style="width:' + clamp(v / mx * 100, 5, 100) + '%"></b></div><span>' + t + '</span></div>';
  return '<div class="stats2">' + row('生命', s.maxHp, 140, s.maxHp) + row('移速', s.speed, 1.15, Math.round(s.speed * 100) + '%') + row('護甲', s.armor + 0.3, 2.3, s.armor) +
    row('傷害', s.might, 1.15, Math.round(s.might * 100) + '%') + row('冷卻', 2 - s.cd, 1.15, Math.round(s.cd * 100) + '%') + row('暴擊', s.crit, 0.16, Math.round(s.crit * 100) + '%') + '</div>';
}
function showHeroSelect() {
  let sel = heroUnlocked(save.last.hero) ? save.last.hero : 'knight';
  if (view) view.setHero(sel);
  setFocus('hero');
  const render = () => {
    const H = DATA.heroes[sel], un = heroUnlocked(sel), Wp = DATA.weapons[H.weapon];
    let tiles = '';
    for (const id of DATA.ids.heroes) {
      const h = DATA.heroes[id], u = heroUnlocked(id);
      tiles += '<div class="htile' + (id === sel ? ' sel' : '') + (u ? '' : ' locked') + '" data-id="' + id + '" role="button" aria-label="' + esc(h.name) + '"><div class="ico">' + iconSvg(h.iconId) + (u ? '' : '<span class="lk">🔒</span>') + '</div><div class="nm">' + esc(h.name) + '</div></div>';
    }
    const body = '<div class="detail d2">' +
      '<div class="dhead"><b style="color:' + H.color + '">' + esc(H.name) + '</b><span class="muted">' + esc(H.desc) + '</span></div>' +
      (un ? '' : '<div class="lock">🔒 解鎖條件：' + esc(H.unlock.desc) + '（' + heroProgress(sel) + '）</div>') +
      '<div class="wline"><div class="ico">' + iconSvg(Wp.iconId) + '</div><div><b>' + esc(Wp.name) + '</b><div class="muted">' + esc(Wp.desc) + '</div></div></div>' +
      '<div class="trait">特性　' + esc(H.trait) + '</div>' + heroStatsHtml(sel) + '</div>';
    keepScroll(() => openMenu(sheet('dock', '<h2>選擇英雄</h2><div class="tiles">' + tiles + '</div>', body,
      '<button class="btn dark" id="b-back">返回</button><button class="btn primary grow" id="b-next"' + (un ? '' : ' disabled') + '>' + (un ? '下一步' : '🔒 未解鎖') + '</button>')));
    onAll('.htile', el => { if (el.dataset.id === sel) return; sel = el.dataset.id; sfx('click'); if (view) view.setHero(sel); render(); });
    on('#b-back', () => { sfx('click'); showTitle(); });
    on('#b-next', () => { if (!heroUnlocked(sel)) return; sfx('click'); save.last.hero = sel; persist(); showStageSelect(); });
  };
  render();
}
function showStageSelect() {
  let sel = stageUnlocked(save.last.stage) ? save.last.stage : 'graveyard';
  let diff = save.last.difficulty;
  if (!DATA.difficulties[diff] || !diffUnlocked(DATA.difficulties[diff].idx)) diff = 'normal';
  if (view) view.setStage(sel);
  setFocus('hero');
  const render = () => {
    let cards = '';
    for (const id of DATA.ids.stages) {
      const st = DATA.stages[id], un = stageUnlocked(id), cl = save.stats.cleared[id], best = save.stats.best[id] || 0;
      const status = !un ? '🔒 未解鎖' : cl != null ? '✓ 已通關（' + DATA.difficulties[DATA.ids.difficulties[cl]].name + '）' : best ? '最佳 ' + fmtTime(best) : '尚未挑戰';
      cards += '<div class="scard' + (id === sel ? ' sel' : '') + (un ? '' : ' locked') + '" data-id="' + id + '" role="button" style="--ac:' + st.colors.accent + '"><div class="nm">' + esc(st.name) + '</div><div class="ds">' + status + '</div></div>';
    }
    const S = DATA.stages[sel];
    let diffs = '';
    for (const id of DATA.ids.difficulties) {
      const D = DATA.difficulties[id], un = diffUnlocked(D.idx);
      diffs += '<button class="btn small' + (id === diff ? ' sel' : ' dark') + '" data-d="' + id + '"' + (un ? '' : ' disabled') + ' style="color:' + D.color + '">' + (un ? '' : '🔒') + esc(D.name) + '</button>';
    }
    const D = DATA.difficulties[diff];
    const body = '<div class="muted" style="margin-bottom:8px">' + esc(S.desc) + '</div>' +
      '<h3>難度</h3><div class="diffs">' + diffs + '</div><div class="muted" style="margin-top:6px">' +
      (D.idx ? '敵人生命 ×' + D.hp + '、傷害 ×' + D.dmg + '，更多精英、更好的戰利品與 ×' + D.gold + ' 金幣。' : '標準難度。通關後解鎖下一級難度。') + '</div>';
    keepScroll(() => openMenu(sheet('dock', '<h2>選擇關卡</h2><div class="stiles">' + cards + '</div>', body,
      '<button class="btn dark" id="b-back">返回</button><button class="btn primary grow" id="b-go">出發！</button>')));
    onAll('.scard', el => {
      const id = el.dataset.id;
      if (!stageUnlocked(id)) { sfx('error'); KG.toast(DATA.stages[id].unlock.desc + ' 後解鎖'); return; }
      if (id === sel) return;
      sel = id; sfx('click'); if (view) view.setStage(sel); render();
    });
    onAll('[data-d]', el => { if (el.disabled) return; diff = el.dataset.d; sfx('click'); render(); });
    on('#b-back', () => { sfx('click'); showHeroSelect(); });
    on('#b-go', () => { sfx('click'); startRun({ hero: save.last.hero, stage: sel, difficulty: diff }); });
  };
  render();
}

function showTalents() {
  setFocus('default');
  const render = () => {
    let rows = '';
    for (const id of DATA.ids.talents) {
      const T = DATA.talents[id], lv = save.talents[id] | 0, maxed = lv >= T.max, cost = maxed ? 0 : talentCost(id, lv);
      let pips = ''; for (let i = 0; i < T.max; i++) pips += '<i class="' + (i < lv ? 'on' : '') + '"></i>';
      rows += '<div class="tal"><div class="ico">' + iconSvg(T.iconId) + '</div><div><div class="nm">' + esc(T.name) + ' <span class="muted">' + lv + '/' + T.max + '</span></div><div class="muted">' + esc(T.desc) + '</div><div class="pips">' + pips + '</div></div>' +
        '<button class="btn small" data-t="' + id + '"' + (maxed || save.gold < cost ? ' disabled' : '') + '>' + (maxed ? '已滿' : '<span class="gold">' + cost + '</span>') + '</button></div>';
    }
    keepScroll(() => openMenu(sheet('full', '<h2>天賦</h2>' + goldBar(), '<div class="talgrid">' + rows + '</div>',
      '<button class="btn dark" id="b-back">返回</button><button class="btn dark small" id="b-reset">重置天賦（全額退還）</button>')));
    onAll('[data-t]', el => {
      const id = el.dataset.t, lv = save.talents[id] | 0, T = DATA.talents[id];
      if (lv >= T.max) return;
      const c = talentCost(id, lv);
      if (save.gold < c) { sfx('error'); return; }
      save.gold -= c; save.talents[id] = lv + 1; persist(); sfx('buy');
      render();
    });
    on('#b-back', () => { sfx('click'); showTitle(); });
    on('#b-reset', () => {
      let refund = 0;
      for (const id in save.talents) for (let l = 0; l < (save.talents[id] | 0); l++) refund += talentCost(id, l);
      if (!refund) return;
      save.gold += refund; save.talents = {}; persist(); sfx('buy'); render();
    });
  };
  render();
}

function itemDetailHtml(item, cmp) {
  if (!item) return '<div class="muted">（空）</div>';
  const R = DATA.rarities[item.rarity];
  let h = '<div class="nm" style="color:' + R.color + '">' + esc(item.name) + '</div><div class="muted">' + R.name + '・' + DATA.slots[item.slot] + (item.ilvl ? '・' + DATA.difficulties[DATA.ids.difficulties[item.ilvl]].name : '') + '　戰力 ' + itemPower(item) + '</div>';
  for (const a of item.affixes) {
    let cls = 'aff';
    if (cmp) {
      const o = cmp.affixes.find(x => x.id === a.id);
      cls += !o ? ' up' : a.v > o.v ? ' up' : a.v < o.v ? ' down' : '';
    }
    h += '<div class="' + cls + '">◆ ' + esc(describeAffix(a)) + '</div>';
  }
  if (item.legendary) h += '<div class="leg">★ ' + esc(DATA.legendaries[item.legendary].name) + '：' + esc(DATA.legendaries[item.legendary].desc) + '</div>';
  return h;
}
function showEquip(fromRun) {
  setFocus('default');
  let selUid = null;
  const render = () => {
    const inv = save.inventory;
    const eqUids = SLOT_IDS.map(s => save.equipped[s] && save.equipped[s].uid);
    let slots = '';
    for (const s of SLOT_IDS) {
      const it = save.equipped[s];
      slots += '<div><div class="it' + (it ? ' eq' : ' empty') + (it && it.uid === selUid ? ' sel' : '') + '" data-u="' + (it ? it.uid : '') + '" style="--rc:' + (it ? RCOL[it.rarity] : '#333') + '">' + (it ? itemIcon(it) : '') + '</div><div class="lab">' + DATA.slots[s] + '</div></div>';
    }
    let grid = '';
    for (let i = 0; i < 40; i++) {
      const it = inv[i];
      if (!it) { grid += '<div class="it empty"></div>'; continue; }
      grid += '<div class="it' + (it.uid === selUid ? ' sel' : '') + '" data-u="' + it.uid + '" style="--rc:' + RCOL[it.rarity] + '">' + itemIcon(it) + (it.isNew ? '<span class="new">新</span>' : '') + '</div>';
    }
    let det = '<div class="muted" style="text-align:center">點選物品查看詳情、比較與裝備</div>';
    let acts = '';
    const sel = selUid && (inv.find(x => x.uid === selUid) || SLOT_IDS.map(s => save.equipped[s]).find(x => x && x.uid === selUid));
    if (sel) {
      const isEq = eqUids.includes(sel.uid);
      const cur = save.equipped[sel.slot];
      det = '<div class="cmp"><div>' + itemDetailHtml(sel, !isEq && cur ? cur : null) + '</div><div><div class="muted">目前裝備</div>' + itemDetailHtml(isEq ? null : cur) + '</div></div>';
      acts = isEq ? '<button class="btn" id="b-uneq">卸下</button>' : '<button class="btn primary" id="b-eqp">裝備</button><button class="btn dark" id="b-salv">分解 +<span class="gold">' + salvageValue(sel) + '</span></button>';
    }
    keepScroll(() => openMenu(sheet('full', '<h2>裝備</h2>' + goldBar(),
      '<div class="eqslots">' + slots + '</div><div class="itemdet boxed">' + det + '</div>' +
      '<div class="muted" style="margin:8px 0 6px">背包 ' + inv.length + ' / 40</div><div class="inv">' + grid + '</div>',
      '<button class="btn dark" id="b-back">返回</button>' + (acts || '<button class="btn dark small" id="b-salall">分解所有普通物品</button>'))));
    onAll('.it[data-u]', el => { if (!el.dataset.u) return; selUid = el.dataset.u; const it = inv.find(x => x.uid === selUid); if (it) delete it.isNew; sfx('click'); render(); });
    on('#b-eqp', () => {
      const i = inv.findIndex(x => x.uid === selUid); if (i < 0) return;
      const it = inv.splice(i, 1)[0];
      const old = save.equipped[it.slot];
      save.equipped[it.slot] = it;
      if (old) inv.splice(i, 0, old);
      persist(); sfx('pick'); render();
    });
    on('#b-uneq', () => {
      const s = SLOT_IDS.find(s => save.equipped[s] && save.equipped[s].uid === selUid); if (!s) return;
      if (inv.length >= 40) { sfx('error'); KG.toast('背包已滿'); return; }
      inv.push(save.equipped[s]); save.equipped[s] = null; persist(); sfx('click'); render();
    });
    on('#b-salv', () => {
      const i = inv.findIndex(x => x.uid === selUid); if (i < 0) return;
      save.gold += salvageValue(inv[i]); inv.splice(i, 1); selUid = null; persist(); sfx('buy'); render();
    });
    on('#b-salall', () => {
      let g = 0; save.inventory = inv.filter(x => { if (x.rarity === 'common') { g += salvageValue(x); return false; } return true; });
      if (g) { save.gold += g; persist(); sfx('buy'); KG.toast('分解獲得 ' + g + ' 金幣'); } selUid = null; render();
    });
    on('#b-back', () => { sfx('click'); if (fromRun) fromRun(); else showTitle(); });
  };
  render();
}

function showSettings(back) {
  if (screen !== 'game') setFocus('default');
  const render = () => {
    const seg = (key, opts) => '<div class="seg">' + opts.map(([v, t]) => '<button class="btn small ' + (String(settings[key]) === String(v) ? 'sel' : 'dark') + '" data-k="' + key + '" data-v="' + v + '">' + t + '</button>').join('') + '</div>';
    keepScroll(() => openMenu(sheet('full', '<h2>設定</h2>',
      '<div class="set"><span>音樂</span>' + seg('music', [[true, '開'], [false, '關']]) + '</div>' +
      '<div class="set"><span>音效</span>' + seg('sfx', [[true, '開'], [false, '關']]) + '</div>' +
      '<div class="set"><span>畫質</span>' + seg('quality', [['auto', '自動'], [0, '低'], [1, '中'], [2, '高'], [3, '極高']]) + '</div>' +
      '<div class="set"><span>傷害數字</span>' + seg('dmgNumbers', [[true, '開'], [false, '關']]) + '</div>' +
      '<div class="set"><span>畫面震動</span>' + seg('shake', [[true, '開'], [false, '關']]) + '</div>' +
      '<div class="set"><span>搖桿區域</span>' + seg('stick', [['full', '全螢幕'], ['left', '左側 60%']]) + '</div>' +
      '<div class="note" style="margin-top:8px">右上角 🔊 為全域靜音。目前畫面：' + (viewKind === '3d' ? '3D' : '2D 簡易') + '</div>',
      '<button class="btn dark" id="b-back">返回</button>'), screen === 'game'));
    onAll('[data-k]', el => {
      const k = el.dataset.k; let v = el.dataset.v;
      if (v === 'true') v = true; else if (v === 'false') v = false;
      settings[k] = v; persistSettings(); sfx('click');
      if (k === 'quality' || k === 'dmgNumbers' || k === 'shake') applyQuality();
      if (k === 'music') music.nextBar = 0;
      render();
    });
    on('#b-back', () => { sfx('click'); back(); });
  };
  render();
}

/* ---------- in-run menus ---------- */
// Tap guard for menus that replace each other (chest → queued level-up): a real tap only counts if its
// pointerdown happened after the menu appeared, so the click that claimed the chest can never pick a card.
let menuDownAt = -1e9;
menu.addEventListener('pointerdown', () => { menuDownAt = performance.now(); }, true);
function freshTap(e) {
  if (e && e.isTrusted === false) return true; // keyboard shortcuts / scripted clicks
  return menuDownAt >= phaseShownAt && performance.now() - phaseShownAt >= 250;
}
function choiceCardHtml(c, i, banishMode) {
  const rc = RCOL[c.rarity] || '#888';
  const lvTxt = c.kind === 'evolution' ? '進化' : c.kind === 'gold' || c.kind === 'heal' ? '' : c.isNew ? '新！' : 'Lv ' + (c.level - 1) + ' → ' + c.level;
  return '<div class="card' + (banishMode ? ' banishing' : '') + '" data-i="' + i + '" style="--rc:' + rc + ';animation-delay:' + (i * 0.06) + 's"><span class="tag">' + (DATA.rarities[c.rarity] || {}).name + '</span><div class="ico">' + iconSvg(c.iconId, { rarity: c.rarity }) + '</div>' +
    '<div class="txt"><div class="nm">' + esc(c.name) + '</div><div class="lv">' + esc(lvTxt) + (c.kind === 'passive' ? '　被動' : c.kind === 'weapon' ? '　武器' : '') + '</div><div class="ds">' + esc(c.desc) + '</div></div></div>';
}
let banishMode = false;
function showLevelUp() {
  const s = game.state;
  const ch = game.getChoices();
  phaseShownAt = performance.now();
  const cards = ch.map((c, i) => choiceCardHtml(c, i, banishMode)).join('');
  openMenu(sheet('bare', '<h2>' + (banishMode ? '選擇要放逐的項目' : '升級！ Lv ' + s.player.level) + '</h2>' + (s.pendingLevels > 1 ? '<div class="note">還有 ' + (s.pendingLevels - 1) + ' 次升級</div>' : ''),
    '<div class="cards">' + cards + '</div>',
    '<button class="btn small" id="b-rr"' + (s.rerolls > 0 && !banishMode ? '' : ' disabled') + '>重抽 ×' + s.rerolls + '</button>' +
    '<button class="btn small' + (banishMode ? ' sel' : '') + '" id="b-ban"' + (s.banishes > 0 ? '' : ' disabled') + '>' + (banishMode ? '取消放逐' : '放逐 ×' + s.banishes) + '</button>' +
    '<button class="btn small dark" id="b-skip"' + (s.skips > 0 && !banishMode ? '' : ' disabled') + '>跳過 ×' + s.skips + '</button>'), true);
  onAll('.card', (el, e) => {
    if (!freshTap(e)) return;
    const i = +el.dataset.i;
    if (banishMode) { if (game.banish(i)) { sfx('error'); banishMode = false; showLevelUp(); } return; }
    sfx('pick'); game.choose(i); afterMenuChoice();
  });
  on('#b-rr', e => { if (!freshTap(e)) return; if (game.reroll()) { sfx('click'); showLevelUp(); } });
  on('#b-ban', e => { if (!freshTap(e)) return; banishMode = !banishMode; sfx('click'); showLevelUp(); });
  on('#b-skip', e => { if (!freshTap(e)) return; if (game.skip()) { sfx('click'); afterMenuChoice(); } });
}
function showChest() {
  const ch = game.getChoices();
  phaseShownAt = performance.now();
  sfx('chest');
  openMenu(sheet('bare', '<h2>寶箱！</h2>', '<div class="cards">' + ch.map((c, i) => choiceCardHtml(c, i, false)).join('') + '</div>',
    '<button class="btn primary grow" id="chestok">全部領取</button>'), true);
  const ok = (el, e) => { if (!freshTap(e || el)) return; game.choose(0); sfx('pick'); afterMenuChoice(); };
  on('#chestok', e => ok(null, e));
  onAll('.card', ok);
}
function afterMenuChoice() {
  banishMode = false;
  const ph = game.state.phase;
  if (ph === 'levelup') showLevelUp();
  else if (ph === 'chest') showChest();
  else closeMenu();
  prevPhase = ph;
}
function statsHtml() {
  const S = game.getStats(), p = game.state.player;
  const pct = v => Math.round(v * 100) + '%';
  const rows = [['最大生命', p.maxHp], ['傷害', pct(S.might)], ['冷卻', pct(S.cd)], ['範圍', pct(S.area)], ['投射物', '+' + S.amount], ['持續', pct(S.duration)],
    ['護甲', S.armor], ['減傷', pct(S.dr)], ['再生', S.regen.toFixed(1) + '/秒'], ['移速', pct(S.speed)], ['拾取', pct(S.magnet)], ['幸運', pct(S.luck)],
    ['暴擊率', pct(S.crit)], ['暴擊傷害', pct(S.critMult)], ['經驗', pct(S.xp)], ['金幣', pct(S.gold)], ['復活', Math.max(0, S.revive - game.state.revives)]];
  return '<div class="stats">' + rows.map(r => '<div><span>' + r[0] + '</span><b>' + r[1] + '</b></div>').join('') + '</div>';
}
function buildHtml(withDmg) {
  const s = game.state;
  let h = '<div class="build">';
  for (const w of s.weapons) { const D = DATA.weapons[w.id]; h += '<div class="bitem"><div class="ico">' + iconSvg(D.iconId, D.evolved ? { rarity: 'legendary' } : null) + '</div><div><b>' + esc(D.name) + '</b><div class="muted">' + (D.evolved ? '進化' : 'Lv ' + w.level) + (withDmg ? '・' + fmtNum(w._dmg || 0) : '') + '</div></div></div>'; }
  for (const q of s.passives) { const D = DATA.passives[q.id]; h += '<div class="bitem"><div class="ico">' + iconSvg(D.iconId) + '</div><div><b>' + esc(D.name) + '</b><div class="muted">Lv ' + q.level + '</div></div></div>'; }
  return h + '</div>';
}
function showPause() {
  const s = game.state;
  openMenu(sheet('full', '<h2>暫停</h2>',
    '<div class="bigstat"><div>時間<b>' + fmtTime(s.time) + '</b></div><div>等級<b>' + s.player.level + '</b></div><div>擊殺<b>' + s.kills + '</b></div><div>金幣<b>' + s.gold + '</b></div></div>' +
    '<h3>目前組合</h3>' + buildHtml(true) + '<h3>屬性</h3>' + statsHtml(),
    '<button class="btn primary grow" id="b-res">繼續</button><button class="btn" id="b-set">設定</button><button class="btn dark" id="b-quit">放棄本局</button>'), true);
  on('#b-res', () => { paused = false; sfx('click'); closeMenu(); });
  on('#b-set', () => { sfx('click'); showSettings(showPause); });
  on('#b-quit', () => { sfx('click'); paused = false; finishRun(); });
}
function showWinChoice() {
  openMenu(sheet('center', '<h1 class="logo" style="font-size:44px">勝利！</h1>',
    '<div style="text-align:center">你擊敗了 <b class="gold">' + esc(DATA.enemies[DATA.stages[game.state.stage].boss].name) + '</b></div>' +
    '<div class="muted" style="text-align:center;margin-top:6px">可以結算戰利品，或繼續挑戰越來越強的無盡模式（死亡時仍保留勝利獎勵）。</div>',
    '<button class="btn primary grow" id="b-sum">結算戰利品</button><button class="btn grow" id="b-end">繼續・無盡模式</button>'), true);
  on('#b-sum', () => { sfx('click'); finishRun(); });
  on('#b-end', () => { sfx('click'); game.continueEndless(); closeMenu(); prevPhase = 'play'; music.intense = 2; });
}
let lastSummary = null;
function finishRun() {
  if (!game) return;
  const sum = game.getSummary();
  lastSummary = sum;
  save.gold += sum.gold;
  save.stats.runs++;
  save.stats.kills += sum.kills;
  save.stats.bestTime = Math.max(save.stats.bestTime, Math.floor(sum.time));
  save.stats.best[sum.stage] = Math.max(save.stats.best[sum.stage] || 0, Math.floor(sum.time));
  const di = DATA.difficulties[sum.difficulty].idx;
  if (sum.win) {
    save.stats.wins++;
    save.stats.cleared[sum.stage] = Math.max(save.stats.cleared[sum.stage] == null ? -1 : save.stats.cleared[sum.stage], di);
    save.stats.maxDiff = Math.max(save.stats.maxDiff == null ? -1 : save.stats.maxDiff, di);
  }
  let salv = 0;
  for (const it of sum.loot) {
    if (save.inventory.length < 40) save.inventory.push(Object.assign({ isNew: true }, it));
    else salv += salvageValue(it);
  }
  save.gold += salv;
  persist();
  showSummary(sum, salv);
}
function showSummary(sum, salv) {
  game.state.phase = sum.win ? 'win' : 'dead';
  music.intense = -1;
  const dmgRows = sum.weapons.slice().sort((a, b) => b.dmg - a.dmg).map(w => '<tr><td style="width:30px"><div class="ico" style="width:26px;height:26px">' + iconSvg(DATA.weapons[w.id].iconId) + '</div></td><td>' + esc(DATA.weapons[w.id].name) + '</td><td>' + fmtNum(w.dmg) + '</td></tr>').join('');
  const loot = sum.loot.map((it, i) => '<div class="it ' + it.rarity + '" style="--rc:' + RCOL[it.rarity] + ';animation-delay:' + (0.4 + i * 0.25) + 's" title="' + esc(it.name) + '">' + itemIcon(it) + '</div>').join('');
  openMenu(sheet('full', '<h1 class="logo" style="font-size:clamp(28px,7vh,40px)">' + (sum.win ? '凱旋歸來' : '倒在深淵') + '</h1>',
    '<div class="bigstat"><div>存活<b>' + fmtTime(sum.time) + '</b></div><div>擊殺<b>' + sum.kills + '</b></div><div>等級<b>' + sum.level + '</b></div><div>金幣<b class="gold">+' + sum.gold + '</b></div></div>' +
    '<div class="muted" style="text-align:center;margin-top:6px">' + esc(DATA.heroes[sum.hero].name) + '・' + esc(DATA.stages[sum.stage].name) + '・' + DATA.difficulties[sum.difficulty].name + '　（拾取 ' + sum.goldCollected + ' ＋ 結算獎勵 ' + sum.goldBonus + '）</div>' +
    '<h3>戰利品 ' + sum.loot.length + ' 件</h3>' + (sum.loot.length ? '<div class="loot">' + loot + '</div>' : '<div class="muted">擊敗精英與首領可獲得裝備。</div>') +
    (salv ? '<div class="muted">背包已滿，自動分解獲得 ' + salv + ' 金幣</div>' : '') +
    '<h3>武器傷害</h3><table class="dmg">' + dmgRows + '</table>',
    '<button class="btn primary grow" id="b-again">再來一局</button><button class="btn" id="b-eq">裝備</button><button class="btn" id="b-tal">天賦</button><button class="btn dark" id="b-title">主選單</button>'), true);
  sum.loot.forEach((it, i) => setTimeout(() => { if (it.rarity === 'legendary') sfx('evolve'); else if (it.rarity === 'rare') sfx('chest'); else sfx('pick'); }, 400 + i * 250));
  onAll('.loot .it', (el) => { const it = sum.loot[[...el.parentNode.children].indexOf(el)]; if (it) KG.toast(it.name + '・' + DATA.rarities[it.rarity].name); });
  on('#b-again', () => { sfx('click'); startRun(runOpts); });
  on('#b-eq', () => { sfx('click'); toMenuMode(); showEquip(); });
  on('#b-tal', () => { sfx('click'); toMenuMode(); showTalents(); });
  on('#b-title', () => { sfx('click'); showTitle(); });
  screen = 'summary';
  $('#hud').classList.remove('on');
}

/* =====================================================================
 * Main loop
 * ===================================================================== */
let last = performance.now(), first = true, deathT = 0;
function frame(now) {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  try {
    if (screen === 'game' && game) {
      const s = game.state;
      if (!paused && s.phase === 'play') {
        if (botOn) { const b = botInput(game); game.setInput({ mx: b.mx, mz: b.mz, dash: b.dash }); }
        else { readInput(); game.setInput(inp); inp.dash = false; }
        const ex = view.getViewExtents(); game.setViewExtents(ex.halfW, ex.halfH);
        acc += dt;
        let n = 0;
        while (acc >= STEP && n < 6 && game.state.phase === 'play') { game.update(STEP); acc -= STEP; n++; }
        if (n >= 6) acc = 0;
      } else acc = 0;
      handleEvents(game.events);
      view.render(game.state, game.events, paused ? 0 : dt);
      game.events.length = 0;
      updateHUD();
      // phase transitions
      const ph = game.state.phase;
      if (ph !== prevPhase) {
        if (ph === 'levelup') { if (botOn) { game.choose(botPick(game)); } else showLevelUp(); }
        else if (ph === 'chest') { if (botOn) game.choose(0); else showChest(); }
        else if (ph === 'dead') { deathT = 0; }
        else if (ph === 'win') { if (!botOn) setTimeout(() => { if (game && game.state.phase === 'win' && screen === 'game') showWinChoice(); }, 1200); }
        prevPhase = game.state.phase;
      }
      if (botOn && (game.state.phase === 'levelup' || game.state.phase === 'chest')) { game.choose(game.state.phase === 'chest' ? 0 : botPick(game)); prevPhase = game.state.phase; }
      if (ph === 'dead' && screen === 'game') { deathT += dt; if (deathT > 1.6) finishRun(); }
    } else if (screen === 'summary' && game) {
      view.render(game.state, game.events, dt * 0.3); game.events.length = 0;
    } else if (view) {
      view.renderMenu(dt);
    }
    drawFx(dt);
  } catch (e) {
    console.error(e);
  }
  if (first) { first = false; const m = $('#msg'); if (m) m.remove(); }
  requestAnimationFrame(frame);
}

/* =====================================================================
 * Boot + test hooks
 * ===================================================================== */
await initView();
layout();
showTitle();
requestAnimationFrame(frame);

window.__ab = {
  get state() { return game && game.state; },
  get game() { return game; },
  get meta() { return save; },
  get settings() { return settings; },
  get screen() { return screen; },
  get viewKind() { return viewKind; },
  get viewError() { return viewError; },
  get paused() { return paused; },
  start(opts) { startRun(opts || {}); return game; },
  step(n) { for (let i = 0; i < (n || 1); i++) { if (!game) break; if (botOn && (game.state.phase === 'levelup' || game.state.phase === 'chest')) { game.choose(game.state.phase === 'chest' ? 0 : botPick(game)); prevPhase = game.state.phase; closeMenu(); } if (game.state.phase === 'play') { if (botOn) game.setInput(botInput(game)); game.update(STEP); game.events.length = Math.min(game.events.length, 400); } } },
  bot(on) { botOn = on !== false; },
  give(id, level) { if (game) game.debug.give(id, level); },
  spawn(type, n, opt) { return game ? game.debug.spawn(type, n || 1, opt).length : 0; },
  killAll() { if (game) game.debug.killAll(); },
  win() { if (game) game.debug.win(); },
  setTime(t) { if (game) game.debug.setTime(t); },
  god(on) { if (game) game.debug.god(on); },
  xp(v) { if (game) game.debug.xp(v); },
  chest(t) { if (game) game.debug.chest(t); },
  finish() { finishRun(); },
  title() { showTitle(); },
  addGold(g) { save.gold += g; persist(); },
  resetSave() { save = defSave(); persist(); },
  unlockAll() { save.stats.bestTime = Math.max(save.stats.bestTime, 600); save.stats.kills = Math.max(save.stats.kills, 5000); save.stats.wins = Math.max(save.stats.wins, 1); DATA.ids.stages.forEach(s => { save.stats.cleared[s] = 3; }); save.stats.maxDiff = 3; persist(); },
  DATA
};
