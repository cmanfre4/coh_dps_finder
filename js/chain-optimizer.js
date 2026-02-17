// Attack chain optimizer: finds the highest DPS repeating chain
// Supports greedy and exhaustive search up to chain length 8
// Models Defiance (Blaster inherent) damage buff stacking
// Handles wait time when powers are on cooldown (dead time lowers DPS)

import { arcanaTime } from './arcanatime.js';

const MAX_CHAIN_LENGTH = 8;
const TOP_N = 5;
// Number of full cycles to simulate for Defiance to reach steady state
const DEFIANCE_WARMUP_CYCLES = 3;
// Skip chains where estimated wait time would exceed this multiple of cast time
const MAX_WAIT_RATIO = 3;
// Max results to accumulate before pruning (performance guard)
const MAX_RESULTS_PER_LENGTH = 500;

export function optimizeChains(powers, rechargeReduction, enhancementConfig = null) {
  if (!powers || powers.length === 0) return [];

  const powersWithRecharge = powers.map(p => {
    // Per-power enhancement recharge (from slotted SOs) adds to global recharge in denominator
    const enhRecharge = p.enhRecharge || 0;
    return {
      ...p,
      effectiveRecharge: p.rechargeTime / (1 + enhRecharge / 100 + rechargeReduction / 100),
    };
  });

  const results = [];

  for (let len = 1; len <= Math.min(MAX_CHAIN_LENGTH, 8); len++) {
    searchChains(powersWithRecharge, len, results);
  }

  results.sort((a, b) => b.dps - a.dps);

  const unique = deduplicateChains(results);
  return unique.slice(0, TOP_N);
}

function searchChains(powers, length, results) {
  const indices = new Array(length).fill(0);
  const numPowers = powers.length;
  const totalCombos = Math.pow(numPowers, length);

  // Track best DPS this length to prune weak chains
  let bestDpsThisLength = 0;
  let lengthResults = [];

  for (let combo = 0; combo < totalCombos; combo++) {
    let temp = combo;
    for (let i = length - 1; i >= 0; i--) {
      indices[i] = temp % numPowers;
      temp = Math.floor(temp / numPowers);
    }

    const chain = indices.map(i => powers[i]);

    // Fast path: check strict feasibility (no waits needed)
    // Slow path: if not strictly feasible, check if waits are reasonable
    if (!isChainFeasible(chain) && !isChainWorthSimulating(chain)) continue;

    // Simulate with Defiance buffs and cooldown waits for accurate DPS
    const simResult = simulateChainWithDefiance(chain);

    // Skip if DPS is clearly not competitive (>30% below best for this length)
    if (simResult.dps < bestDpsThisLength * 0.7 && lengthResults.length >= TOP_N) continue;

    if (simResult.dps > bestDpsThisLength) {
      bestDpsThisLength = simResult.dps;
    }

    lengthResults.push({
      powers: chain.map((p, i) => ({
        slug: p.slug,
        name: p.name,
        damage: simResult.perPowerDamage[i],
        baseDamage: p.totalDamage,
        arcanaTime: p.arcanaTime,
        castTime: p.castTime,
        rechargeTime: p.rechargeTime,
        effectiveRecharge: p.effectiveRecharge,
        enduranceCost: p.enduranceCost,
        dpa: simResult.perPowerDamage[i] / p.arcanaTime,
        effectArea: p.effectArea,
        defianceBuff: simResult.perPowerDefianceMult[i],
      })),
      totalDamage: simResult.totalDamage,
      totalTime: simResult.totalTime,
      dps: simResult.dps,
      eps: chain.reduce((sum, p) => sum + p.enduranceCost, 0) / simResult.totalTime,
      length,
      avgDefianceBuff: simResult.avgDefianceMult,
    });

    // Periodic pruning to keep memory bounded
    if (lengthResults.length >= MAX_RESULTS_PER_LENGTH * 2) {
      lengthResults.sort((a, b) => b.dps - a.dps);
      lengthResults = lengthResults.slice(0, MAX_RESULTS_PER_LENGTH);
      bestDpsThisLength = lengthResults[0].dps;
    }
  }

  results.push(...lengthResults);
}

