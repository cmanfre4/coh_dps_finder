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

// Buff overlay: skip first N buff cycles as warmup, measure the rest
const BUFF_WARMUP_CYCLES = 2;
const BUFF_MEASURE_CYCLES = 3;

self.onmessage = function(e) {
  const { powers, buffPowers, rechargeReduction, activationLatency, numTargets } = e.data;

  try {
    const rangedPowers = powers.filter(p => !p.isMelee);
    const allPowers = powers;

    self.postMessage({ type: 'pass', pass: 'ranged' });
    const rangedChains = optimizeChains(rangedPowers, buffPowers || [], rechargeReduction, activationLatency || 0, 'Ranged');

    self.postMessage({ type: 'pass', pass: 'hybrid' });
    const hybridChains = optimizeChains(allPowers, buffPowers || [], rechargeReduction, activationLatency || 0, 'Hybrid');

    let aoeChains = null;
    const nt = numTargets || 1;
    if (nt > 1) {
      // Scale each power's damage by targets hit: min(numTargets, maxTargetsHit)
      // ST powers get 1x (valid fillers between AoE cooldowns), AoE powers get Nx
      const aoePowers = allPowers.map(p => {
        const targetsHit = Math.min(nt, p.maxTargetsHit || 1);
        return {
          ...p,
          totalDamage: p.totalDamage * targetsHit,
          dpa: (p.totalDamage * targetsHit) / p.arcanaTime,
          _aoeDamageMultiplier: targetsHit,
          _originalDamage: p.totalDamage,
        };
      });

      self.postMessage({ type: 'pass', pass: `AoE (${nt}t)` });
      aoeChains = optimizeChains(aoePowers, buffPowers || [], rechargeReduction, activationLatency || 0, `AoE (${nt}t)`, 10);

      // Annotate chain powers with targets hit info
      if (aoeChains) {
        for (const chain of aoeChains) {
          for (const p of chain.powers) {
            const src = allPowers.find(s => s.slug === p.slug);
            const maxHit = (src && src.maxTargetsHit) || 1;
            p.targetsHit = Math.min(nt, maxHit);
            p.maxTargetsHit = maxHit;
          }
        }
      }
    }

    self.postMessage({ type: 'result', rangedChains, hybridChains, aoeChains, numTargets: nt });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};

function optimizeChains(powers, buffPowers, rechargeReduction, activationLatency, passLabel, topN) {
  topN = topN || TOP_N;
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

  // Prepare buff powers with effective recharge
  const preparedBuffs = buffPowers.map(p => {
    const enhRecharge = p.enhRecharge || 0;
    return {
      ...p,
      effectiveRecharge: p.rechargeTime / (1 + enhRecharge / 100 + rechargeReduction / 100),
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
        pass: passLabel,
        length: len,
        skipped: true,
        reason: `${totalCombos.toLocaleString()} combos — skipped`,
      });
      continue;
    }

    self.postMessage({
      type: 'progress',
      pass: passLabel,
      length: len,
      totalCombos,
      checked: 0,
    });

    const lengthResult = searchChains(powersWithRecharge, len, totalCombos, maxDpa, globalBestDps, passLabel, topN);
    results.push(...lengthResult.chains);

    if (lengthResult.bestDps > globalBestDps) {
      globalBestDps = lengthResult.bestDps;
    }
  }

  results.sort((a, b) => b.dps - a.dps);
  const unique = deduplicateChains(results);
  const topChains = unique.slice(0, topN).map(rotateChainToHighestDpa);

  // Apply buff overlay to top chains if there are buff powers
  if (preparedBuffs.length > 0) {
    for (const chain of topChains) {
      const overlay = simulateChainWithBuffOverlay(chain, preparedBuffs, activationLatency);
      chain.buffedDps = overlay.dpsWithBuffs;
      chain.buffUptime = overlay.buffUptime;
      chain.avgBuffMult = overlay.avgBuffMult;
      chain.buffPowerNames = preparedBuffs.map(p => p.name);
    }
    // Re-sort by buffed DPS
    topChains.sort((a, b) => (b.buffedDps || b.dps) - (a.buffedDps || a.dps));
  }

  return topChains;
}

