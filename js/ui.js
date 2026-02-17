// UI rendering for the DPS calculator

import { effectiveEnhancement } from './enhancements.js';

// Set up enhancement control event handlers
// Returns a callback that reads the current enhancement config
export function initEnhancementControls(onChange) {
  const preset = document.getElementById('enh-preset');
  const dmgSlider = document.getElementById('enh-damage-slider');
  const rechSlider = document.getElementById('enh-recharge-slider');
  const dmgDisplay = document.getElementById('enh-damage-display');
  const rechDisplay = document.getElementById('enh-recharge-display');
  const dmgEff = document.getElementById('enh-dmg-eff');
  const rechEff = document.getElementById('enh-rech-eff');
  const slotMeter = document.getElementById('enh-slot-meter');
  const slotCount = document.getElementById('enh-slot-count');
  const pipsContainer = document.querySelector('.enh-slot-pips');

  function updateDisplay() {
    const dmg = parseInt(dmgSlider.value, 10);
    const rech = parseInt(rechSlider.value, 10);
    const total = dmg + rech;
    const isOver = total > 6;

    dmgDisplay.textContent = dmg;
    rechDisplay.textContent = rech;

    dmgEff.textContent = `+${effectiveEnhancement(dmg).toFixed(1)}%`;
    rechEff.textContent = `+${effectiveEnhancement(rech).toFixed(1)}%`;

    // Slot pips
    slotCount.textContent = `${total} / 6`;
    slotMeter.classList.toggle('over', isOver);

    let pipsHtml = '';
    for (let i = 0; i < Math.max(total, 6); i++) {
      let cls = '';
      if (i < dmg) cls = isOver ? 'over' : 'dmg';
      else if (i < total) cls = isOver ? 'over' : 'rech';
      pipsHtml += `<span class="enh-pip ${cls}"></span>`;
    }
    pipsContainer.innerHTML = pipsHtml;
  }

  function syncPreset() {
    const dmg = parseInt(dmgSlider.value, 10);
    const rech = parseInt(rechSlider.value, 10);
    if (dmg === 3 && rech === 3) preset.value = '3/3';
    else if (dmg === 5 && rech === 1) preset.value = '5/1';
    else if (dmg === 0 && rech === 0) preset.value = '0/0';
    else preset.value = 'custom';
  }

  preset.addEventListener('change', () => {
    const val = preset.value;
    if (val === '3/3') { dmgSlider.value = 3; rechSlider.value = 3; }
    else if (val === '5/1') { dmgSlider.value = 5; rechSlider.value = 1; }
    else if (val === '0/0') { dmgSlider.value = 0; rechSlider.value = 0; }
    updateDisplay();
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

export function renderPowerList(powers, container) {
  container.innerHTML = '';

  if (!powers || powers.length === 0) {
    container.innerHTML = '<div class="loading">No damage powers found.</div>';
    return;
  }

  // Sort by DPA descending
  const sorted = [...powers].sort((a, b) => b.dpa - a.dpa);

  for (const power of sorted) {
    const item = document.createElement('div');
    item.className = 'power-item';
    item.innerHTML = `
      <span class="power-name">${power.name}</span>
      <span class="power-stats">
        ${power.castTime.toFixed(2)}s cast | ${power.rechargeTime.toFixed(1)}s rech | ${power.totalDamage.toFixed(1)} dmg
        ${power.effectArea !== 'SingleTarget' ? ` | ${power.effectArea}` : ''}
      </span>
      <span class="power-dpa">${power.dpa.toFixed(1)} DPA</span>
    `;
    container.appendChild(item);
  }
}

export function renderResults(chains, container) {
  container.innerHTML = '';

  if (!chains || chains.length === 0) {
    container.innerHTML = '<p class="loading">No feasible chains found.</p>';
    return;
  }

  // Best chain detail
  const best = chains[0];
  const detailDiv = document.createElement('div');
  detailDiv.className = 'chain-display';
  detailDiv.id = 'chain-detail';
  detailDiv.innerHTML = renderChainDetail(best, 0);
  container.appendChild(detailDiv);

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
      li.innerHTML = `
        <span class="chain-label">${i + 1}. ${label}</span>
        <span class="chain-dps">${chain.dps.toFixed(1)} DPS</span>
      `;
      li.addEventListener('click', () => {
        document.getElementById('chain-detail').innerHTML = renderChainDetail(chain, i);
        list.querySelectorAll('li').forEach(el => el.classList.remove('active'));
        li.classList.add('active');
      });
      list.appendChild(li);
    });

    listPanel.appendChild(list);
    container.appendChild(listPanel);
  }
}

function renderChainDetail(chain, index) {
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
    </tr>
  `).join('');

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
        </tr>
      </thead>
      <tbody>${breakdownRows}</tbody>
    </table>
  `;
}
