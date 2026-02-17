// Entry point: UI wiring for CoH DPS Finder

import { loadArchetypeTables, loadAllPowers } from './data.js';
import { parsePowers } from './power-parser.js';
import { optimizeChains, greedyChain } from './chain-optimizer.js';
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
};

async function init() {
  // Bind UI events
  const rechargeSlider = document.getElementById('recharge-slider');
  const rechargeDisplay = document.getElementById('recharge-display');
  const runBtn = document.getElementById('run-btn');
  const levelInput = document.getElementById('level-input');

  rechargeSlider.addEventListener('input', () => {
    state.rechargeBonus = parseInt(rechargeSlider.value, 10);
    rechargeDisplay.textContent = `${state.rechargeBonus}%`;
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

    renderPowerList(state.parsedPowers, document.getElementById('power-list'));

    // Validate Flares damage
    const flares = state.parsedPowers.find(p => p.slug === 'flares');
    if (flares) {
      console.log(`Flares L${state.level} damage: ${flares.totalDamage.toFixed(2)} (expected ~63.19)`);
      console.log(`Flares ArcanaTime: ${flares.arcanaTime.toFixed(3)}s (expected 1.188s)`);
    }
  } catch (err) {
    console.error('Failed to load data:', err);
    document.getElementById('power-list').innerHTML =
      `<div class="error-msg">Failed to load power data: ${err.message}</div>`;
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

  renderPowerList(enhancedPowers, document.getElementById('power-list'));

  // Use setTimeout to let the UI update before heavy computation
  setTimeout(() => {
    try {
      const chains = optimizeChains(enhancedPowers, state.rechargeBonus);
      renderResults(chains, resultsContent);

      // Also show greedy chain for comparison
      const greedy = greedyChain(enhancedPowers, state.rechargeBonus);
      if (greedy) {
        console.log('Greedy chain DPS:', greedy.dps.toFixed(1),
          greedy.powers.map(p => p.name).join(' > '));
      }
    } catch (err) {
      console.error('Optimization error:', err);
      resultsContent.innerHTML =
        `<div class="error-msg">Optimization failed: ${err.message}</div>`;
    }

    runBtn.disabled = false;
    runBtn.textContent = 'Find Optimal Chain';
  }, 50);
}

init();