// Simulate a repeating chain with Defiance buff tracking and cooldown waits.
// Runs several cycles to let buffs and cooldowns reach steady state, then measures the last cycle.
function simulateChainWithDefiance(chain) {
  const totalCycles = DEFIANCE_WARMUP_CYCLES + 1; // warmup + 1 measurement cycle

  // Active Defiance buffs: [{slug, scale, expiresAt, stacking}]
  let activeBuffs = [];
  // Cooldown tracking: slug -> absolute time when power becomes available
  const cooldowns = {};
  let currentTime = 0;

  // Per-power results for the measurement cycle
  let measureDamage = [];
  let measureDefianceMult = [];
  let measureStartTime = 0;

  for (let cycle = 0; cycle < totalCycles; cycle++) {
    const isMeasureCycle = cycle === totalCycles - 1;
    if (isMeasureCycle) {
      measureDamage = [];
      measureDefianceMult = [];
      measureStartTime = currentTime;
    }

    for (let i = 0; i < chain.length; i++) {
      const power = chain[i];

      // Wait for power to come off cooldown
      const readyAt = cooldowns[power.slug] || 0;
      if (readyAt > currentTime) {
        currentTime = readyAt;
      }

      // Remove expired buffs
      activeBuffs = activeBuffs.filter(b => b.expiresAt > currentTime);

      // Calculate current Defiance damage multiplier
      const defianceBonus = activeBuffs.reduce((sum, b) => sum + b.scale, 0);
      const defianceMult = 1 + defianceBonus;

      // Apply Defiance to this power's damage
      const effectiveDamage = power.totalDamage * defianceMult;

      if (isMeasureCycle) {
        measureDamage.push(effectiveDamage);
        measureDefianceMult.push(defianceMult);
      }

      // Apply this power's Defiance buff (if any)
      if (power.defiance && power.defiance.scale > 0) {
        const newBuff = {
          slug: power.slug,
          scale: power.defiance.scale,
          expiresAt: currentTime + power.defiance.duration,
          stacking: power.defiance.stacking,
        };

        if (power.defiance.stacking === 'Replace') {
          // Remove existing buffs from same power, add new one
          activeBuffs = activeBuffs.filter(b => b.slug !== power.slug);
          activeBuffs.push(newBuff);
        } else {
          // Stack: just add
          activeBuffs.push(newBuff);
        }
      }

      // Recharge starts from activation (overlaps with cast animation)
      cooldowns[power.slug] = currentTime + power.effectiveRecharge;

      currentTime += power.arcanaTime;
    }
  }

  const totalDamage = measureDamage.reduce((sum, d) => sum + d, 0);
  const totalTime = currentTime - measureStartTime; // actual elapsed time including waits
  const avgMult = measureDefianceMult.reduce((sum, m) => sum + m, 0) / measureDefianceMult.length;

  return {
    totalDamage,
    totalTime,
    dps: totalDamage / totalTime,
    perPowerDamage: measureDamage,
    perPowerDefianceMult: measureDefianceMult,
    avgDefianceMult: avgMult,
  };
}

// Fast geometric feasibility check: can this chain repeat without any waits?
// Checks that the gap between consecutive uses of each power >= its effective recharge.
function isChainFeasible(chain) {
  const totalTime = chain.reduce((sum, p) => sum + p.arcanaTime, 0);

  const usagesBySlug = {};
  let timePos = 0;
  for (let i = 0; i < chain.length; i++) {
    const slug = chain[i].slug;
    if (!usagesBySlug[slug]) usagesBySlug[slug] = [];
    usagesBySlug[slug].push({
      time: timePos,
      recharge: chain[i].effectiveRecharge,
    });
    timePos += chain[i].arcanaTime;
  }

  for (const [slug, usages] of Object.entries(usagesBySlug)) {
    for (let i = 0; i < usages.length; i++) {
      const nextIdx = (i + 1) % usages.length;
      let gap;
      if (nextIdx > i) {
        gap = usages[nextIdx].time - usages[i].time;
      } else {
        gap = (totalTime - usages[i].time) + usages[nextIdx].time;
      }

      if (gap < usages[i].recharge - 0.001) {
        return false;
      }
    }
  }

  return true;
}

