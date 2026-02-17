# CLAUDE.md

Project context and domain knowledge for the CoH DPS Attack Chain Calculator.

## Conventions

- **Commits:** Use [Conventional Commits](https://www.conventionalcommits.org/) style — `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, etc.

## City of Data API

Base URL: `https://cod.cohcb.com/homecoming`

### Endpoints

- **Power search index:** `/all_power_search.json` — returns an array of `[displayPath, slugPath]` pairs for all 21k+ powers. Slug paths use dots: `blaster_ranged.fire_blast.flares`
- **Individual power:** `/powers/{category}/{powerset}/{power}.json` — e.g. `/powers/blaster_ranged/fire_blast/flares.json`
- **Archetype modifier tables:** `/tables/{archetype}.json` — e.g. `/tables/blaster.json`. Contains `named_tables` with keys like `ranged_damage`, `melee_damage`, etc. Each table is a 50-element array indexed by level (0 = L1, 49 = L50). Values are **negative**; use `Math.abs()`.
- **Pet/redirect powers:** `/powers/pets/{path}.json` — used for sniper quick modes and entity-spawned damage

There is **no powerset index endpoint**. The URL pattern `/powers/{category}/{powerset}.json` returns 404. Power lists must be derived from `all_power_search.json` or hardcoded.

### Power JSON Structure

Key fields on a power object:
- `activation_time` — cast time in seconds
- `recharge_time` — base recharge in seconds
- `endurance_cost` — endurance cost
- `range` — range in feet
- `effect_area` — `SingleTarget`, `AoE`, `Cone`, `Location`
- `effects[]` — array of effect groups, each containing `templates[]`
- `redirect[]` — array of `{name, condition_expression}` for powers that redirect (e.g. sniper engaged mode)

### Effect Templates

Each template in `effects[].templates[]` has:
- `attribs[]` — what the effect modifies (e.g. `Fire_Dmg`, `RunningSpeed`)
- `type` — usually `Magnitude`
- `aspect` — **critical field**:
  - `Absolute` = direct damage/value
  - `Strength` = a buff/debuff modifier (e.g. Defiance damage buff). **Not direct damage.**
- `table` — which modifier table to look up (e.g. `Ranged_Damage`, `Melee_Damage`)
- `scale` — multiplier applied to the table value
- `duration` — string like `"3.1 seconds"` or `"0 seconds"`
- `application_period` — tick interval for DoTs (0 = instant/one-shot)
- `target` — `Self`, `AnyAffected`, etc.
- `stack` — `Stack` (accumulates) or `Replace` (newest replaces oldest from same source)
- `params.type` — `EntCreate` for entity-spawning effects (like Rain of Fire)

### Damage Attributes

These `attribs` values indicate actual damage: `Smashing_Dmg`, `Lethal_Dmg`, `Fire_Dmg`, `Cold_Dmg`, `Energy_Dmg`, `Negative_Energy_Dmg`, `Psionic_Dmg`, `Toxic_Dmg`.

## Damage Calculation

### Base Formula

```
actual_damage = scale * abs(modifier_table[level_index])
```

- `level_index` = level - 1 (0-indexed)
- Blaster Ranged Damage at L50: `abs(ranged_damage[49])` = **62.5615**
- Validated: Flares L50 = `(0.71 + 0.3) * 62.5615 = 63.19`

### Table Name Mapping

The `table` field in effect templates maps directly to `named_tables` keys by lowercasing:
- `Ranged_Damage` → `ranged_damage`
- `Melee_Damage` → `melee_damage`
- `Ranged_PvPDamage` → `ranged_pvpdamage` (skip these for PvE)
- `Ranged_Ones` → `ranged_ones` (L50 value = 1.0, used for Defiance buffs where scale = the buff percentage)

### DoT Handling

If `application_period > 0`, the damage ticks multiple times:
```
num_ticks = floor(duration / application_period) + 1
total_damage = per_tick_damage * num_ticks
```

Example: Fire Blast DoT has scale=0.15, duration=3.1s, period=1.0s → 4 ticks → total scale contribution = 0.6.

### Filtering Rules

1. **Skip `aspect: Strength`** — these are damage buffs (Defiance), not direct damage
2. **Skip PvP tables** — any table name containing `pvp` (case-insensitive)
3. **Skip `is_pvp: PVP`** effects — PvP-only effect groups

## ArcanaTime

Server tick-corrected animation time:
```
arcanaTime = (ceil(castTime / 0.132) + 1) * 0.132
```

- Server tick = 0.132 seconds
- Validated: Flares(1.0s) → **1.188s**, Fire Blast(1.67s) → **1.848s**
- Instant cast (0s) → 0.132s (1 tick minimum)

## Defiance (Blaster Inherent)

Each Blaster attack applies a self-damage buff. These are found in effect templates with `aspect: Strength`, `target: Self`, and damage attribs. The `Ranged_Ones` table at L50 = 1.0, so the `scale` value IS the buff percentage directly.

| Power | Scale (= buff %) | Duration | Stacking |
|-------|-------------------|----------|----------|
| Flares | 0.066 (6.6%) | 8.5s | Stack |
| Fire Blast | 0.110 (11.0%) | 9.17s | Stack |
| Blaze | 0.066 (6.6%) | 8.5s | Stack |
| Blazing Bolt | 0 | - | - |
| Fire Ball | 0.020 (2.0%) | 8.5s | Replace |
| Fire Breath | 0.082 (8.2%) | 10.17s | Replace |
| Inferno | 0.042 (4.2%) | 10.5s | Replace |
| Rain of Fire | 0.028 (2.8%) | 9.53s | Replace |

- **Stack** = multiple uses of the same power accumulate separate buff instances
- **Replace** = new use of the same power replaces the previous instance from that power
- Different powers always coexist (Flares buff + Fire Blast buff both active simultaneously)
- ST powers generally grant larger Defiance buffs than AoE powers

## Redirect Powers (Sniper Quick Mode)

Blazing Bolt has no effects directly — it uses the `redirect` field:
- **Engaged/quick mode:** `Pets.Blaster_Fire_Snipe.Blazing_Bolt_Quick` (1.67s cast, used in combat)
- **Normal mode:** `Pets.Blaster_Fire_Snipe.Blazing_Bolt_Normal` (3.67s cast, out of combat)

Fetch redirect power data from: `/powers/pets/blaster_fire_snipe/blazing_bolt_quick.json`

The calculator assumes in-combat (quick mode) since we're optimizing sustained DPS chains.

## Rain of Fire (Entity-Spawned Damage)

Rain of Fire creates a `Pets_RainofFire` entity (found via `params.type: EntCreate`). The pet's attack power is at `/powers/pets/rainoffire/rainoffire.json` and uses `Melee_Damage` table (not Ranged). The pet auto-attacks every ~2s for 15s = ~8 ticks of small damage (scales: 0.03 + 0.003 + 0.027 per tick).

## Chain Optimization

- **Effective recharge:** `baseRecharge / (1 + rechargeBonus / 100)`
- **Chain DPS:** `sum(damages) / sum(arcanaTimes)` for one cycle
- **Feasibility:** In a repeating cycle, the gap between consecutive uses of the same power must be ≥ its effective recharge
- **Defiance simulation:** Run 3 warmup cycles to reach steady-state buff stacks, measure the 4th cycle
- Exhaustive search up to chain length 8 with all powers competing equally regardless of target type

## Enhancement System

### Enhancement Diversification (ED)

Diminishing returns when stacking the same enhancement aspect:
- `E < 70%`: full value
- `70% ≤ E < 90%`: `70 + 0.9 × (E - 70)`
- `90% ≤ E < 100%`: `88 + 0.7 × (E - 90)`
- `E ≥ 100%`: `95 + 0.15 × (E - 100)`

### SO Schedule A

Each SO provides 33.33% (1/3) enhancement. Common slotting:
- 3 Damage SOs: 99.99% raw → ~95.0% post-ED
- 3 Recharge SOs: 99.99% raw → ~95.0% post-ED
- 2 SOs: 66.66% raw → 66.66% post-ED (under threshold, no reduction)

### Application Order

1. Parse base power stats
2. Apply per-power enhancement modifiers → `enhancedDamage`, `enhRecharge`
3. Apply global recharge bonus (from set bonuses, Hasten, incarnate)
4. Effective recharge: `baseRecharge / (1 + enhRecharge/100 + globalRecharge/100)`
5. Enhanced damage: `baseDamage * (1 + dmgEnhPercent/100)`

### Architecture

- `js/enhancements.js` — ED formula, SO values, slot config, `applyEnhancements()`
- Slot config structure supports per-power overrides: `{ global: {damage, recharge, ...}, perPower: {} }`
- Enhancement recharge is per-power (from SOs), global recharge is from external sources — both additive in denominator

## Procs (Future)

Proc enhancements (Invention Origin "Proc" IOs) add a chance for bonus damage on power activation. They are slotted like regular enhancements but instead of boosting an aspect, they have a % chance to fire extra damage.

### Proc Per Minute (PPM) Formula

Modern procs use the PPM system. The chance to fire depends on the power's properties:

```
proc_chance = PPM × (recharge_time + cast_time) / (60 × area_factor)
```

- `PPM` — the proc's rate (e.g., 3.5 PPM for most damage procs)
- `recharge_time` — the power's **base** recharge (before any recharge bonuses)
- `cast_time` — the power's activation time
- `area_factor` — 1.0 for SingleTarget, scales up for AoE (based on radius/arc)
- Proc chance is capped at 90%

### Key Implications for the Optimizer

- Procs favor powers with **long base recharge** and **long cast times** (higher proc chance)
- Procs favor **single-target** powers over AoE (area_factor = 1 vs higher)
- Some powers become "proc mules" — slotted primarily for procs rather than base damage
- Procs take enhancement slots, competing with damage/recharge SOs
- Per-power slotting becomes essential (some powers get 5 procs + 1 acc, others stay SO-heavy)
- Recharge bonuses do NOT affect proc chance (formula uses base recharge), but they DO affect how often you can use the power — this creates a tension between proc rate and power cycling

### Common Damage Procs

- Apocalypse: 3.5 PPM, Negative Energy damage
- Armageddon: 3.5 PPM, Fire damage
- Gladiator's Javelin: 3.5 PPM, Lethal damage (ranged)
- Many others across various IO sets

### Architecture Considerations

- Requires per-power slotting (can't globally assign procs)
- Each proc needs: PPM value, damage amount, damage type
- Need area_factor calculation per power (from effect_area + radius/arc data)
- Proc damage is added as a separate damage component (not enhanced by damage SOs)
- Slot budget becomes a constrained optimization: N damage SOs + M procs + accuracy ≤ 6
