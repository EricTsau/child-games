# 「深淵倖存者」 Abyss Survivors — design + module contract

An ORIGINAL dark-gothic 3D action roguelike in the "horde survivors" genre: the hero auto-attacks, the player only
moves and dashes, hordes of monsters close in, XP gems → level-up choices → builds, elites/bosses, loot between runs.
Original names, characters and art only — do NOT use names, characters, items, logos or look of any existing game.
UI text Traditional Chinese (zh-TW). Not a kids' game: moody, but no gore (monsters dissolve into ash/embers).

Folder (multi-file exception to the usual one-file rule): `/home/user/-/games/abyss-survivors/`
- `core.js`   — pure game simulation (no DOM, no three.js). Owner: LOGIC agent.
- `view3d.js` — all 3D rendering with three.js. Owner: 3D agent.
- `main.js` + `index.html` — shell: loop, input, HUD/menus (DOM), audio, saves. Owner: LOGIC agent (phase 2).
All are ES modules. three.js via the same importmap as games/neon-breaker (`../../assets/vendor/three/`).

## World conventions (both modules)
- Ground is the XZ plane, Y up. 1 unit ≈ 1 metre. Hero radius 0.45, base move speed 5.2 u/s.
- Screen-up = world −Z, screen-right = world +X (camera never yaws). Input vector (mx, mz) is in world axes.
- `rot` everywhere = `Math.atan2(dirX, dirZ)` so `object.rotation.y = rot` turns a model whose front is +Z.
- The world is endless. Obstacles are deterministic from a hash of grid cells (see `obstaclesNear`), same for both modules.
- All lists in `state` are DENSE arrays of plain objects (only live entries; core swap-removes). Every entity has a
  unique numeric `id` that never repeats in a run, so the view can keep per-entity visuals in a Map.
- The view must never mutate `state`. The view must tolerate unknown `type`/`kind` strings (render a generic fallback,
  never throw). If the LOGIC agent adds ids not listed here it must append them to `games/abyss-survivors/CONTRACT-ADDENDUM.md`.

## core.js API
```js
import { createGame, DATA, obstaclesNear } from './core.js';
const game = createGame({ stage, hero, difficulty, seed, meta });   // meta = saved permanent upgrades + equipped items
game.setInput({ mx, mz, dash });        // mx,mz in [-1,1] (normalised by core), dash = true on the frame it is pressed
game.setViewExtents(halfW, halfH);      // world half-size of the visible ground rect (from view.getViewExtents())
game.update(dt);                        // advances the sim (core sub-steps internally; dt clamped)
game.state;                             // see below
game.events;                            // array of one-shot events since last drain; main calls game.events.length = 0 after view.render
game.getChoices();                      // when state.phase==='levelup'|'chest': [{id, kind, name, desc, level, maxLevel, rarity, iconId}]
game.choose(index); game.reroll(); game.banish(index); game.skip();
game.getSummary();                      // end-of-run summary {time, kills, gold, level, weapons:[...], loot:[items], win}
DATA                                    // static tables: DATA.heroes, weapons, passives, enemies, stages, items, affixes (names zh-TW, desc, iconId, colors)
obstaclesNear(stageId, x, z, range)     // → [{x, z, r, kind, seed}] deterministic; used by core for collision and by the view to draw props
```

### state
```
state.time (s)  state.phase: 'play'|'levelup'|'chest'|'dead'|'win'   state.stage  state.difficulty
state.timeLimit (s; boss spawns at this time)   state.kills  state.gold  state.wave (int)  state.bossHp {cur,max,name}|null
state.player: { x, z, rot (aim/facing), moveX, moveZ (unit dir or 0), speed (u/s now), hp, maxHp, shield,
                level, xp, xpNext, dashing (0 or 0..1 progress), dashCd (s left), dashCdMax, invuln (s), hurt (0..1 decays),
                hero (id), alive, pickupR, auraR (0 if no aura weapon), auraKind }
state.weapons: [{ id, level, cd (0..1 progress to next cast) }]      state.passives: [{ id, level }]
state.enemies: [{ id, type, x, z, rot, r (radius), hp, maxHp, scale (1; elites ~1.6, bosses 3+), elite (bool),
                  affix ('' or id), boss (bool), flash (0..1 hit flash, decays), frozen (s left), burning (s), poisoned (s),
                  slowed (s), anim ('walk'|'attack'|'cast'|'windup'|'charge'|'summon'|'stun'|'spawn'), animT (s in anim),
                  flying (bool), age (s) }]
state.projectiles: [{ id, kind, owner ('p'|'e'), x, y (height, usually 1), z, vx, vz, rot, r, age, life }]
state.zones: [{ id, kind, x, z, r, age, life, owner ('p'|'e'), angle?, len?, width? }]   // ground effects + telegraphs
state.allies: [{ id, type, x, z, rot, anim, animT }]                                     // summoned minions
state.pickups: [{ id, kind, x, z, age, value, magnet (bool: flying to player) }]
state.shrines: [{ id, kind, x, z, used }]
```

