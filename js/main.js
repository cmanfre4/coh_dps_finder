// Entry point: UI wiring for CoH DPS Finder

import { loadArchetypeTables, loadAllPowers } from './data.js';
import { parsePowers } from './power-parser.js';
import { renderPowerList, renderResults, initEnhancementControls, getEnhancementConfigFromUI } from './ui.js';
import { applyEnhancements, getDefaultSlotConfig } from './enhancements.js';

const state = {
  archetype: 'blaster',
  powerset: 'fire_blast',
  level: 50,
  rechargeBonus: 85,
  tables: null,
  rawPowers: null,
  parsedPowers: null,
  worker: null,
};

async function init() {
  // Bind UI events
  const rechargeSlider = document.getElementById('recharge-slider');
  const rechargeDisplay = document.getElementById('recharge-display');
  const runBtn = document.getElementById('run-btn');
  const levelInput = document.getElementById('level-input');

  const latencySlider = document.getElementById('latency-slider');
  const latencyDisplay = document.getElementById('latency-display');

  rechargeSlider.addEventListener('input', () => {
    state.rechargeBonus = parseInt(rechargeSlider.value, 10);
    rechargeDisplay.textContent = `${state.rechargeBonus}%`;
  });

  latencySlider.addEventListener('input', () => {
    latencyDisplay.textContent = `${latencySlider.value}ms`;
  });

  levelInput.addEventListener('change', () => {
    state.level = Math.max(1, Math.min(50, parseInt(levelInput.value, 10) || 50));
    levelInput.value = state.level;
  });

  runBtn.addEventListener('click', () => runOptimizer());

  // Enhancement controls (no-op onChange during init; just sets up listeners)
  initEnhancementControls(() => {});

  // Load data
  try {
    state.tables = await loadArchetypeTables(state.archetype);
    state.rawPowers = await loadAllPowers(state.archetype, state.powerset);
    state.parsedPowers = await parsePowers(
      state.rawPowers, state.tables, state.archetype, state.powerset, state.level
    );

    renderPowerList(
      state.parsedPowers.filter(p => !p.isBuff),
      document.getElementById('power-list'),
      state.parsedPowers.filter(p => p.isBuff)
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
      const dmgBuff = (aim.buffs || []).find(b => b.table.toLowerCase() !== 'ranged_ones');
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
  state.parsedPowers = await parsePowers(
    state.rawPowers, state.tables, state.archetype, state.powerset, state.level
  );

  // Apply enhancements to parsed powers
  const enhConfig = getEnhancementConfigFromUI();
  const enhancedPowers = state.parsedPowers.map(p => applyEnhancements(p, enhConfig));

  // Separate attack powers (deal damage) from buff powers (Aim, Build Up, etc.)
  const attackPowers = enhancedPowers.filter(p => !p.isBuff);
  const buffPowers = enhancedPowers.filter(p => p.isBuff);

  renderPowerList(attackPowers, document.getElementById('power-list'), buffPowers);

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
      const progressText = msg.skipped
        ? `Chain length ${msg.length}: ${msg.reason}`
        : `Chain length ${msg.length}: ${msg.checked?.toLocaleString() || 0} / ${msg.totalCombos?.toLocaleString() || '?'} checked${msg.bestDps ? ` (best: ${msg.bestDps.toFixed(1)} DPS)` : ''}`;
      resultsContent.innerHTML = `<p class="loading">${progressText}</p>`;
    }

    if (msg.type === 'result') {
      renderResults(msg.chains, resultsContent);
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

  // Send powers data to worker (serializable plain objects)
  worker.postMessage({
    powers: attackPowers,
    buffPowers,
    rechargeReduction: state.rechargeBonus,
    activationLatency: latencySec,
  });
}

init();
