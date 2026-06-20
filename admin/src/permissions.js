import { state } from './state.js';
import { escHtml } from './utils.js';

let selectedPermRoles    = [];
let selectedPermChannels = [];
let editingPermRuleIds   = [];

const CHIP_STYLE = 'background:var(--border-color);border-radius:3px;padding:2px 8px;font-size:12px;display:inline-flex;align-items:center;gap:4px';
const X_STYLE   = 'background:none;border:none;color:var(--color-neutral-content);cursor:pointer;padding:0;font-size:14px;line-height:1';

export function populatePermCommands() {
  const sel = document.getElementById('perm-command');
  Object.keys(state.COMMAND_SUBS).sort().forEach(cmd => {
    const opt = document.createElement('option');
    opt.value = cmd;
    opt.textContent = '/' + cmd;
    sel.appendChild(opt);
  });
}

export function permCommandChanged() {
  const cmd    = document.getElementById('perm-command').value;
  const subSel = document.getElementById('perm-subcommand');
  subSel.innerHTML = '<option value="">— whole command —</option>';
  const subs = state.COMMAND_SUBS[cmd] || [];
  subs.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    subSel.appendChild(opt);
  });
  subSel.disabled = subs.length === 0;
}

export function populatePermCheckboxes() {
  const roleSel = document.getElementById('perm-role-pick');
  const chSel   = document.getElementById('perm-channel-pick');
  if (!roleSel || !chSel) return;
  roleSel.innerHTML = '<option value="">-- add role --</option>' +
    state.roleList.map(r => `<option value="${r.id}">${escHtml(r.name)}</option>`).join('');
  chSel.innerHTML = '<option value="">-- add channel --</option>' +
    state.channelList.map(c => `<option value="${c.id}">#${escHtml(c.name)}</option>`).join('');
}

export function permPickRole() {
  const sel = document.getElementById('perm-role-pick');
  const id  = sel.value;
  if (!id || selectedPermRoles.some(r => r.id === id)) { sel.value = ''; return; }
  selectedPermRoles.push({ id, name: state.roleList.find(r => r.id === id)?.name ?? id });
  sel.value = '';
  renderPermChips();
}

export function permPickChannel() {
  const sel = document.getElementById('perm-channel-pick');
  const id  = sel.value;
  if (!id || selectedPermChannels.some(c => c.id === id)) { sel.value = ''; return; }
  selectedPermChannels.push({ id, name: state.channelList.find(c => c.id === id)?.name ?? id });
  sel.value = '';
  renderPermChips();
}

export function permRemoveRole(id) {
  selectedPermRoles = selectedPermRoles.filter(r => r.id !== id);
  renderPermChips();
}

export function permRemoveChannel(id) {
  selectedPermChannels = selectedPermChannels.filter(c => c.id !== id);
  renderPermChips();
}

export function renderPermChips() {
  document.getElementById('perm-role-chips').innerHTML = selectedPermRoles
    .map(r => `<span style="${CHIP_STYLE}">${escHtml(r.name)}<button style="${X_STYLE}" onclick="permRemoveRole('${r.id}')">×</button></span>`)
    .join('');
  document.getElementById('perm-channel-chips').innerHTML = selectedPermChannels
    .map(c => `<span style="${CHIP_STYLE}">#${escHtml(c.name)}<button style="${X_STYLE}" onclick="permRemoveChannel('${c.id}')">×</button></span>`)
    .join('');
}