function searchChains(powers, length, totalCombos, maxDpa, globalBestDps, passLabel, topN) {
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
        pass: passLabel,
        length,
        totalCombos,
        checked,
        bestDps: bestDpsThisLength,
      });
    }

    // Skip if clearly not competitive
    if (simResult.dps < bestDpsThisLength * DPS_PRUNE_RATIO && lengthResults.length >= topN) continue;

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
        defiance: p.defiance,
      })),
      totalDamage: simResult.totalDamage,
      totalTime: simResult.totalTime,
      dps: simResult.dps,
      eps: chain.reduce((sum, p) => sum + p.enduranceCost, 0) / simResult.totalTime,
      length,
      avgDefianceBuff: simResult.avgDefianceMult,
      timeline: simResult.events,
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
  let measureEvents = [];

  for (let cycle = 0; cycle < totalCycles; cycle++) {
    const isMeasureCycle = cycle === totalCycles - 1;
    if (isMeasureCycle) {
      measureDamage = [];
      measureDefianceMult = [];
      measureEvents = [];
      measureStartTime = currentTime;
    }

    for (let i = 0; i < chain.length; i++) {
      const power = chain[i];

      // Wait for power to come off cooldown
      const readyAt = cooldowns[power.slug] || 0;
      const waitBefore = readyAt > currentTime ? readyAt - currentTime : 0;
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
        measureEvents.push({
          slug: power.slug,
          name: power.name,
          startTime: currentTime - measureStartTime,
          endTime: currentTime - measureStartTime + power.arcanaTime,
          waitBefore,
          damage: effectiveDamage,
          defianceMult,
        });
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
    events: measureEvents,
  };
}

