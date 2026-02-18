// UI rendering for the DPS calculator

import { effectiveEnhancement } from './enhancements.js';

let _powerToggleCallback = null;

export function setPowerToggleCallback(cb) {
  _powerToggleCallback = cb;
}

// Set up enhancement control event handlers
// Returns a callback that reads the current enhancement config
export function initEnhancementControls(onChange) {
  const preset = document.getElementById('enh-preset');
  const accSlider = document.getElementById('enh-accuracy-slider');
  const dmgSlider = document.getElementById('enh-damage-slider');
  const rechSlider = document.getElementById('enh-recharge-slider');
  const accDisplay = document.getElementById('enh-accuracy-display');
  const dmgDisplay = document.getElementById('enh-damage-display');
  const rechDisplay = document.getElementById('enh-recharge-display');
  const dmgEff = document.getElementById('enh-dmg-eff');
  const rechEff = document.getElementById('enh-rech-eff');
  const slotCount = document.getElementById('enh-slot-count');
  const pipsContainer = document.querySelector('.enh-slot-pips');

  function updateDisplay() {
    const acc = parseInt(accSlider.value, 10);
    const dmg = parseInt(dmgSlider.value, 10);
    const rech = parseInt(rechSlider.value, 10);
    const total = acc + dmg + rech;

    // Cap each slider's max so total can't exceed 6
    accSlider.max = 6 - dmg - rech;
    dmgSlider.max = 6 - acc - rech;
    rechSlider.max = 6 - acc - dmg;

    accDisplay.textContent = acc;
    dmgDisplay.textContent = dmg;
    rechDisplay.textContent = rech;

    dmgEff.textContent = `+${effectiveEnhancement(dmg).toFixed(1)}%`;
    rechEff.textContent = `+${effectiveEnhancement(rech).toFixed(1)}%`;

    // Slot pips
    slotCount.textContent = `${total} / 6`;

    let pipsHtml = '';
    for (let i = 0; i < 6; i++) {
      let cls = '';
      if (i < acc) cls = 'acc';
      else if (i < acc + dmg) cls = 'dmg';
      else if (i < total) cls = 'rech';
      pipsHtml += `<span class="enh-pip ${cls}"></span>`;
    }
    pipsContainer.innerHTML = pipsHtml;
  }

  function syncPreset() {
    const acc = parseInt(accSlider.value, 10);
    const dmg = parseInt(dmgSlider.value, 10);
    const rech = parseInt(rechSlider.value, 10);
    if (acc === 1 && dmg === 3 && rech === 2) preset.value = '1/3/2';
    else if (acc === 1 && dmg === 5 && rech === 0) preset.value = '1/5/0';
    else if (acc === 0 && dmg === 0 && rech === 0) preset.value = '0/0/0';
    else preset.value = 'custom';
  }

  preset.addEventListener('change', () => {
    const val = preset.value;
    if (val === '1/3/2') { accSlider.value = 1; dmgSlider.value = 3; rechSlider.value = 2; }
    else if (val === '1/5/0') { accSlider.value = 1; dmgSlider.value = 5; rechSlider.value = 0; }
    else if (val === '0/0/0') { accSlider.value = 0; dmgSlider.value = 0; rechSlider.value = 0; }
    updateDisplay();
    onChange();
  });

  accSlider.addEventListener('input', () => {
    updateDisplay();
    syncPreset();
    onChange();
  });

  dmgSlider.addEventListener('input', () => {
    updateDisplay();
    syncPreset();
    onChange();
  });

  rechSlider.addEventListener('input', () => {
    updateDisplay();
    syncPreset();
    onChange();
  });

  updateDisplay();
}

export function getEnhancementConfigFromUI() {
  const dmg = parseInt(document.getElementById('enh-damage-slider').value, 10);
  const rech = parseInt(document.getElementById('enh-recharge-slider').value, 10);
  return {
    global: {
      damage: dmg,
      recharge: rech,
      accuracy: 0,
      endurance: 0,
    },
    perPower: {},
  };
}

export function renderPowerList(powers, container, powersets, disabledPowers) {
  container.innerHTML = '';
  const disabled = disabledPowers || new Set();

  if (!powers || powers.length === 0) {
    container.innerHTML = '<div class="loading">No damage powers found.</div>';
    return;
  }

  for (const ps of powersets) {
    const setPowers = powers.filter(p => p.powersetSlug === ps.slug);
    if (setPowers.length === 0) continue;

    // Section divider
    const divider = document.createElement('div');
    divider.className = 'power-list-divider';
    divider.textContent = ps.label;
    container.appendChild(divider);

    // Attack powers sorted by unlock level
    const attacks = setPowers.filter(p => !p.isBuff).sort((a, b) => a.availableLevel - b.availableLevel);
    for (const power of attacks) {
      container.appendChild(renderAttackPowerItem(power, disabled));
    }

    // Buff powers in this set, sorted by unlock level
    const buffs = setPowers.filter(p => p.isBuff).sort((a, b) => a.availableLevel - b.availableLevel);
    for (const power of buffs) {
      container.appendChild(renderBuffPowerItem(power, disabled));
    }
  }
}

