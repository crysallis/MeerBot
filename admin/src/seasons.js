import { escHtml } from './utils.js';

let seasonsData    = [];
let expandedSeason = null;
let dreamSeasonList = [];

export async function loadSeasons() {
  try {
    seasonsData = await fetch('/api/seasons').then(r => r.json());
  } catch {
    seasonsData = [];
  }
  renderSeasons();
}

export function renderSeasons() {
  const tbody = document.getElementById('seasonsBody');
  if (!tbody) return;
  if (!seasonsData.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="color:var(--color-neutral-content)">No seasons yet.</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  for (const s of seasonsData) {
    const statusBadge = s.active
      ? '<span class="config-badge config-badge-db">Active</span>'
      : '<span class="config-badge config-badge-default">Inactive</span>';
    const toggleLabel = s.active ? 'Inactivate' : 'Activate';
    const toggleStyle = s.active ? 'background:var(--color-error)' : 'background:var(--color-success)';
    const isExpanded  = expandedSeason === s.id;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-weight:600;color:var(--color-base-content)">${escHtml(s.name)}</td>
      <td>${statusBadge}</td>
      <td style="color:var(--color-neutral-content);font-size:12px">${s.server_count} server${s.server_count !== 1 ? 's' : ''}</td>
      <td class="action-col"></td>`;
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'save-btn';
    toggleBtn.style.cssText = `${toggleStyle};margin-right:6px`;
    toggleBtn.textContent = toggleLabel;
    toggleBtn.addEventListener('click', () => toggleSeason(s.id, s.active ? 0 : 1));
    const serversBtn = document.createElement('button');
    serversBtn.className = 'save-btn view-ok';
    serversBtn.style.cssText = 'background:var(--color-info);margin-right:6px';
    serversBtn.textContent = isExpanded ? 'Collapse' : 'Servers';
    serversBtn.addEventListener('click', () => toggleServerPanel(s.id));
    const delBtn = document.createElement('button');
    delBtn.className = 'reset-btn';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => deleteSeason(s.id, s.name, s.server_count));
    tr.lastElementChild.append(toggleBtn, serversBtn, delBtn);
    tbody.appendChild(tr);

    if (isExpanded) {
      const detailTr = document.createElement('tr');
      detailTr.innerHTML = `<td colspan="4" style="padding:12px 16px;background:rgba(255,255,255,.02)">
        <div id="servers-content-${s.id}"><span style="color:var(--color-neutral-content);font-size:12px">Loading...</span></div>
      </td>`;
      tbody.appendChild(detailTr);
      loadServersContent(s.id);
    }
  }
}

async function loadServersContent(seasonId) {
  const nums = await fetch(`/api/seasons/${seasonId}/servers`).then(r => r.json());
  const container = document.getElementById(`servers-content-${seasonId}`);
  if (!container) return;

  const chipsDiv = document.createElement('div');
  chipsDiv.style.marginBottom = '10px';
  if (nums.length) {
    for (const n of nums) {
      const span = document.createElement('span');
      span.style.cssText = 'display:inline-flex;align-items:center;gap:4px;background:var(--color-base-200);border:1px solid var(--color-info);border-radius:4px;padding:2px 8px;font-size:12px;margin:2px';
      span.textContent = n;
      const xBtn = document.createElement('button');
      xBtn.style.cssText = 'background:none;border:none;color:var(--color-neutral-content);cursor:pointer;padding:0;font-size:11px;line-height:1';
      xBtn.title = 'Remove';
      xBtn.textContent = '✕';
      xBtn.addEventListener('click', () => removeServer(seasonId, n));
      span.appendChild(xBtn);
      chipsDiv.appendChild(span);
    }
  } else {
    chipsDiv.innerHTML = '<span style="color:var(--color-neutral-content);font-size:12px">No servers yet</span>';
  }

  const addInput = document.createElement('input');
  addInput.id = `addServers-${seasonId}`;
  addInput.placeholder = 'e.g. 1, 3, 5-10, 14';
  addInput.style.cssText = 'max-width:260px;font-size:12px';
  const addBtn = document.createElement('button');
  addBtn.className = 'save-btn';
  addBtn.style.background = 'var(--color-success)';
  addBtn.textContent = '+ Add';
  addBtn.addEventListener('click', () => bulkAddServers(seasonId));
  const addRow = document.createElement('div');
  addRow.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap';
  addRow.append(addInput, addBtn);

  container.replaceChildren(chipsDiv, addRow);
}

function parseServerNums(str) {
  const nums = new Set();
  for (const part of str.split(',')) {
    const t     = part.trim();
    const range = t.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const lo = parseInt(range[1]), hi = parseInt(range[2]);
      for (let i = Math.min(lo, hi); i <= Math.max(lo, hi); i++) nums.add(i);
    } else if (/^\d+$/.test(t)) {
      nums.add(parseInt(t));
    }
  }
  return [...nums].sort((a, b) => a - b);
}

export function toggleServerPanel(seasonId) {
  expandedSeason = expandedSeason === seasonId ? null : seasonId;
  renderSeasons();
}

export async function addSeason() {
  const input = document.getElementById('newSeasonName');
  const name  = input.value.trim();
  if (!name) return;
  const res = await fetch('/api/seasons', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then(r => r.json());
  if (res.error) { alert(res.error); return; }
  input.value = '';
  await loadSeasons();
}

export async function toggleSeason(id, newActive) {
  const res = await fetch(`/api/seasons/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active: newActive }),
  }).then(r => r.json());
  if (res.error) { alert(res.error); return; }
  await loadSeasons();
}

