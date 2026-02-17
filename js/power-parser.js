// Parse power JSON into normalized Power objects for the optimizer

import { scaleToDamage, tableNameToKey } from './damage.js';
import { arcanaTime } from './arcanatime.js';
import { loadPetPower, getRedirectSlugs } from './data.js';

// Damage type attributes that indicate actual damage
const DAMAGE_ATTRIBS = new Set([
  'Smashing_Dmg', 'Lethal_Dmg', 'Fire_Dmg', 'Cold_Dmg',
  'Energy_Dmg', 'Negative_Energy_Dmg', 'Psionic_Dmg', 'Toxic_Dmg'
]);

// Tables used for Defiance self-damage buffs (scale IS the buff percentage)
function isDefianceTable(table) {
  const key = table.toLowerCase();
  return key === 'ranged_ones' || key === 'melee_ones';
}

export async function parsePowers(rawPowers, tables, archetype, powerset, level) {
  const levelIndex = level - 1;
  const namedTables = tables.named_tables;
  const powers = [];

  for (const [slug, data] of Object.entries(rawPowers)) {
    const power = await parseSinglePower(slug, data, namedTables, levelIndex, archetype, powerset);
    if (power && (power.totalDamage > 0 || power.isBuff)) {
      powers.push(power);
    }
  }

  return powers;
}

async function parseSinglePower(slug, data, namedTables, levelIndex, archetype, powerset) {
  // Skip toggle powers (always-on auras like Blazing Aura, Hot Feet)
  if (data.type === 'Toggle') return null;

  const redirects = getRedirectSlugs(slug);
  let damageData = data;
  let castTime = data.activation_time || 0;
  let isRedirected = false;

  // Handle redirect powers (e.g., Blazing Bolt -> quick mode)
  if (redirects && redirects.quick) {
    try {
      const quickData = await loadPetPower(archetype, powerset, redirects.quick);
      damageData = quickData;
      // Use the redirect power's cast time if available, else parent's
      if (quickData.activation_time !== undefined && quickData.activation_time > 0) {
        castTime = quickData.activation_time;
      }
      isRedirected = true;
    } catch (e) {
      console.warn(`Could not load redirect for ${slug}:`, e);
    }
  }

  // Handle Rain of Fire (entity-spawned damage)
  if (redirects && redirects.pet) {
    return await parseRainOfFire(slug, data, namedTables, levelIndex, archetype, powerset, redirects.pet);
  }

  // Extract PvE damage from effects
  const damageComponents = extractDamage(damageData, namedTables, levelIndex);
  const totalDamage = damageComponents.reduce((sum, d) => sum + d.damage, 0);

  // Extract all buff effects (Defiance from attacks, click buffs from Aim/Build Up)
  const buffs = extractBuffs(data, namedTables, levelIndex);

  // Backward-compat: populate defiance field from the first Defiance-style buff
  // Defiance buffs use Ranged_Ones table (scale IS the percentage)
  const defianceBuff = buffs.find(b => isDefianceTable(b.table));
  const defiance = defianceBuff
    ? { scale: defianceBuff.resolvedScale, duration: defianceBuff.duration, stacking: defianceBuff.stacking }
    : null;

  const at = arcanaTime(castTime);

  // A power is a "buff power" if it has damage buffs but deals no damage itself
  const isBuff = totalDamage === 0 && buffs.length > 0;

  const isMelee = damageComponents.some(c => c.table && c.table.toLowerCase().includes('melee'));

  return {
    slug,
    name: data.display_name || data.name || slug,
    castTime,
    arcanaTime: at,
    rechargeTime: data.recharge_time || 0,
    enduranceCost: data.endurance_cost || 0,
    range: data.range || 0,
    effectArea: data.effect_area || 'SingleTarget',
    totalDamage,
    damageComponents,
    dpa: totalDamage / at,
    defiance,
    buffs,
    isBuff,
    isMelee,
    isRedirected,
    maxTargetsHit: (data.max_targets_hit || 0) === 0 ? 1 : data.max_targets_hit,
    availableLevel: data.available_level || 1,
  };
}