function renderAttackPowerItem(power, disabled) {
  const isDisabled = disabled.has(power.slug);
  const item = document.createElement('div');
  item.className = `power-item${isDisabled ? ' excluded' : ''}`;
  item.innerHTML = `
    <input type="checkbox" class="power-toggle" data-slug="${power.slug}" ${isDisabled ? '' : 'checked'} />
    <span class="power-name">${power.name}</span>
    <span class="power-stats">
      ${power.castTime.toFixed(2)}s cast | ${power.rechargeTime.toFixed(1)}s rech | ${power.totalDamage.toFixed(1)} dmg
      ${power.effectArea !== 'SingleTarget' ? ` | ${power.effectArea}` : ''}
    </span>
    <span class="power-dpa">${power.dpa.toFixed(1)} DPA</span>
  `;
  item.querySelector('.power-toggle').addEventListener('change', (e) => {
    const enabled = e.target.checked;
    item.classList.toggle('excluded', !enabled);
    if (_powerToggleCallback) _powerToggleCallback(power.slug, enabled);
  });
  return item;
}

function renderBuffPowerItem(power, disabled) {
  const dmgBuff = (power.buffs || []).find(b => b.table.toLowerCase() !== 'ranged_ones');
  const buffPct = dmgBuff ? (dmgBuff.resolvedScale * 100).toFixed(1) : '?';
  const buffDur = dmgBuff ? dmgBuff.duration.toFixed(0) : '?';
  const isDisabled = disabled.has(power.slug);

  const item = document.createElement('div');
  item.className = `power-item buff-power-item${isDisabled ? ' excluded' : ''}`;
  item.innerHTML = `
    <input type="checkbox" class="power-toggle" data-slug="${power.slug}" ${isDisabled ? '' : 'checked'} />
    <span class="power-name">${power.name}</span>
    <span class="power-stats">
      ${power.castTime.toFixed(2)}s cast | ${power.rechargeTime.toFixed(1)}s rech
    </span>
    <span class="power-buff-value">+${buffPct}% dmg / ${buffDur}s</span>
  `;
  item.querySelector('.power-toggle').addEventListener('change', (e) => {
    const enabled = e.target.checked;
    item.classList.toggle('excluded', !enabled);
    if (_powerToggleCallback) _powerToggleCallback(power.slug, enabled);
  });
  return item;
}

export function renderResults({ rangedChains, hybridChains, aoeChains, numTargets }, container) {
  container.innerHTML = '';

  const hasRanged = rangedChains && rangedChains.length > 0;
  const hasHybrid = hybridChains && hybridChains.length > 0;
  const hasAoe = aoeChains && aoeChains.length > 0;

  if (!hasRanged && !hasHybrid && !hasAoe) {
    container.innerHTML = '<p class="loading">No feasible chains found.</p>';
    return;
  }

  if (hasAoe) {
    renderChainSection(aoeChains, container, 'aoe', `AoE Chain (${numTargets} targets)`, true);
  }

  if (hasRanged) {
    renderChainSection(rangedChains, container, 'ranged', 'Ranged Chain');
  }

  if (hasHybrid) {
    renderChainSection(hybridChains, container, 'hybrid', 'Melee / Hybrid Chain');
  }
}

function renderChainSection(chains, container, sectionId, heading, showTargets) {
  const section = document.createElement('div');
  section.className = 'results-section';

  const h2 = document.createElement('h2');
  h2.className = 'results-section-heading';
  h2.textContent = heading;
  section.appendChild(h2);

  // Best chain detail
  const best = chains[0];
  const detailDiv = document.createElement('div');
  detailDiv.className = 'chain-display';
  detailDiv.id = `chain-detail-${sectionId}`;
  detailDiv.innerHTML = renderChainDetail(best, 0, showTargets);
  section.appendChild(detailDiv);

  // Top chains list
  if (chains.length > 1) {
    const listPanel = document.createElement('div');
    listPanel.className = 'panel';
    listPanel.innerHTML = `<h2>Top ${chains.length} Chains</h2>`;
    const list = document.createElement('ul');
    list.className = 'top-chains-list';

    chains.forEach((chain, i) => {
      const li = document.createElement('li');
      li.className = i === 0 ? 'active' : '';
      const label = chain.powers.map(p => p.name).join(' > ');
      const hasBuff = chain.buffedDps != null;
      li.innerHTML = `
        <span class="chain-label">${i + 1}. ${label}</span>
        <span class="chain-dps-group">
          ${hasBuff ? `<span class="chain-dps-buffed">${chain.buffedDps.toFixed(1)}</span>` : ''}
          <span class="chain-dps">${chain.dps.toFixed(1)} DPS</span>
        </span>
      `;
      li.addEventListener('click', () => {
        document.getElementById(`chain-detail-${sectionId}`).innerHTML = renderChainDetail(chain, i, showTargets);
        list.querySelectorAll('li').forEach(el => el.classList.remove('active'));
        li.classList.add('active');
      });
      list.appendChild(li);
    });

    listPanel.appendChild(list);
    section.appendChild(listPanel);
  }

  container.appendChild(section);
}

