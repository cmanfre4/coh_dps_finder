// Damage calculation: scale * abs(modifier_table[level_index])

export function scaleToDamage(scale, tableValues, levelIndex) {
  if (!tableValues || levelIndex < 0 || levelIndex >= tableValues.length) return 0;
  return scale * Math.abs(tableValues[levelIndex]);
}

// Apply damage enhancement multiplier to base damage
// enhPercent is post-ED percentage (e.g., 95.0 for ~3 SOs)
export function applyDamageEnhancement(baseDamage, enhPercent) {
  return baseDamage * (1 + enhPercent / 100);
}

// Map power JSON table names to modifier table keys
// e.g. "Ranged_Damage" -> "ranged_damage", "Melee_Damage" -> "melee_damage"
export function tableNameToKey(tableName) {
  return tableName.toLowerCase();
}