// Slower pre-filter for chains that aren't strictly feasible.
// Allows chains with moderate wait times (for low-recharge scenarios).
// For each power appearing K times, the repeating cycle needs at least
// K * effectiveRecharge total time. If that far exceeds the cast time, skip.
function isChainWorthSimulating(chain) {
  const castTime = chain.reduce((sum, p) => sum + p.arcanaTime, 0);

  const counts = {};
  for (const p of chain) {
    if (!counts[p.slug]) counts[p.slug] = { count: 0, recharge: p.effectiveRecharge };
    counts[p.slug].count++;
  }

  for (const { count, recharge } of Object.values(counts)) {
    if (count > 1) {
      const minCycleNeeded = count * recharge;
      if (minCycleNeeded > castTime * MAX_WAIT_RATIO) {
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

  const powersWithRecharge = powers.map(p => {
    const enhRecharge = p.enhRecharge || 0;
    return {
      ...p,
      effectiveRecharge: p.rechargeTime / (1 + enhRecharge / 100 + rechargeReduction / 100),
    };
  });

  const byDpa = [...powersWithRecharge].sort((a, b) => b.dpa - a.dpa);

  const chain = [];
  const cooldowns = {};
  let activeBuffs = [];
  let currentTime = 0;
  let totalDamage = 0;
  let totalTime = 0;

  for (let step = 0; step < maxLength; step++) {
    // Find highest DPA power that's ready, or wait for the soonest one
    let best = null;
    for (const p of byDpa) {
      const cd = cooldowns[p.slug] || 0;
      if (cd <= 0.001) {
        best = p;
        break;
      }
    }

    // Nothing ready — wait for the soonest power to come off cooldown
    if (!best) {
      let soonest = Infinity;
      let soonestPower = null;
      for (const p of byDpa) {
        const cd = cooldowns[p.slug] || 0;
        if (cd < soonest) {
          soonest = cd;
          soonestPower = p;
        }
      }
      if (!soonestPower) break;

      // Wait out the cooldown
      const waitTime = soonest;
      for (const slug of Object.keys(cooldowns)) {
        cooldowns[slug] -= waitTime;
      }
      currentTime += waitTime;
      totalTime += waitTime;
      best = soonestPower;
    }

    // Remove expired buffs and calculate multiplier
    activeBuffs = activeBuffs.filter(b => b.expiresAt > currentTime);
    const defianceBonus = activeBuffs.reduce((sum, b) => sum + b.scale, 0);
    const defianceMult = 1 + defianceBonus;

    const effectiveDamage = best.totalDamage * defianceMult;

    chain.push({ ...best, effectiveDamage, defianceMult });
    totalDamage += effectiveDamage;
    totalTime += best.arcanaTime;

    // Apply Defiance buff
    if (best.defiance && best.defiance.scale > 0) {
      const newBuff = {
        slug: best.slug,
        scale: best.defiance.scale,
        expiresAt: currentTime + best.defiance.duration,
        stacking: best.defiance.stacking,
      };
      if (best.defiance.stacking === 'Replace') {
        activeBuffs = activeBuffs.filter(b => b.slug !== best.slug);
      }
      activeBuffs.push(newBuff);
    }

    cooldowns[best.slug] = best.effectiveRecharge;
    for (const slug of Object.keys(cooldowns)) {
      cooldowns[slug] -= best.arcanaTime;
    }
    currentTime += best.arcanaTime;
  }

  return {
    powers: chain.map(p => ({
      slug: p.slug,
      name: p.name,
      damage: p.effectiveDamage,
      baseDamage: p.totalDamage,
      arcanaTime: p.arcanaTime,
      castTime: p.castTime,
      rechargeTime: p.rechargeTime,
      effectiveRecharge: p.effectiveRecharge,
      enduranceCost: p.enduranceCost,
      dpa: p.effectiveDamage / p.arcanaTime,
      effectArea: p.effectArea,
      defianceBuff: p.defianceMult,
    })),
    totalDamage,
    totalTime,
    dps: totalDamage / totalTime,
    eps: chain.reduce((sum, p) => sum + p.enduranceCost, 0) / totalTime,
    length: chain.length,
    isGreedy: true,
  };
}
