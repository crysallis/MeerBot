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

  body.innerHTML = rows.map(m => {
    const discord = m.discord_id
      ? `<span title="${m.discord_id}">${m.discord_name || m.discord_id}</span>`
      : '<span style="color:var(--color-neutral-content)">—</span>';
    const status = m.pending
      ? '<span style="color:var(--color-warning);font-weight:600">PENDING</span>'
      : (m.active ? '<span style="color:var(--color-success)">active</span>' : '<span style="color:var(--color-neutral-content)">inactive</span>');
    const approveBtn = m.pending
      ? `<button class="save-btn" style="background:var(--color-success);padding:3px 8px" onclick="approveMember(${m.id})">Approve</button>` : '';
    const wbOptions = warbandsList.filter(w => !w.archived)
      .map(w => `<option value="${w.id}"${m.warband_id === w.id ? ' selected' : ''}>${escapeHtml(w.name)}</option>`).join('');
    const wbSelect = `<select onchange="setWarband(${m.id}, this.value)" style="background:var(--color-base-200);color:var(--color-base-content);border:1px solid var(--border-color);border-radius:4px;padding:2px 4px">`
      + `<option value=""${m.warband_id ? '' : ' selected'}>— none —</option>${wbOptions}</select>`;
    const ingameIdInput = `<input type="number" value="${m.ingame_id || ''}" placeholder="no ID" min="1"
      title="In-game User ID · type and press Enter or Tab to save"
      style="width:90px;font-size:11px;margin-top:3px;background:var(--color-base-200);color:var(--color-base-content);border:1px solid var(--border-color);border-radius:4px;padding:2px 4px"
      onchange="setIngameId(${m.id}, this.value)">`;
    return `<tr>
      <td data-label="Name"><b>${escapeHtml(m.ingame_name)}</b><br>${ingameIdInput}</td>
      <td data-label="Warband">${wbSelect}</td>
      <td data-label="Power">${escapeHtml(m.combat_power || '')}</td>
      <td data-label="Discord">${discord}</td>
      <td data-label="Status">${status}</td>
      <td data-label="Actions" style="white-space:nowrap">
        ${approveBtn}
        <button class="save-btn" style="padding:3px 8px" onclick="renameMember(${m.id})">Rename</button>
        <button class="save-btn" style="padding:3px 8px" onclick="linkMember(${m.id})">Link</button>
        <button class="save-btn" style="padding:3px 8px" onclick="mergeMemberPrompt(${m.id})">Merge</button>
      </td>
    </tr>`;
  }).join('');
}

export function renderWarbands() {
  const body = document.getElementById('warbandsBody');
  if (!body) return;
  if (!warbandsList.length) {
    body.innerHTML = '<tr><td colspan="4" style="color:var(--color-neutral-content)">No warbands.</td></tr>';
    return;
  }
  body.innerHTML = warbandsList.map(w => `<tr>
    <td><b>${escapeHtml(w.name)}</b></td>
    <td>${w.members}</td>
    <td>${w.archived ? '<span style="color:var(--color-neutral-content)">archived</span>' : '<span style="color:var(--color-success)">active</span>'}</td>
    <td style="white-space:nowrap">
      <button class="save-btn" style="padding:3px 8px" onclick="renameWarbandUI(${w.id})">Rename</button>
      <button class="save-btn" style="padding:3px 8px" onclick="archiveWarband(${w.id}, ${w.archived ? 0 : 1})">${w.archived ? 'Unarchive' : 'Archive'}</button>
    </td>
  </tr>`).join('');
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
