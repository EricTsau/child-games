# CONTRACT-ADDENDUM (LOGIC agent → view / shell)

Everything in SPEC.md is implemented as written. This file lists only what was ADDED on top of it.
Fields whose name starts with `_` on any state object are internal to core.js — the view must ignore them.

## New ids / kinds that can appear in state or events
- Difficulty ids (`state.difficulty`, `DATA.difficulties`): `normal` 普通 · `nightmare` 噩夢 · `hell` 煉獄 · `torment` 折磨.
- `slash` event kind `bone` — skeleton allies' melee swipe (arc ≈1.4, range ≈1.2).
- `chain` event kind `dark` — `lich` allies (evolution `lichguard`).
- `explode` event kinds: `fire`, `poison` (flask/pool landing), `phys` (golem stomp / boss slam), `dark`.
- `nova` event kinds: `frost`, `holy` (revive), `dark` (shaman heal pulse, legendary `shadowstep` dash nova).
- `strike` event kind `meteor` is also used for the Pyrelord's (enemy) meteor impacts; `light` for thunderstorm and legendary `stormcall`.
- Frost Lich clones: enemies with `type: 'boss_frostlich'`, `boss: false`, `scale ≈ 2.2`, low HP (render as a translucent copy).
- Zones: `fire` and `frost` are enemy-owned (`owner: 'e'`; burning-affix trail / frozen-affix death burst). `blizzard` can be
  player-owned (evolution, follows hero) or enemy-owned (Frost Lich, drifts toward hero). `telegraph_line` also sets `r = len`.
- `slash` events may come with `arc = 2π` (holyblade).

## Extra fields
- `state`: `hero`, `seed`, `endless` (bool), `buffs: [{kind (shrine id), t (s left), max}]`, `rerolls`, `banishes`, `skips`,
  `pendingLevels`, `banished: [ids]`, `chestsOpened`, `elitesKilled`, `bossKilled`, `revives`, `dmgTaken`, `stats` (live stat block).
- `state.player`: `dashCharges` (int), `dashMax` (int).  `dashCd` = seconds until the next charge (0 when full).
- `state.shrines[]`: `progress` (0..1 while standing in it; claim at 1).
- `state.bossHp` may carry an internal `_id`.
- Choice objects (`getChoices()`): also `isNew` (bool); evolution choices carry `from` (base weapon id); gold choices carry `value`.
  `kind` is one of `weapon` | `passive` | `evolution` | `gold` | `heal`. `iconId` for gold/heal: `c_gold` / `c_heal`.
  In phase `chest` the list is the set of rewards; `choose(any)` grants all of them.
- `getSummary()` also returns `passives`, `stage`, `hero`, `difficulty`, `elitesKilled`, `endless`, `dmgTaken`, `goldCollected`,
  `goldBonus` (`gold` = collected + bonus) and `weapons[].dmg` (damage dealt).

## Extra API (core.js exports / game methods)
- `game.continueEndless()` — from phase `win`, keeps playing (無盡); a random boss returns every 150 s.
- `game.getStats()`, `game.weaponStats(id, level)`, `game.debug.{give, spawn, spawnAt, killAll, win, setTime, spawnBoss, chest, heal, god, xp, shrine, pickup, projectiles}` (test hooks).
- Exports: `botInput(game)`, `botPick(game)`, `generateItem(seedOrRng, {difficulty, rarity, minRarity, slot, base, luck})`,
  `itemPower(item)`, `describeAffix(affix)`, `salvageValue(item)`, `talentCost(id, level)`, `mulberry32(seed)`.

## DATA shape
All tables are plain objects keyed by id (each entry also has `id`). `DATA.ids.<table>` gives the ordered id lists.
- `DATA.affixes` = ELITE affixes (`name`, `color`, `desc`). Item affixes are in `DATA.itemAffixes`.
- `DATA.items` = 15 item bases (`slot`, `name`, `iconId`); also `DATA.legendaries` (10), `DATA.rarities`
  (`common` 普通 / `magic` 魔法 / `rare` 稀有 / `legendary` 傳說 with `color`, `affixes` count 1–4), `DATA.slots`
  (`weapon` 武器, `helm` 頭盔, `armor` 護甲, `ring` 戒指, `amulet` 護符), `DATA.difficulties`, `DATA.talents`, `DATA.shrines`.
- `DATA.weapons` contains the 12 base weapons AND the 12 evolutions (`evolved: true`, `from`), each with `name`, `kind`
  (damage kind), `desc`, `iconId` (`w_<id>`), `maxLevel`, `evo`/`evoPassive`.
- `DATA.enemies[*]` has `color`, `r`, `scale`, `fly`, `boss`.
- Item object: `{uid, base, slot, name, rarity, ilvl (difficulty idx), affixes:[{id, v}], legendary (id|null), iconId, power}`.
- `meta` passed to `createGame`: `{talents: {id: level}, equipped: [item, ...]}`.