export async function loadPermissions() {
  const rows  = await fetch('/api/permissions').then(r => r.json());
  const tbody = document.getElementById('permTableBody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="color:var(--color-neutral-content)">No rules configured.</td></tr>';
    return;
  }
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.command}|||${r.subcommand ?? ''}`;
    if (!groups.has(key)) groups.set(key, { command: r.command, subcommand: r.subcommand, roles: [], channels: [] });
    (r.type === 'role' ? groups.get(key).roles : groups.get(key).channels).push(r);
  }
  const tinyChip = (label, id) =>
    `<span style="${CHIP_STYLE}">${escHtml(label)}<button style="${X_STYLE}" onclick="deletePermRule(${id})">×</button></span>`;
  tbody.innerHTML = [...groups.values()].map(g => {
    const subcmd      = g.subcommand ?? `<span style="color:var(--color-neutral-content)">— whole command —</span>`;
    const roleChips   = g.roles.map(r => tinyChip(state.roleList.find(x => x.id === r.value_id)?.name ?? r.value_id, r.id)).join(' ');
    const chChips     = g.channels.map(c => tinyChip('#' + (state.channelList.find(x => x.id === c.value_id)?.name ?? c.value_id), c.id)).join(' ');
    const rIds  = '[' + g.roles.map(r => `'${r.value_id}'`).join(',') + ']';
    const cIds  = '[' + g.channels.map(c => `'${c.value_id}'`).join(',') + ']';
    const dbIds = '[' + [...g.roles, ...g.channels].map(r => r.id).join(',') + ']';
    const sub   = g.subcommand ? `'${g.subcommand}'` : 'null';
    return `<tr>
      <td><code>${escHtml(g.command)}</code></td>
      <td>${subcmd}</td>
      <td style="white-space:normal">${roleChips    || '<span style="color:var(--color-neutral-content)">—</span>'}</td>
      <td style="white-space:normal">${chChips      || '<span style="color:var(--color-neutral-content)">—</span>'}</td>
      <td style="white-space:nowrap">
        <button class="reset-btn" onclick="editPermGroup('${g.command}',${sub},${rIds},${cIds},${dbIds})">Edit</button>
        <button class="reset-btn" style="margin-left:4px" onclick="removePermGroup(${dbIds})">Remove</button>
      </td>
    </tr>`;
  }).join('');
}

export async function addPermRule() {
  const command    = document.getElementById('perm-command').value.trim();
  const subcommand = document.getElementById('perm-subcommand').value.trim() || null;
  const errEl      = document.getElementById('perm-error');
  errEl.textContent = '';
  if (!command) { errEl.textContent = 'Command is required'; return; }
  if (!selectedPermRoles.length && !selectedPermChannels.length) {
    errEl.textContent = 'Select at least one role or channel'; return;
  }
  if (editingPermRuleIds.length) {
    for (const id of editingPermRuleIds) {
      await fetch('/api/permissions/' + id, { method: 'DELETE' });
    }
    editingPermRuleIds = [];
  }
  const toPost = [
    ...selectedPermRoles.map(r => ({ command, subcommand, type: 'role', value_id: r.id })),
    ...selectedPermChannels.map(c => ({ command, subcommand, type: 'channel', value_id: c.id })),
  ];
  for (const body of toPost) {
    const res  = await fetch('/api/permissions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) { errEl.textContent = data.error; return; }
  }
  document.getElementById('perm-command').value = '';
  permCommandChanged();
  selectedPermRoles    = [];
  selectedPermChannels = [];
  renderPermChips();
  document.getElementById('perm-add-btn').textContent          = '+ Add Rules';
  document.getElementById('perm-cancel-btn').style.display     = 'none';
  await loadPermissions();
}

export async function deletePermRule(id) {
  await fetch('/api/permissions/' + id, { method: 'DELETE' });
  await loadPermissions();
}

export async function removePermGroup(dbIds) {
  if (!confirm('Remove all rules for this command/subcommand?')) return;
  for (const id of dbIds) {
    await fetch('/api/permissions/' + id, { method: 'DELETE' });
  }
  await loadPermissions();
}

export async function editPermGroup(command, subcommand, roleValueIds, channelValueIds, dbIds) {
  document.getElementById('perm-command').value = command;
  permCommandChanged();
  const subSel = document.getElementById('perm-subcommand');
  if (subcommand) subSel.value = subcommand;
  selectedPermRoles    = roleValueIds.map(id => ({ id, name: state.roleList.find(r => r.id === id)?.name ?? id }));
  selectedPermChannels = channelValueIds.map(id => ({ id, name: state.channelList.find(c => c.id === id)?.name ?? id }));
  renderPermChips();
  editingPermRuleIds = dbIds;
  document.getElementById('perm-add-btn').textContent      = 'Save Changes';
  document.getElementById('perm-cancel-btn').style.display = '';
  document.getElementById('perm-error').textContent        = '';
  document.getElementById('section-permissions').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function cancelPermEdit() {
  editingPermRuleIds = [];
  document.getElementById('perm-command').value = '';
  permCommandChanged();
  selectedPermRoles    = [];
  selectedPermChannels = [];
  renderPermChips();
  document.getElementById('perm-add-btn').textContent      = '+ Add Rules';
  document.getElementById('perm-cancel-btn').style.display = 'none';
  document.getElementById('perm-error').textContent        = '';
}
