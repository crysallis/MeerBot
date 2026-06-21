import { escapeHtml } from './utils.js';

let memberList   = [];
let warbandsList = [];

export async function loadMembers() {
  try {
    [memberList, warbandsList] = await Promise.all([
      fetch('/api/members').then(r => r.json()),
      fetch('/api/warbands').then(r => r.json()),
    ]);
  } catch {
    memberList = []; warbandsList = [];
  }
  renderMembers();
  renderWarbands();
}

export function renderMembers() {
  const body = document.getElementById('membersBody');
  const q = (document.getElementById('memberFilter').value || '').toLowerCase();
  const rows = memberList.filter(m =>
    m.ingame_name.toLowerCase().includes(q) || (m.warband || '').toLowerCase().includes(q));

  const pendingCount = memberList.filter(m => m.pending).length;
  document.getElementById('membersSummary').textContent =
    `${memberList.length} members · ${pendingCount} pending review`;

  if (rows.length === 0) {
    body.innerHTML = '<tr><td colspan="6" style="color:var(--color-neutral-content)">No members.</td></tr>';
    return;
  }

  body.replaceChildren();
  for (const m of rows) {
    const tr = document.createElement('tr');

    // Name + ingame ID
    const tdName = document.createElement('td');
    tdName.dataset.label = 'Name';
    const nameB = document.createElement('b');
    nameB.textContent = m.ingame_name;
    const idInput = document.createElement('input');
    idInput.type = 'number';
    idInput.value = m.ingame_id || '';
    idInput.placeholder = 'no ID';
    idInput.min = '1';
    idInput.title = 'In-game User ID · type and press Enter or Tab to save';
    idInput.style.cssText = 'width:90px;font-size:11px;margin-top:3px;background:var(--color-base-200);color:var(--color-base-content);border:1px solid var(--color-base-300);border-radius:4px;padding:2px 4px';
    idInput.addEventListener('change', () => setIngameId(m.id, idInput.value));
    tdName.append(nameB, document.createElement('br'), idInput);

    // Warband select
    const tdWb = document.createElement('td');
    tdWb.dataset.label = 'Warband';
    const wbSel = document.createElement('select');
    wbSel.style.cssText = 'background:var(--color-base-200);color:var(--color-base-content);border:1px solid var(--color-base-300);border-radius:4px;padding:2px 4px';
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '— none —';
    if (!m.warband_id) noneOpt.selected = true;
    wbSel.appendChild(noneOpt);
    for (const w of warbandsList.filter(w => !w.archived)) {
      const opt = document.createElement('option');
      opt.value = w.id;
      opt.textContent = w.name;
      if (m.warband_id === w.id) opt.selected = true;
      wbSel.appendChild(opt);
    }
    wbSel.addEventListener('change', () => setWarband(m.id, wbSel.value));
    tdWb.appendChild(wbSel);

    // Power
    const tdPow = document.createElement('td');
    tdPow.dataset.label = 'Power';
    tdPow.textContent = m.combat_power || '';

    // Discord
    const tdDis = document.createElement('td');
    tdDis.dataset.label = 'Discord';
    if (m.discord_id) {
      const sp = document.createElement('span');
      sp.title = m.discord_id;
      sp.textContent = m.discord_name || m.discord_id;
      tdDis.appendChild(sp);
    } else {
      tdDis.innerHTML = '<span style="color:var(--color-neutral-content)">—</span>';
    }

    // Status
    const tdStat = document.createElement('td');
    tdStat.dataset.label = 'Status';
    tdStat.innerHTML = m.pending
      ? '<span style="color:var(--color-warning);font-weight:600">PENDING</span>'
      : (m.active ? '<span style="color:var(--color-success)">active</span>' : '<span style="color:var(--color-neutral-content)">inactive</span>');

    // Actions
    const tdAct = document.createElement('td');
    tdAct.dataset.label = 'Actions';
    tdAct.style.whiteSpace = 'nowrap';
    if (m.pending) {
      const approveBtn = document.createElement('button');
      approveBtn.className = 'save-btn';
      approveBtn.style.cssText = 'background:var(--color-success);padding:3px 8px';
      approveBtn.textContent = 'Approve';
      approveBtn.addEventListener('click', () => approveMember(m.id));
      tdAct.appendChild(approveBtn);
    }
    for (const [label, fn] of [['Rename', () => renameMember(m.id)], ['Link', () => linkMember(m.id)], ['Merge', () => mergeMemberPrompt(m.id)]]) {
      const btn = document.createElement('button');
      btn.className = 'save-btn';
      btn.style.padding = '3px 8px';
      btn.textContent = label;
      btn.addEventListener('click', fn);
      tdAct.appendChild(btn);
    }

    tr.append(tdName, tdWb, tdPow, tdDis, tdStat, tdAct);
    body.appendChild(tr);
  }
}