### events (one-shot, pushed by core)
`{type:'hit', x, z, dmg, crit, kind /*'phys'|'fire'|'frost'|'light'|'poison'|'holy'|'dark'*/, target:'e'|'p'}`
`{type:'kill', x, z, enemy (type id), elite, boss, rot, scale}`   `{type:'cast', weapon (id), rot}`
`{type:'slash', x, z, rot, arc (radians), range, kind}`            `{type:'chain', points:[{x,z},...], kind}`
`{type:'explode', x, z, r, kind}`  `{type:'nova', x, z, r, kind}`  `{type:'strike', x, z, r, kind}` (lightning/meteor impact)
`{type:'spawn', x, z, enemy}` (elite/boss arrival)  `{type:'bossPhase', n}`  `{type:'dash', x, z, rot}`
`{type:'pickup', kind, x, z, value}`  `{type:'levelup', level}`  `{type:'heal', amount}`  `{type:'shrine', kind, x, z}`
`{type:'evolve', weapon}`  `{type:'hurt', dmg}`  `{type:'death'}`  `{type:'win'}`  `{type:'text', x, z, text, color}`

## ids (fixed lists; both modules use exactly these strings)
Stages: `graveyard` 迷霧墓園 (fog, tombstones, dead trees, lanterns, cold blue-green) · `catacombs` 蛛網地穴 (flagstones,
pillars, cobwebs, braziers, sickly green) · `inferno` 熔火深淵 (cracked basalt, lava glow, spikes, embers, red-orange) ·
`frostkeep` 霜骨王座 (snow, ice crystals, frozen statues, aurora, pale blue).
Obstacle kinds per stage: graveyard `tomb`,`deadtree`,`lantern`; catacombs `pillar`,`rubble`,`brazier`;
inferno `spike`,`basalt`,`lavavent`; frostkeep `icecrystal`,`statue`,`pine`.

Heroes: `knight` 聖盾騎士 (sword+shield, heavy armour) · `mage` 元素法師 (robe, staff) · `ranger` 暗影遊俠 (hood, bow)
· `necro` 亡靈召喚師 (dark robe, scythe-staff, skull mask) · `berserker` 狂戰士 (bare arms, two axes, fur).

Weapons (auto-cast) → visual:
`sword` 橫掃劍刃 → event `slash` kind `steel` · `firebolt` 火焰彈 → projectile `firebolt` + `explode` kind `fire`
· `arrows` 多重箭 → projectile `arrow` · `axes` 迴旋飛斧 → projectile `axe` (spinning, returns)
· `orbs` 護體靈球 → projectiles `orb` orbiting the hero · `chain` 連鎖閃電 → event `chain` kind `light`
· `nova` 冰霜新星 → event `nova` kind `frost` · `aura` 聖焰光環 → player.auraR / auraKind `holy`
· `daggers` 連射飛刀 → projectile `dagger` · `minions` 骷髏僕從 → allies type `skel`
· `poison` 劇毒瓶 → projectile `flask` (lobbed arc, uses y) + zone `poison`
· `spirits` 怨靈追獵 → projectile `spirit` (homing ghost).
Evolutions (weapon at max level + matching passive, taken from a chest): `holyblade` 聖光裁決 (slash kind `holy`, 360°)
· `meteor` 隕石術 (zone `meteor_mark` then event `strike` kind `meteor`) · `arrowstorm` 箭雨風暴 (projectile `arrow` many +
zone `arrowrain`) · `bloodaxes` 嗜血旋斧 (projectile `bloodaxe`) · `soulring` 靈魂之環 (projectiles `soulorb`)
· `thunderstorm` 雷霆風暴 (zone `lightning_mark` + event `strike` kind `light`) · `blizzard` 暴風雪 (zone `blizzard`)
· `inferno_aura` 煉獄之環 (auraKind `fire`) · `thousand` 千刃風暴 (projectile `dagger` streams)
· `lichguard` 巫妖護衛 (allies type `lich`) · `plague` 瘟疫之雲 (zone `plague`) · `reaper` 死神之鐮 (projectile `reaper`).
Passives: `might` 力量 · `haste` 急速 · `area` 範圍 · `multishot` 分裂 · `duration` 持久 · `armor` 護甲 · `vitality` 體魄
· `regen` 再生 · `swift` 疾行 · `magnet` 磁力 · `luck` 幸運 · `crit` 致命.