export async function deleteSeason(id, name, serverCount) {
  const msg = serverCount > 0
    ? `Delete season "${name}" and its ${serverCount} server${serverCount !== 1 ? 's' : ''}?`
    : `Delete season "${name}"?`;
  if (!confirm(msg)) return;
  const res = await fetch(`/api/seasons/${id}`, { method: 'DELETE' }).then(r => r.json());
  if (res.error) { alert(res.error); return; }
  if (expandedSeason === id) expandedSeason = null;
  await loadSeasons();
}

export async function bulkAddServers(seasonId) {
  const input = document.getElementById(`addServers-${seasonId}`);
  const nums  = parseServerNums(input.value);
  if (!nums.length) { alert('Enter valid server numbers (e.g. 1, 3, 5-10)'); return; }
  const res = await fetch(`/api/seasons/${seasonId}/servers`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ numbers: nums }),
  }).then(r => r.json());
  if (res.error) { alert(res.error); return; }
  input.value = '';
  await loadSeasons();
}

export async function removeServer(seasonId, serverNum) {
  const res = await fetch(`/api/seasons/${seasonId}/servers`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ numbers: [serverNum] }),
  }).then(r => r.json());
  if (res.error) { alert(res.error); return; }
  await loadSeasons();
}

export async function loadDreamBosses() {
  const [bosses, seasons] = await Promise.all([
    fetch('/api/dream-realm-bosses').then(r => r.json()),
    fetch('/api/seasons').then(r => r.json()),
  ]);
  dreamSeasonList = Array.isArray(seasons) ? seasons : [];
  const sel = document.getElementById('newBossSeason');
  sel.innerHTML = '<option value="">— none —</option>' +
    dreamSeasonList.map(s => `<option value="${s.id}">${escHtml(s.name)}</option>`).join('');
  const tbody    = document.getElementById('dreamBossesBody');
  const bossList = Array.isArray(bosses) ? bosses : [];
  if (!bossList.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="color:var(--color-neutral-content)">No bosses yet.</td></tr>';
    return;
  }
  tbody.replaceChildren();
  for (const b of bossList) {
    const tr = document.createElement('tr');
    tr.id = `dr-row-${b.id}`;

    const orderInput = document.createElement('input');
    orderInput.type = 'number';
    orderInput.min = '1';
    orderInput.value = b.sort_order ?? '';
    orderInput.style.width = '60px';
    orderInput.addEventListener('change', () => updateDreamBoss(b.id, { sort_order: orderInput.value ? parseInt(orderInput.value) : null }));

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = b.name;
    nameInput.style.maxWidth = '200px';
    nameInput.addEventListener('change', () => updateDreamBoss(b.id, { name: nameInput.value }));

    const seasonSel = document.createElement('select');
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '— none —';
    seasonSel.appendChild(noneOpt);
    for (const s of seasons) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      if (s.id === b.season) opt.selected = true;
      seasonSel.appendChild(opt);
    }
    seasonSel.addEventListener('change', () => updateDreamBoss(b.id, { season: seasonSel.value ? parseInt(seasonSel.value) : null }));

    const delBtn = document.createElement('button');
    delBtn.className = 'reset-btn';
    delBtn.style.color = 'var(--color-error)';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => deleteDreamBoss(b.id, b.name));

    const tdOrder = document.createElement('td'); tdOrder.appendChild(orderInput);
    const tdName  = document.createElement('td'); tdName.appendChild(nameInput);
    const tdSeas  = document.createElement('td'); tdSeas.appendChild(seasonSel);
    const tdDel   = document.createElement('td'); tdDel.appendChild(delBtn);
    tr.append(tdOrder, tdName, tdSeas, tdDel);
    tbody.appendChild(tr);
  }
}

export async function addDreamBoss() {
  const name = document.getElementById('newBossName').value.trim();
  if (!name) { alert('Boss name required'); return; }
  const order  = document.getElementById('newBossOrder').value;
  const season = document.getElementById('newBossSeason').value;
  const res = await fetch('/api/dream-realm-bosses', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, sort_order: order ? parseInt(order) : null, season: season ? parseInt(season) : null }),
  }).then(r => r.json());
  if (res.error) { alert(res.error); return; }
  document.getElementById('newBossName').value  = '';
  document.getElementById('newBossOrder').value = '';
  await loadDreamBosses();
}

export async function updateDreamBoss(id, fields) {
  const res = await fetch(`/api/dream-realm-bosses/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  }).then(r => r.json());
  if (res.error) alert(res.error);
}

export async function deleteDreamBoss(id, name) {
  if (!confirm(`Delete boss "${name}"?`)) return;
  const res = await fetch(`/api/dream-realm-bosses/${id}`, { method: 'DELETE' }).then(r => r.json());
  if (res.error) { alert(res.error); return; }
  await loadDreamBosses();
}
