// Web Worker for attack chain optimization
// Runs heavy computation off the main thread to prevent UI freezing
// Self-contained: no ES module imports (Web Workers have limited module support)

const MAX_CHAIN_LENGTH = 8;
const TOP_N = 5;
const DEFIANCE_WARMUP_CYCLES = 3;
const MAX_WAIT_RATIO = 3;
const MAX_RESULTS_PER_LENGTH = 500;
// Skip chain lengths where total combos exceed this (perf guard)
const MAX_COMBOS_PER_LENGTH = 2_000_000;
// Prune any chain whose DPA upper bound is below this fraction of best DPS found
const DPS_PRUNE_RATIO = 0.65;
// Report progress every N combos
const PROGRESS_INTERVAL = 50_000;

self.onmessage = function(e) {
  const { powers, rechargeReduction, activationLatency } = e.data;

  try {
    const result = optimizeChains(powers, rechargeReduction, activationLatency || 0);
    self.postMessage({ type: 'result', chains: result });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};

function optimizeChains(powers, rechargeReduction, activationLatency) {
  if (!powers || powers.length === 0) return [];

  const powersWithRecharge = powers.map(p => {
    const enhRecharge = p.enhRecharge || 0;
    return {
      ...p,
      effectiveRecharge: p.rechargeTime / (1 + enhRecharge / 100 + rechargeReduction / 100),
      // Activation latency adds dead time after each power activation
      // This models human reaction time, input delay, and animation queue gaps
      activationLatency,
    };
  });

  // Pre-compute the best possible DPA (upper bound for pruning)
  const maxDpa = Math.max(...powersWithRecharge.map(p => p.dpa || 0));

  const results = [];
  let globalBestDps = 0;

  for (let len = 1; len <= MAX_CHAIN_LENGTH; len++) {
    const numPowers = powersWithRecharge.length;
    const totalCombos = Math.pow(numPowers, len);

    // Skip chain lengths that would take too long
    if (totalCombos > MAX_COMBOS_PER_LENGTH) {
      self.postMessage({
        type: 'progress',
        length: len,
        skipped: true,
        reason: `${totalCombos.toLocaleString()} combos — skipped`,
      });
      continue;
    }

    self.postMessage({
      type: 'progress',
      length: len,
      totalCombos,
      checked: 0,
    });

    const lengthResult = searchChains(powersWithRecharge, len, totalCombos, maxDpa, globalBestDps);
    results.push(...lengthResult.chains);

    if (lengthResult.bestDps > globalBestDps) {
      globalBestDps = lengthResult.bestDps;
    }
  }

  results.sort((a, b) => b.dps - a.dps);
  const unique = deduplicateChains(results);
  // Rotate each chain to start from highest DPA power for readable display
  return unique.slice(0, TOP_N).map(rotateChainToHighestDpa);
}

function searchChains(powers, length, totalCombos, maxDpa, globalBestDps) {
  const indices = new Array(length).fill(0);
  const numPowers = powers.length;

  let bestDpsThisLength = globalBestDps;
  let lengthResults = [];
  let checked = 0;

  for (let combo = 0; combo < totalCombos; combo++) {
    let temp = combo;
    for (let i = length - 1; i >= 0; i--) {
      indices[i] = temp % numPowers;
      temp = Math.floor(temp / numPowers);
    }

    const chain = indices.map(i => powers[i]);

    // Quick DPA upper bound: even if this chain had zero wait time,
    // could it beat the best we've found?
    if (bestDpsThisLength > 0) {
      const totalDamage = chain.reduce((sum, p) => sum + p.totalDamage, 0);
      const totalCastTime = chain.reduce((sum, p) => sum + p.arcanaTime, 0);
      // Best case: no waits, max defiance bonus (~30% for well-buffed)
      const upperBoundDps = (totalDamage * 1.3) / totalCastTime;
      if (upperBoundDps < bestDpsThisLength * DPS_PRUNE_RATIO) continue;
    }

    // Feasibility filters
    if (!isChainFeasible(chain) && !isChainWorthSimulating(chain)) continue;

    const simResult = simulateChainWithDefiance(chain);

    checked++;

    // Report progress periodically
    if (checked % PROGRESS_INTERVAL === 0) {
      self.postMessage({
        type: 'progress',
        length,
        totalCombos,
        checked,
        bestDps: bestDpsThisLength,
      });
    }

    // Skip if clearly not competitive
    if (simResult.dps < bestDpsThisLength * DPS_PRUNE_RATIO && lengthResults.length >= TOP_N) continue;

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

    // Periodic pruning
    if (lengthResults.length >= MAX_RESULTS_PER_LENGTH * 2) {
      lengthResults.sort((a, b) => b.dps - a.dps);
      lengthResults = lengthResults.slice(0, MAX_RESULTS_PER_LENGTH);
      bestDpsThisLength = lengthResults[0].dps;
    }
  }

  return { chains: lengthResults, bestDps: bestDpsThisLength };
}

function simulateChainWithDefiance(chain) {
  const totalCycles = DEFIANCE_WARMUP_CYCLES + 1;

  let activeBuffs = [];
  const cooldowns = {};
  let currentTime = 0;

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
          activeBuffs = activeBuffs.filter(b => b.slug !== power.slug);
          activeBuffs.push(newBuff);
        } else {
          activeBuffs.push(newBuff);
        }
      }

      cooldowns[power.slug] = currentTime + power.effectiveRecharge;
      currentTime += power.arcanaTime + (power.activationLatency || 0);
    }
  }

  const totalDamage = measureDamage.reduce((sum, d) => sum + d, 0);
  const totalTime = currentTime - measureStartTime;
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

function isChainFeasible(chain) {
  const latency = chain[0]?.activationLatency || 0;
  const totalTime = chain.reduce((sum, p) => sum + p.arcanaTime + latency, 0);

  const usagesBySlug = {};
  let timePos = 0;
  for (let i = 0; i < chain.length; i++) {
    const slug = chain[i].slug;
    if (!usagesBySlug[slug]) usagesBySlug[slug] = [];
    usagesBySlug[slug].push({
      time: timePos,
      recharge: chain[i].effectiveRecharge,
    });
    timePos += chain[i].arcanaTime + latency;
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

function isChainWorthSimulating(chain) {
  const latency = chain[0]?.activationLatency || 0;
  const castTime = chain.reduce((sum, p) => sum + p.arcanaTime + latency, 0);

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

// Rotate a chain result so it starts from the highest DPA power.
// Since it's a repeating cycle, rotation doesn't change DPS —
// this just makes the display read naturally (best attack first).
function rotateChainToHighestDpa(chain) {
  const powers = chain.powers;
  if (powers.length <= 1) return chain;

  // Find index of highest DPA power
  let bestIdx = 0;
  let bestDpa = powers[0].dpa;
  for (let i = 1; i < powers.length; i++) {
    if (powers[i].dpa > bestDpa) {
      bestDpa = powers[i].dpa;
      bestIdx = i;
    }
  }

  if (bestIdx === 0) return chain;

  // Rotate powers array
  const rotated = powers.slice(bestIdx).concat(powers.slice(0, bestIdx));
  return { ...chain, powers: rotated };
}