async function parseRainOfFire(slug, data, namedTables, levelIndex, archetype, powerset, petSlug) {
  const castTime = data.activation_time || 0;
  const at = arcanaTime(castTime);

  // Rain of Fire spawns a pet that auto-attacks for 15 seconds
  // The pet fires every ~2 seconds, hitting each tick
  // Total damage = pet damage scales * melee_damage table * number of ticks
  let totalDamage = 0;
  try {
    const petData = await loadPetPower(archetype, powerset, petSlug);
    const petDamagePerTick = extractDamage(petData, namedTables, levelIndex);
    const tickDamage = petDamagePerTick.reduce((sum, d) => sum + d.damage, 0);
    // Pet entity lives for 15 seconds, auto-attacks every 2 seconds = ~8 ticks
    // But actually it attacks every tick period which is the pet's activate_period
    // For RoF, the pet fires its auto-attack power periodically
    // Standard RoF: fires every ~2s for 15s duration = ~8 ticks (including initial)
    const entityDuration = 15;
    const tickInterval = 2; // approximate auto-attack interval
    const numTicks = Math.floor(entityDuration / tickInterval) + 1;
    totalDamage = tickDamage * numTicks;
  } catch (e) {
    console.warn('Could not load Rain of Fire pet data:', e);
    totalDamage = 0;
  }

  const buffs = extractBuffs(data, namedTables, levelIndex);
  const defianceBuff = buffs.find(b => isDefianceTable(b.table));
  const defiance = defianceBuff
    ? { scale: defianceBuff.resolvedScale, duration: defianceBuff.duration, stacking: defianceBuff.stacking }
    : null;

  return {
    slug,
    name: data.display_name || data.name || slug,
    castTime,
    arcanaTime: at,
    rechargeTime: data.recharge_time || 0,
    enduranceCost: data.endurance_cost || 0,
    range: data.range || 0,
    effectArea: data.effect_area || 'Location',
    totalDamage,
    damageComponents: [{ type: 'Fire', damage: totalDamage, source: 'pet' }],
    dpa: totalDamage / at,
    defiance,
    buffs,
    isBuff: false,
    isMelee: false,
    isRedirected: false,
    isPetDamage: true,
    maxTargetsHit: 16,
    availableLevel: data.available_level || 1,
  };
}

// Extract all self-damage buff effects from a power.
// Returns an array of buff objects. This covers both:
// - Defiance buffs from attack powers (small scale, Ranged_Ones table)
// - Click buffs like Aim/Build Up (large scale, Melee_Buff_Dmg table)
function extractBuffs(powerData, namedTables, levelIndex) {
  const buffs = [];

  for (const effect of (powerData.effects || [])) {
    if (effect.is_pvp === 'PVP') continue;

    for (const tpl of (effect.templates || [])) {
      const attribs = tpl.attribs || [];
      const hasDamage = attribs.some(a => DAMAGE_ATTRIBS.has(a));
      if (!hasDamage) continue;
      if (tpl.aspect !== 'Strength') continue;
      if (tpl.target !== 'Self') continue;

      const scale = tpl.scale || 0;
      if (scale === 0) continue;

      const table = tpl.table || '';
      const tableKey = tableNameToKey(table);
      const tableValues = namedTables[tableKey];

      // Resolve the actual buff percentage: scale * abs(table[levelIndex])
      // For Defiance (Ranged_Ones): table[49] = 1.0, so resolvedScale = scale
      // For Aim (Melee_Buff_Dmg): table[49] = 0.125, so resolvedScale = scale * 0.125
      const resolvedScale = tableValues
        ? scale * Math.abs(tableValues[levelIndex])
        : scale;

      // Parse duration
      const durationStr = tpl.duration || '0 seconds';
      const match = durationStr.match(/([\d.]+)\s*seconds?/);
      const duration = match ? parseFloat(match[1]) : 0;

      buffs.push({
        attribute: attribs.find(a => DAMAGE_ATTRIBS.has(a)) || attribs[0],
        scale,
        resolvedScale,
        duration,
        stacking: tpl.stack || 'Stack',
        table,
      });
    }
  }
  return buffs;
}

function extractDamage(powerData, namedTables, levelIndex) {
  const components = [];

  for (const effect of (powerData.effects || [])) {
    // Skip PvP-only effects
    if (effect.is_pvp === 'PVP') continue;

    for (const tpl of (effect.templates || [])) {
      const attribs = tpl.attribs || [];
      const hasDamage = attribs.some(a => DAMAGE_ATTRIBS.has(a));
      if (!hasDamage) continue;

      // Skip non-damage effects (Strength aspect = damage buff, not actual damage)
      if (tpl.aspect === 'Strength') continue;

      // Skip PvP damage tables
      const table = tpl.table || '';
      if (table.toLowerCase().includes('pvp')) continue;

      const tableKey = tableNameToKey(table);
      const tableValues = namedTables[tableKey];
      if (!tableValues) continue;

      const scale = tpl.scale || 0;
      if (scale === 0) continue;

      let damage = scaleToDamage(scale, tableValues, levelIndex);

      // Handle DoTs: if application_period > 0, damage ticks multiple times
      const period = tpl.application_period || 0;
      if (period > 0) {
        const durationStr = tpl.duration || '0 seconds';
        const match = durationStr.match(/([\d.]+)\s*seconds?/);
        const duration = match ? parseFloat(match[1]) : 0;
        if (duration > 0) {
          const numTicks = Math.floor(duration / period) + 1;
          damage *= numTicks;
        }
      }

      const damageType = attribs.find(a => DAMAGE_ATTRIBS.has(a)) || 'Unknown';

      components.push({
        type: damageType.replace('_Dmg', ''),
        damage,
        scale,
        table,
      });
    }
  }

  return components;
}
