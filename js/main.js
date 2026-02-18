// Entry point: UI wiring for CoH DPS Finder

import { loadArchetypeTables, loadAllPowers } from './data.js';
import { parsePowers } from './power-parser.js';
import { renderPowerList, renderResults, initEnhancementControls, getEnhancementConfigFromUI, setPowerToggleCallback } from './ui.js';
import { applyEnhancements, getDefaultSlotConfig } from './enhancements.js';

const state = {
  archetype: 'blaster',
  powerset: 'fire_blast',
  secondaryPowerset: 'fire_manipulation',
  level: 50,
  rechargeBonus: 85,
  tables: null,
  rawPowers: null,
  rawSecondaryPowers: null,
  parsedPowers: null,
  worker: null,
  disabledPowers: new Set(),
};

function formatPowersetName(slug) {
  return slug.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

async function init() {
  // Bind UI events
  const rechargeSlider = document.getElementById('recharge-slider');
  const rechargeDisplay = document.getElementById('recharge-display');
  const runBtn = document.getElementById('run-btn');
  const levelInput = document.getElementById('level-input');

  const latencySlider = document.getElementById('latency-slider');
  const latencyDisplay = document.getElementById('latency-display');
  const targetsSlider = document.getElementById('targets-slider');
  const targetsDisplay = document.getElementById('targets-display');

  rechargeSlider.addEventListener('input', () => {
    state.rechargeBonus = parseInt(rechargeSlider.value, 10);
    rechargeDisplay.textContent = `${state.rechargeBonus}%`;
  });

  latencySlider.addEventListener('input', () => {
    latencyDisplay.textContent = `${latencySlider.value}ms`;
  });

  targetsSlider.addEventListener('input', () => {
    targetsDisplay.textContent = targetsSlider.value;
  });

  levelInput.addEventListener('change', () => {
    state.level = Math.max(1, Math.min(50, parseInt(levelInput.value, 10) || 50));
    levelInput.value = state.level;
  });

  runBtn.addEventListener('click', () => runOptimizer());

  // Enhancement controls (no-op onChange during init; just sets up listeners)
  initEnhancementControls(() => {});

  // Power toggle callback
  setPowerToggleCallback((slug, enabled) => {
    if (enabled) {
      state.disabledPowers.delete(slug);
    } else {
      state.disabledPowers.add(slug);
    }
  });

  // Load data
  try {
    state.tables = await loadArchetypeTables(state.archetype);
    state.rawPowers = await loadAllPowers(state.archetype, state.powerset);
    state.rawSecondaryPowers = await loadAllPowers(state.archetype, state.secondaryPowerset);

    const primaryParsed = await parsePowers(
      state.rawPowers, state.tables, state.archetype, state.powerset, state.level
    );
    const secondaryParsed = await parsePowers(
      state.rawSecondaryPowers, state.tables, state.archetype, state.secondaryPowerset, state.level
    );
    primaryParsed.forEach(p => p.powersetSlug = state.powerset);
    secondaryParsed.forEach(p => p.powersetSlug = state.secondaryPowerset);
    state.parsedPowers = [...primaryParsed, ...secondaryParsed];

    renderPowerList(
      state.parsedPowers,
      document.getElementById('power-list'),
      [
        { slug: state.powerset, label: formatPowersetName(state.powerset) },
        { slug: state.secondaryPowerset, label: formatPowersetName(state.secondaryPowerset) },
      ],
      state.disabledPowers
    );

    // Validate Flares damage
    const flares = state.parsedPowers.find(p => p.slug === 'flares');
    if (flares) {
      console.log(`Flares L${state.level} damage: ${flares.totalDamage.toFixed(2)} (expected ~63.19)`);
      console.log(`Flares ArcanaTime: ${flares.arcanaTime.toFixed(3)}s (expected 1.188s)`);
    }

    // Validate Aim buff parsing
    const aim = state.parsedPowers.find(p => p.slug === 'aim');
    if (aim) {
      const dmgBuff = (aim.buffs || []).find(b => {
        const t = b.table.toLowerCase();
        return t !== 'ranged_ones' && t !== 'melee_ones';
      });
      console.log(`Aim isBuff: ${aim.isBuff}, buffs: ${aim.buffs.length}, dmg buff: +${dmgBuff ? (dmgBuff.resolvedScale * 100).toFixed(1) : '?'}% (expected +62.5%)`);
    }
  } catch (err) {
    console.error('Failed to load data:', err);
    document.getElementById('power-list').innerHTML =
      `<div class="error-msg">Failed to load power data: ${err && err.message || String(err)}</div>`;
  }
}

async function runOptimizer() {
  const runBtn = document.getElementById('run-btn');
  const resultsContent = document.getElementById('results-content');

  runBtn.disabled = true;
  runBtn.textContent = 'Calculating...';
  resultsContent.innerHTML = '<p class="loading">Finding optimal attack chains...</p>';

  // Re-parse powers at current level
  const primaryParsed = await parsePowers(
    state.rawPowers, state.tables, state.archetype, state.powerset, state.level
  );
  const secondaryParsed = await parsePowers(
    state.rawSecondaryPowers, state.tables, state.archetype, state.secondaryPowerset, state.level
  );
  primaryParsed.forEach(p => p.powersetSlug = state.powerset);
  secondaryParsed.forEach(p => p.powersetSlug = state.secondaryPowerset);
  state.parsedPowers = [...primaryParsed, ...secondaryParsed];

  // Apply enhancements to parsed powers
  const enhConfig = getEnhancementConfigFromUI();
  const enhancedPowers = state.parsedPowers.map(p => applyEnhancements(p, enhConfig));

  renderPowerList(
    enhancedPowers,
    document.getElementById('power-list'),
    [
      { slug: state.powerset, label: formatPowersetName(state.powerset) },
      { slug: state.secondaryPowerset, label: formatPowersetName(state.secondaryPowerset) },
    ],
    state.disabledPowers
  );

  // Filter out disabled powers before sending to worker
  const attackPowers = enhancedPowers.filter(p => !p.isBuff && !state.disabledPowers.has(p.slug));
  const buffPowers = enhancedPowers.filter(p => p.isBuff && !state.disabledPowers.has(p.slug));

  // Terminate any existing worker
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }

  // Run optimizer in a Web Worker
  const worker = new Worker('js/optimizer-worker.js');
  state.worker = worker;

  worker.onmessage = (e) => {
    const msg = e.data;

    if (msg.type === 'progress') {
      const passPrefix = msg.pass ? `${msg.pass}: ` : '';
      const progressText = msg.skipped
        ? `${passPrefix}Chain length ${msg.length}: ${msg.reason}`
        : `${passPrefix}Chain length ${msg.length}: ${msg.checked?.toLocaleString() || 0} / ${msg.totalCombos?.toLocaleString() || '?'} checked${msg.bestDps ? ` (best: ${msg.bestDps.toFixed(1)} DPS)` : ''}`;
      resultsContent.innerHTML = `<p class="loading">${progressText}</p>`;
    }

    if (msg.type === 'result') {
      renderResults({ rangedChains: msg.rangedChains, hybridChains: msg.hybridChains, aoeChains: msg.aoeChains, numTargets: msg.numTargets }, resultsContent);
      runBtn.disabled = false;
      runBtn.textContent = 'Find Optimal Chain';
      worker.terminate();
      state.worker = null;
    }

    if (msg.type === 'error') {
      console.error('Worker error:', msg.message);
      resultsContent.innerHTML =
        `<div class="error-msg">Optimization failed: ${msg.message}</div>`;
      runBtn.disabled = false;
      runBtn.textContent = 'Find Optimal Chain';
      worker.terminate();
      state.worker = null;
    }
  };

  worker.onerror = (e) => {
    console.error('Worker crashed:', e);
    resultsContent.innerHTML =
      `<div class="error-msg">Optimization failed: ${e.message || 'Worker crashed'}</div>`;
    runBtn.disabled = false;
    runBtn.textContent = 'Find Optimal Chain';
    state.worker = null;
  };

  // Read activation latency (ms -> seconds)
  const latencyMs = parseInt(document.getElementById('latency-slider').value, 10) || 0;
  const latencySec = latencyMs / 1000;

  // Read number of targets for AoE optimization
  const numTargets = parseInt(document.getElementById('targets-slider').value, 10) || 1;

  // Send powers data to worker (serializable plain objects)
  worker.postMessage({
    powers: attackPowers,
    buffPowers,
    rechargeReduction: state.rechargeBonus,
    activationLatency: latencySec,
    numTargets,
  });
}

init();
