// Enhancement system: ED formula, SO values, slot configuration
// Designed for extensibility to per-power slotting and IO sets

// SO Schedule A value: 33.33% per enhancement at even level
const SO_VALUE = 1 / 3;

// Enhancement Diversification (ED) formula for Schedule A
// Input: raw enhancement percentage (e.g., 99.99 for 3x SO)
// Output: effective percentage after diminishing returns
export function edScheduleA(rawPercent) {
  if (rawPercent <= 0) return 0;
  if (rawPercent < 70) return rawPercent;
  if (rawPercent < 90) return 70 + 0.9 * (rawPercent - 70);
  if (rawPercent < 100) return 88 + 0.7 * (rawPercent - 90);
  return 95 + 0.15 * (rawPercent - 100);
}

export function soValue() {
  return SO_VALUE;
}

// Get the default global slot configuration
export function getDefaultSlotConfig() {
  return {
    global: {
      damage: 3,
      recharge: 2,
      accuracy: 0,
      endurance: 0,
    },
    perPower: {},
  };
}

// Calculate post-ED effective percentage for a number of SOs of the same aspect
export function effectiveEnhancement(numSOs) {
  if (numSOs <= 0) return 0;
  const rawPercent = numSOs * SO_VALUE * 100;
  return edScheduleA(rawPercent);
}

// Apply enhancement modifiers to a parsed power object
// Returns a new object with enhanced values (does not mutate original)
export function applyEnhancements(power, slotConfig) {
  const config = (slotConfig.perPower && slotConfig.perPower[power.slug])
    || slotConfig.global;

  const dmgEnhPercent = effectiveEnhancement(config.damage || 0);
  const rechEnhPercent = effectiveEnhancement(config.recharge || 0);

  const dmgMult = 1 + dmgEnhPercent / 100;
  const enhancedDamage = power.totalDamage * dmgMult;

  return {
    ...power,
    totalDamage: enhancedDamage,
    dpa: enhancedDamage / power.arcanaTime,
    damageComponents: power.damageComponents.map(c => ({
      ...c,
      damage: c.damage * dmgMult,
    })),
    // Store enhancement recharge as a percentage for the optimizer
    // e.g., 95.0 means 95% recharge enhancement
    enhRecharge: rechEnhPercent,
    baseTotalDamage: power.totalDamage,
  };
}