function renderChainDetail(chain, index, showTargets) {
  const chainVisual = chain.powers
    .map(p => `<span class="chain-power">${p.name}</span>`)
    .join('<span class="chain-arrow"> &rarr; </span>');

  const breakdownRows = chain.powers.map(p => `
    <tr>
      <td>${p.name}</td>
      <td class="num">${p.damage.toFixed(1)}</td>
      <td class="num">${p.castTime.toFixed(2)}s</td>
      <td class="num">${p.arcanaTime.toFixed(3)}s</td>
      <td class="num">${p.effectiveRecharge.toFixed(1)}s</td>
      <td class="num">${p.dpa.toFixed(1)}</td>
      <td class="num">${p.defianceBuff ? `+${((p.defianceBuff - 1) * 100).toFixed(1)}%` : '-'}</td>
      <td class="num">${p.enduranceCost.toFixed(1)}</td>
      <td>${p.effectArea === 'SingleTarget' ? 'ST' : p.effectArea}</td>
      ${showTargets ? `<td class="num">${p.targetsHit || 1}</td>` : ''}
    </tr>
  `).join('');

  const hasBuffOverlay = chain.buffedDps != null;

  // Buff overlay section — a visually distinct block explaining what's happening
  const buffOverlayHtml = hasBuffOverlay ? renderBuffOverlay(chain) : '';

  return `
    <h3>${index === 0 ? 'Optimal' : `#${index + 1}`} Attack Chain</h3>
    <div class="chain-visual">${chainVisual}<span class="chain-arrow"> &circlearrowleft;</span></div>
    <div class="chain-stats">
      <div class="stat-box">
        <div class="stat-label">DPS</div>
        <div class="stat-value dps">${chain.dps.toFixed(1)}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Cycle Time</div>
        <div class="stat-value">${chain.totalTime.toFixed(2)}s</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Cycle Damage</div>
        <div class="stat-value">${chain.totalDamage.toFixed(1)}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Avg Defiance</div>
        <div class="stat-value">${chain.avgDefianceBuff ? `+${((chain.avgDefianceBuff - 1) * 100).toFixed(1)}%` : '0%'}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">End/sec</div>
        <div class="stat-value">${chain.eps.toFixed(2)}</div>
      </div>
    </div>
    <table class="breakdown-table" style="margin-top: 1rem;">
      <thead>
        <tr>
          <th>Power</th>
          <th>Damage</th>
          <th>Cast</th>
          <th>Arcana</th>
          <th>Eff. Rech</th>
          <th>DPA</th>
          <th>Defiance</th>
          <th>End</th>
          <th>Area</th>
          ${showTargets ? '<th>Targets</th>' : ''}
        </tr>
      </thead>
      <tbody>${breakdownRows}</tbody>
    </table>
    ${buffOverlayHtml}
  `;
}

function renderBuffOverlay(chain) {
  const buffNames = (chain.buffPowerNames || []).join(' + ');
  const uptimePct = (chain.buffUptime * 100).toFixed(1);
  const dpsGain = chain.buffedDps - chain.dps;
  const dpsPct = ((dpsGain / chain.dps) * 100).toFixed(1);

  // Width of the uptime bar (capped at 100%)
  const barWidth = Math.min(chain.buffUptime * 100, 100);

  return `
    <div class="buff-overlay-section">
      <div class="buff-overlay-header">
        <span class="buff-overlay-title">With ${buffNames}</span>
        <span class="buff-overlay-desc">Fired on cooldown between chain rotations</span>
      </div>
      <div class="buff-overlay-body">
        <div class="buff-overlay-dps">
          <span class="buff-overlay-dps-value">${chain.buffedDps.toFixed(1)}</span>
          <span class="buff-overlay-dps-label">DPS</span>
          <span class="buff-overlay-dps-gain">+${dpsGain.toFixed(1)} (+${dpsPct}%)</span>
        </div>
        <div class="buff-overlay-details">
          <div class="buff-overlay-detail-row">
            <span class="buff-overlay-detail-label">Buff Uptime</span>
            <div class="buff-uptime-bar-track">
              <div class="buff-uptime-bar-fill" style="width: ${barWidth}%"></div>
            </div>
            <span class="buff-overlay-detail-value">${uptimePct}%</span>
          </div>
          <div class="buff-overlay-detail-row">
            <span class="buff-overlay-detail-label">Avg Damage Bonus</span>
            <span class="buff-overlay-detail-value">+${((chain.avgBuffMult - 1) * 100).toFixed(1)}%</span>
          </div>
        </div>
      </div>
    </div>
  `;
}
