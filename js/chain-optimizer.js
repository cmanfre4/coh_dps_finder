// Attack chain optimizer: finds the highest DPS repeating chain
// Supports greedy and exhaustive search up to chain length 8

import { arcanaTime } from './arcanatime.js';

const MAX_CHAIN_LENGTH = 8;
const TOP_N = 5;

export function optimizeChains(powers, rechargeReduction) {
  if (!powers || powers.length === 0) return [];

  // Calculate effective recharge for each power
  const powersWithRecharge = powers.map(p => ({
    ...p,
    effectiveRecharge: p.rechargeTime / (1 + rechargeReduction / 100),
  }));

  const results = [];

  // Exhaustive search for chains of length 1 to MAX_CHAIN_LENGTH
  for (let len = 1; len <= Math.min(MAX_CHAIN_LENGTH, 8); len++) {
    searchChains(powersWithRecharge, len, results);
  }

  // Sort by DPS descending and return top N
  results.sort((a, b) => b.dps - a.dps);

  // Deduplicate chains that are rotations of each other
  const unique = deduplicateChains(results);
  return unique.slice(0, TOP_N);
}

function searchChains(powers, length, results) {
  const indices = new Array(length).fill(0);
  const numPowers = powers.length;
  const totalCombos = Math.pow(numPowers, length);

  for (let combo = 0; combo < totalCombos; combo++) {
    // Decode combo into power indices
    let temp = combo;
    for (let i = length - 1; i >= 0; i--) {
      indices[i] = temp % numPowers;
      temp = Math.floor(temp / numPowers);
    }

    const chain = indices.map(i => powers[i]);

    // Check feasibility: each power must be off cooldown when needed
    if (!isChainFeasible(chain)) continue;

    // Calculate DPS
    const totalDamage = chain.reduce((sum, p) => sum + p.totalDamage, 0);
    const totalTime = chain.reduce((sum, p) => sum + p.arcanaTime, 0);
    const dps = totalDamage / totalTime;
    const eps = chain.reduce((sum, p) => sum + p.enduranceCost, 0) / totalTime;

    results.push({
      powers: chain.map(p => ({
        slug: p.slug,
        name: p.name,
        damage: p.totalDamage,
        arcanaTime: p.arcanaTime,
        castTime: p.castTime,
        rechargeTime: p.rechargeTime,
        effectiveRecharge: p.effectiveRecharge,
        enduranceCost: p.enduranceCost,
        dpa: p.dpa,
        effectArea: p.effectArea,
      })),
      totalDamage,
      totalTime,
      dps,
      eps,
      length,
    });
  }
}

function isChainFeasible(chain) {
  // For a repeating chain, check that each power has enough time
  // to recharge before it's needed again.
  // Track the time position of each power usage.
  const totalTime = chain.reduce((sum, p) => sum + p.arcanaTime, 0);

  // For each power, find all positions where it appears and check
  // that the gap between consecutive uses >= effectiveRecharge.
  const usagesBySlug = {};
  let timePos = 0;
  for (let i = 0; i < chain.length; i++) {
    const slug = chain[i].slug;
    if (!usagesBySlug[slug]) usagesBySlug[slug] = [];
    usagesBySlug[slug].push({
      time: timePos,
      recharge: chain[i].effectiveRecharge,
      arcanaTime: chain[i].arcanaTime,
    });
    timePos += chain[i].arcanaTime;
  }

  for (const [slug, usages] of Object.entries(usagesBySlug)) {
    for (let i = 0; i < usages.length; i++) {
      // Time until next use of the same power (wrapping around the cycle)
      const nextIdx = (i + 1) % usages.length;
      let gap;
      if (nextIdx > i) {
        gap = usages[nextIdx].time - usages[i].time;
      } else {
        // Wraps around: time to end of cycle + time to next use in next cycle
        gap = (totalTime - usages[i].time) + usages[nextIdx].time;
      }

      // The power starts recharging after its cast begins (at its time position)
      // It needs to be ready by the next time it's used
      // Recharge starts at time of activation
      if (gap < usages[i].recharge - 0.001) {
        return false;
      }
    }
  }

  return true;
}

function deduplicateChains(chains) {
  const seen = new Set();
  const unique = [];

  for (const chain of chains) {
    const key = normalizeChainKey(chain.powers.map(p => p.slug));
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(chain);
    }
  }

  return unique;
}

function normalizeChainKey(slugs) {
  // A chain is a cycle, so [A, B, C] == [B, C, A] == [C, A, B]
  // Find the lexicographically smallest rotation
  const doubled = slugs.concat(slugs);
  let best = slugs.join(',');
  for (let i = 1; i < slugs.length; i++) {
    const rotation = doubled.slice(i, i + slugs.length).join(',');
    if (rotation < best) best = rotation;
  }
  return best;
}

// Greedy chain builder for quick results
export function greedyChain(powers, rechargeReduction, maxLength = 20) {
  if (!powers || powers.length === 0) return null;

  const powersWithRecharge = powers.map(p => ({
    ...p,
    effectiveRecharge: p.rechargeTime / (1 + rechargeReduction / 100),
  }));

  // Sort by DPA descending for initial priority
  const byDpa = [...powersWithRecharge].sort((a, b) => b.dpa - a.dpa);

  const chain = [];
  const cooldowns = {}; // slug -> time until available
  let totalDamage = 0;
  let totalTime = 0;

  for (let step = 0; step < maxLength; step++) {
    // Find the best available power (highest DPA that's off cooldown)
    let best = null;
    for (const p of byDpa) {
      const cd = cooldowns[p.slug] || 0;
      if (cd <= 0.001) {
        best = p;
        break;
      }
    }

    if (!best) break; // No powers available (shouldn't happen with Flares-like power)

    chain.push(best);
    totalDamage += best.totalDamage;
    totalTime += best.arcanaTime;

    // Put this power on cooldown
    cooldowns[best.slug] = best.effectiveRecharge;

    // Reduce all cooldowns by the time this power takes
    for (const slug of Object.keys(cooldowns)) {
      cooldowns[slug] -= best.arcanaTime;
    }
  }

  return {
    powers: chain.map(p => ({
      slug: p.slug,
      name: p.name,
      damage: p.totalDamage,
      arcanaTime: p.arcanaTime,
      castTime: p.castTime,
      rechargeTime: p.rechargeTime,
      effectiveRecharge: p.effectiveRecharge,
      enduranceCost: p.enduranceCost,
      dpa: p.dpa,
      effectArea: p.effectArea,
    })),
    totalDamage,
    totalTime,
    dps: totalDamage / totalTime,
    eps: chain.reduce((sum, p) => sum + p.enduranceCost, 0) / totalTime,
    length: chain.length,
    isGreedy: true,
  };
}
