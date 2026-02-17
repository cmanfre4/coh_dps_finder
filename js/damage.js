// Damage calculation: scale * abs(modifier_table[level_index])

export function scaleToDamage(scale, tableValues, levelIndex) {
  if (!tableValues || levelIndex < 0 || levelIndex >= tableValues.length) return 0;
  return scale * Math.abs(tableValues[levelIndex]);
}

// Map power JSON table names to modifier table keys
// e.g. "Ranged_Damage" -> "ranged_damage", "Melee_Damage" -> "melee_damage"
export function tableNameToKey(tableName) {
  return tableName.toLowerCase();
}