// Buff Overlay: simulate the attack chain over a long period with buff powers
// (Aim, Build Up) fired on cooldown, interrupting the chain.
// Tracks both Defiance and click buffs together for accurate interaction.
function simulateChainWithBuffOverlay(chainResult, buffPowers, activationLatency) {
  if (!buffPowers || buffPowers.length === 0) {
    return { dpsWithBuffs: chainResult.dps, buffUptime: 0, avgBuffMult: 1.0 };
  }

  const chainPowers = chainResult.powers;
  const chainLength = chainPowers.length;

  // Find the longest buff effective recharge to determine simulation length
  const maxBuffRecharge = Math.max(...buffPowers.map(p => p.effectiveRecharge));
  const totalBuffCycles = BUFF_WARMUP_CYCLES + BUFF_MEASURE_CYCLES;
  const simDuration = maxBuffRecharge * totalBuffCycles;
  const measureStartTime = maxBuffRecharge * BUFF_WARMUP_CYCLES;

  // Build buff power info with resolved buff data
  const buffInfos = buffPowers.map(p => {
    // Find the click damage buff (not Defiance — exclude Ranged_Ones and Melee_Ones tables)
    const isDefianceTable = t => {
      const key = t.toLowerCase();
      return key === 'ranged_ones' || key === 'melee_ones';
    };
    const dmgBuff = (p.buffs || []).find(b =>
      !isDefianceTable(b.table)
    ) || (p.buffs || [])[0];

    return {
      slug: p.slug,
      name: p.name,
      arcanaTime: p.arcanaTime,
      effectiveRecharge: p.effectiveRecharge,
      buffScale: dmgBuff ? dmgBuff.resolvedScale : 0,
      buffDuration: dmgBuff ? dmgBuff.duration : 0,
      buffStacking: dmgBuff ? dmgBuff.stacking : 'Stack',
    };
  });

  let currentTime = 0;
  let chainIndex = 0;
  let defianceBuffs = []; // Defiance buffs from attacks
  let clickBuffs = []; // Click buffs from Aim/Build Up
  const buffCooldowns = {}; // slug -> readyAt
  const attackCooldowns = {}; // slug -> readyAt

  // Measurement accumulators
  let measureDamage = 0;
  let measureStartActual = -1;
  let clickBuffActiveTime = 0;

  for (const buff of buffInfos) {
    buffCooldowns[buff.slug] = 0;
  }

  while (currentTime < simDuration) {
    const isMeasuring = currentTime >= measureStartTime;
    if (isMeasuring && measureStartActual < 0) {
      measureStartActual = currentTime;
    }

    // Fire any ready buff powers before the next attack
    for (const buff of buffInfos) {
      if (buffCooldowns[buff.slug] <= currentTime && buff.buffScale > 0) {
        const buffTime = buff.arcanaTime + (activationLatency || 0);
        currentTime += buffTime;

        // Apply the click buff
        if (buff.buffStacking === 'Replace') {
          clickBuffs = clickBuffs.filter(b => b.slug !== buff.slug);
        }
        clickBuffs.push({
          slug: buff.slug,
          scale: buff.buffScale,
          expiresAt: currentTime + buff.buffDuration,
        });

        buffCooldowns[buff.slug] = currentTime + buff.effectiveRecharge;
      }
    }

    // Fire next attack in chain
    const power = chainPowers[chainIndex % chainLength];
    chainIndex++;

    // Wait for cooldown
    const readyAt = attackCooldowns[power.slug] || 0;
    if (readyAt > currentTime) {
      currentTime = readyAt;
    }

    // Remove expired buffs
    defianceBuffs = defianceBuffs.filter(b => b.expiresAt > currentTime);
    clickBuffs = clickBuffs.filter(b => b.expiresAt > currentTime);

    // Calculate total multiplier: Defiance + click buffs (additive)
    const defianceBonus = defianceBuffs.reduce((sum, b) => sum + b.scale, 0);
    const clickBuffBonus = clickBuffs.reduce((sum, b) => sum + b.scale, 0);
    const totalMult = 1 + defianceBonus + clickBuffBonus;

    const effectiveDamage = power.baseDamage * totalMult;
    const attackTime = power.arcanaTime + (activationLatency || 0);

    if (isMeasuring) {
      measureDamage += effectiveDamage;
      if (clickBuffBonus > 0) clickBuffActiveTime += attackTime;
    }

    // Apply this power's Defiance buff
    if (power.defiance && power.defiance.scale > 0) {
      if (power.defiance.stacking === 'Replace') {
        defianceBuffs = defianceBuffs.filter(b => b.slug !== power.slug);
      }
      defianceBuffs.push({
        slug: power.slug,
        scale: power.defiance.scale,
        expiresAt: currentTime + power.defiance.duration,
      });
    }

    attackCooldowns[power.slug] = currentTime + power.effectiveRecharge;
    currentTime += attackTime;
  }

  const totalMeasureTime = currentTime - (measureStartActual >= 0 ? measureStartActual : measureStartTime);
  const dpsWithBuffs = totalMeasureTime > 0 ? measureDamage / totalMeasureTime : chainResult.dps;
  const buffUptime = totalMeasureTime > 0 ? clickBuffActiveTime / totalMeasureTime : 0;

  // Average click buff multiplier during measurement
  const totalClickScale = buffInfos.reduce((sum, b) => sum + b.buffScale, 0);
  const avgBuffMult = 1 + totalClickScale * buffUptime;

  return {
    dpsWithBuffs,
    buffUptime,
    avgBuffMult,
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
  // Reduce to minimal repeating unit, then sort to ignore rotation/order
  const minimal = minimalRepeatingUnit(slugs);
  return minimal.slice().sort().join(',');
}

function minimalRepeatingUnit(arr) {
  const n = arr.length;
  for (let len = 1; len <= n / 2; len++) {
    if (n % len !== 0) continue;
    let isRepeat = true;
    for (let i = len; i < n; i++) {
      if (arr[i] !== arr[i % len]) {
        isRepeat = false;
        break;
      }
    }
    if (isRepeat) return arr.slice(0, len);
  }
  return arr;
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

  // Rotate powers array and matching timeline events
  const rotated = powers.slice(bestIdx).concat(powers.slice(0, bestIdx));
  let rotatedTimeline = chain.timeline;
  if (chain.timeline && chain.timeline.length === powers.length) {
    rotatedTimeline = chain.timeline.slice(bestIdx).concat(chain.timeline.slice(0, bestIdx));
  }

  return { ...chain, powers: rotated, timeline: rotatedTimeline };
}
