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
      <td class="action-col">
        <button class="save-btn" style="${toggleStyle};margin-right:6px" onclick="toggleSeason(${s.id},${s.active ? 0 : 1})">${toggleLabel}</button>
        <button class="save-btn view-ok" style="background:var(--color-info);margin-right:6px" onclick="toggleServerPanel(${s.id})">${isExpanded ? 'Collapse' : 'Servers'}</button>
        <button class="reset-btn" data-id="${s.id}" data-name="${escHtml(s.name)}" data-count="${s.server_count}" onclick="deleteSeason(this)">Delete</button>
      </td>`;
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

  const chips = nums.length
    ? nums.map(n => `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--color-base-200);border:1px solid var(--color-info);border-radius:4px;padding:2px 8px;font-size:12px;margin:2px">
        ${n}
        <button onclick="removeServer(${seasonId},${n})" style="background:none;border:none;color:var(--color-neutral-content);cursor:pointer;padding:0;font-size:11px;line-height:1" title="Remove">✕</button>
      </span>`).join('')
    : '<span style="color:var(--color-neutral-content);font-size:12px">No servers yet</span>';

  container.innerHTML = `
    <div style="margin-bottom:10px">${chips}</div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <input id="addServers-${seasonId}" placeholder="e.g. 1, 3, 5-10, 14" style="max-width:260px;font-size:12px">
      <button class="save-btn" style="background:var(--color-success)" onclick="bulkAddServers(${seasonId})">+ Add</button>
    </div>`;
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

export async function deleteSeason(el) {
  const id          = +el.dataset.id;
  const name        = el.dataset.name;
  const serverCount = +el.dataset.count;
  const msg         = serverCount > 0
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
  tbody.innerHTML = bossList.map(b => `
    <tr id="dr-row-${b.id}">
      <td><input type="number" min="1" value="${b.sort_order ?? ''}" style="width:60px" onchange="updateDreamBoss(${b.id},{sort_order:this.value?parseInt(this.value):null})"></td>
      <td><input type="text" value="${escHtml(b.name)}" style="max-width:200px" onchange="updateDreamBoss(${b.id},{name:this.value})"></td>
      <td>
        <select onchange="updateDreamBoss(${b.id},{season:this.value?parseInt(this.value):null})">
          <option value="">— none —</option>
          ${seasons.map(s => `<option value="${s.id}"${s.id === b.season ? ' selected' : ''}>${escHtml(s.name)}</option>`).join('')}
        </select>
      </td>
      <td><button class="reset-btn" data-id="${b.id}" data-name="${escHtml(b.name)}" onclick="deleteDreamBoss(this)" style="color:var(--color-error)">Delete</button></td>
    </tr>`).join('');
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

export async function deleteDreamBoss(el) {
  const id   = +el.dataset.id;
  const name = el.dataset.name;
  if (!confirm(`Delete boss "${name}"?`)) return;
  const res = await fetch(`/api/dream-realm-bosses/${id}`, { method: 'DELETE' }).then(r => r.json());
  if (res.error) { alert(res.error); return; }
  await loadDreamBosses();
}