Enemies: `skeleton` 骷髏兵 · `zombie` 腐屍 (slow, tanky) · `bat` 血蝠 (flying, fast, small) · `ghoul` 食屍鬼 (fast lunger)
· `spider` 毒蛛 (low, 8 legs) · `imp` 小惡魔 (ranged `e_fireball`) · `cultist` 邪教徒 (robed caster, `e_bolt`, summons)
· `wraith` 怨靈 (flying, translucent, blinks) · `golem` 石魔 (big, slow) · `bomber` 爆裂蟲 (runs in and explodes, telegraph)
· `deathknight` 亡靈騎士 (charges in a line, telegraph) · `shaman` 骨巫 (buffs/heals others, staff) · `hound` 獄犬 (pack, fast)
· `frostling` 冰魔 (ranged `e_frost`, slows).
Elite affixes (aura colour on the elite): `swift` 迅捷 (yellow) · `burning` 烈焰 (orange, leaves zone `fire`) · `frozen` 冰霜 (cyan)
· `vampiric` 吸血 (crimson) · `shielded` 護盾 (white bubble) · `splitting` 分裂 (purple).
Bosses (one per stage, scale ≥ 3): `boss_bonelord` 骸骨領主 (giant crowned skeleton, greatsword: sweeps, bone-spike lines, summons)
· `boss_broodmother` 蛛后 (huge spider: web shots `e_web`, spiderling waves, poison pools) · `boss_pyrelord` 熔火暴君 (horned
molten giant: fire waves, meteor rain, charge) · `boss_frostlich` 霜骨巫妖 (floating lich: frost novas, ice lances `e_frost`, blizzard, clones).
Enemy projectiles: `e_fireball`, `e_bolt`, `e_web`, `e_bone`, `e_frost`.
Zones: `telegraph_circle`, `telegraph_line` (uses angle,len,width), `poison`, `plague`, `fire`, `frost`, `blizzard`, `arrowrain`,
`lightning_mark`, `meteor_mark`, `e_poison`, `e_fire`, `web`.
Pickups: `xp_s`, `xp_m`, `xp_l` (blue/green/red soul gems), `gold`, `heart`, `magnet`, `bomb`, `chest`.
Shrines: `shrine_power`, `shrine_haste`, `shrine_guard`, `shrine_fortune`.

## view3d.js API
```js
import { createView } from './view3d.js';
const view = createView({ canvas, lowEnd });        // creates renderer/scene; no DOM besides the canvas
view.resize(cssW, cssH, dpr);
view.setStage(stageId); view.setHero(heroId);
view.setMode('menu' | 'game');                      // 'menu': hero idles by a campfire/altar, slow camera orbit (title + hero select backdrop)
view.render(state, events, dt);                     // game mode: draw everything from state; spawn VFX from events (does not clear events)
view.renderMenu(dt);                                // menu mode frame
view.getViewExtents();                              // {halfW, halfH} world units of ground visible around the hero (for spawning off-screen)
view.worldToScreen(x, y, z);                        // → {x, y} CSS px (for DOM overlays)
view.setQuality(q /*0 low..3 high*/); view.getQuality(); view.autoQuality = true;   // built-in adaptive governor like neon-breaker
view.shake(amount); view.flash(color, amount);      // optional hooks main may call
view.dispose();
```

## Game design (LOGIC agent implements; numbers are yours to tune)
- A run: pick hero + stage + difficulty. Timer counts up; waves escalate every 30 s; elites at fixed marks; the stage boss arrives
  at `timeLimit` (8:00). Kill it → win (then optional 無盡 continues with rising difficulty). Death → run summary.
- Player: move + dash (short invulnerable burst, cooldown ~3 s, 1–2 charges via upgrades). Weapons fire automatically.
  Up to 6 weapons + 6 passives; weapons max level 6; passives max level 5; level-up offers 3 choices (4 with luck), limited
  rerolls/banishes/skips. Chests (from elites/bosses) give 1–3 upgrades and are the only way to evolve a weapon.
- Each hero: starting weapon + a unique passive trait + stat spread. knight→sword, mage→firebolt, ranger→arrows,
  necro→minions, berserker→axes.
- Enemies: steering toward the hero with separation (spatial hash; must handle 400+ enemies at 60 fps on phones), contact
  damage with per-enemy cooldown, special behaviours per type above, status effects (burn, poison, freeze/slow).
- Pickups: gems fly to the hero inside pickupR; `magnet` pulls all gems; `bomb` damages everything on screen; `heart` heals.
- Shrines appear occasionally: stand inside for 2 s to claim a 30 s buff.
- Difficulty tiers: 普通 / 噩夢 / 煉獄 / 折磨 (unlocked by clearing the previous tier on any stage): more HP/damage/speed, more elites, better loot.
- Meta progression (saved): gold → permanent talents (生命, 傷害, 冷卻, 移速, 拾取, 經驗, 金幣, 復活, 重抽, 起始等級…) ;
  equipment: 5 slots (武器, 頭盔, 護甲, 戒指, 護符), items drop from elite/boss chests at run end with rarity
  (普通 白 / 魔法 藍 / 稀有 黃 / 傳說 橙) and 1–4 random affixes (e.g. +8% 傷害, +12 生命, +5% 暴擊, +10% 範圍, 冷卻 −4%, 擊殺回復…),
  legendary items carry one unique effect (design ~10). Inventory 40 slots, equip/compare/salvage for gold.
  Heroes `ranger`, `necro`, `berserker` and stages 2–4 unlock through progress. Achievements optional.
- Save everything with KG.store under keys prefixed `abyss:`.