export function renderWarbands() {
  const body = document.getElementById('warbandsBody');
  if (!body) return;
  if (!warbandsList.length) {
    body.innerHTML = '<tr><td colspan="4" style="color:var(--color-neutral-content)">No warbands.</td></tr>';
    return;
  }
  body.replaceChildren();
  for (const w of warbandsList) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><b>${escapeHtml(w.name)}</b></td>
      <td>${w.members}</td>
      <td>${w.archived ? '<span style="color:var(--color-neutral-content)">archived</span>' : '<span style="color:var(--color-success)">active</span>'}</td>
      <td style="white-space:nowrap"></td>`;
    const renBtn = document.createElement('button');
    renBtn.className = 'save-btn';
    renBtn.style.padding = '3px 8px';
    renBtn.textContent = 'Rename';
    renBtn.addEventListener('click', () => renameWarbandUI(w.id));
    const archBtn = document.createElement('button');
    archBtn.className = 'save-btn';
    archBtn.style.padding = '3px 8px';
    archBtn.textContent = w.archived ? 'Unarchive' : 'Archive';
    archBtn.addEventListener('click', () => archiveWarband(w.id, w.archived ? 0 : 1));
    tr.lastElementChild.append(renBtn, archBtn);
    body.appendChild(tr);
  }
}

export async function approveMember(id) {
  const res = await fetch(`/api/members/${id}/approve`, { method: 'POST' });
  const data = await res.json();
  if (!data.ok) { alert('Approve failed: ' + data.error); return; }
  await loadMembers();
}

export function findMember(id) { return memberList.find(m => m.id === id); }

export async function renameMember(id) {
  const m = findMember(id); if (!m) return;
  const current = m.ingame_name;
  const newName = prompt(`Rename "${current}" to (if the new name already exists, they will be merged):`, current);
  if (!newName || newName.trim() === current) return;
  const res = await fetch(`/api/members/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ingame_name: newName.trim() }),
  });
  const data = await res.json();
  if (!data.ok) { alert('Rename failed: ' + data.error); return; }
  await loadMembers();
}

export async function linkMember(id) {
  const m = findMember(id); if (!m) return;
  const discordId = prompt(`Discord user ID to link to "${m.ingame_name}" (blank to unlink):`, m.discord_id || '');
  if (discordId === null) return;
  const res = await fetch(`/api/members/${id}/link`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ discord_id: discordId.trim() }),
  });
  const data = await res.json();
  if (!data.ok) { alert('Link failed: ' + data.error); return; }
  await loadMembers();
}

export async function mergeMemberPrompt(dropId) {
  const m = findMember(dropId); if (!m) return;
  const dropName = m.ingame_name;
  const keepName = prompt(`Merge "${dropName}" INTO which existing member? (this removes "${dropName}")`);
  if (!keepName) return;
  const keep = memberList.find(x => x.ingame_name.toLowerCase() === keepName.trim().toLowerCase());
  if (!keep) { alert(`No member named "${keepName}".`); return; }
  if (keep.id === dropId) { alert('Cannot merge a member into itself.'); return; }
  const res = await fetch('/api/members/merge', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keepId: keep.id, dropId }),
  });
  const data = await res.json();
  if (!data.ok) { alert('Merge failed: ' + data.error); return; }
  await loadMembers();
}

export async function setWarband(id, value) {
  const warband_id = value ? Number(value) : null;
  const res = await fetch(`/api/members/${id}/warband`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ warband_id }),
  });
  const data = await res.json();
  if (!data.ok) { alert('Failed: ' + data.error); }
  await loadMembers();
}

export async function setIngameId(id, value) {
  const res = await fetch(`/api/members/${id}/ingame-id`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ingame_id: value || null }),
  });
  const data = await res.json();
  if (!data.ok) alert('Failed: ' + data.error);
}

export async function addWarband() {
  const input = document.getElementById('newWarbandName');
  const name = input.value.trim();
  if (!name) return;
  const res = await fetch('/api/warbands', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (!data.ok) { alert('Add failed: ' + data.error); return; }
  input.value = '';
  await loadMembers();
}

export async function renameWarbandUI(id) {
  const wb = warbandsList.find(w => w.id === id); if (!wb) return;
  const current = wb.name;
  const name = prompt(`Rename warband "${current}" to (updates everywhere):`, current);
  if (!name || name.trim() === current) return;
  const res = await fetch(`/api/warbands/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim() }),
  });
  const data = await res.json();
  if (!data.ok) { alert('Rename failed: ' + data.error); return; }
  await loadMembers();
}

export async function archiveWarband(id, archived) {
  const res = await fetch(`/api/warbands/${id}/archive`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archived }),
  });
  const data = await res.json();
  if (!data.ok) { alert('Failed: ' + data.error); return; }
  await loadMembers();
}
