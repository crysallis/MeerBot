import { state } from './state.js';
import { escHtml as escapeHtml } from './utils.js';

export async function loadAccess() {
  let data;
  try { data = await fetch('/api/access').then(r => r.json()); } catch { return; }
  if (!data || data.error) return;

  const tierMap = Object.fromEntries((data.roles || []).map(r => [r.role_id, r.tier]));

  const opsBody = document.getElementById('accessOpsBody');
  opsBody.innerHTML = '';
  for (const op of data.operations) {
    const sel = ['read', 'manage', 'local'].map(t =>
      `<option value="${t}"${op.tier === t ? ' selected' : ''}>${t}</option>`).join('');
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(op.group)}</td>` +
      `<td>${escapeHtml(op.label)}${op.overridden ? ' <span style="color:var(--color-neutral-content)">(custom)</span>' : ''}</td>` +
      `<td><select onchange="setOpTier('${op.key}', this.value)">${sel}</select></td>`;
    opsBody.appendChild(tr);
  }

  const rolesBody = document.getElementById('accessRolesBody');
  rolesBody.innerHTML = '';
  const roles = (state.roleList || []).slice().sort((a, b) => (b.position || 0) - (a.position || 0));
  for (const role of roles) {
    const cur = tierMap[role.id] || 'none';
    const sel = ['none', 'read', 'manage'].map(t =>
      `<option value="${t}"${cur === t ? ' selected' : ''}>${t}</option>`).join('');
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(role.name)}</td>` +
      `<td><select onchange="setRoleTierUI('${role.id}', this.value)">${sel}</select></td>`;
    rolesBody.appendChild(tr);
  }

  const auditBody = document.getElementById('accessAuditBody');
  auditBody.innerHTML = '';
  if (!data.audit || !data.audit.length) {
    auditBody.innerHTML = '<tr><td colspan="4" style="color:var(--color-neutral-content)">No changes recorded yet.</td></tr>';
  } else {
    for (const a of data.audit) {
      const who = a.discord_id === 'local' ? 'Local PC' : escapeHtml(a.discord_id);
      const tr  = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml((a.at || '').replace('T', ' ').slice(0, 19))}</td>` +
        `<td>${who}</td><td>${escapeHtml(a.action)}</td>` +
        `<td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(a.target || '')}</td>`;
      auditBody.appendChild(tr);
    }
  }
}

export async function setOpTier(key, tier) {
  const res = await fetch('/api/access/op', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op_key: key, tier }),
  });
  if (!res.ok) alert('Failed: ' + ((await res.json().catch(() => ({}))).error || res.status));
  loadAccess();
}

export async function setRoleTierUI(roleId, tier) {
  const res = await fetch('/api/access/role', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role_id: roleId, tier }),
  });
  if (!res.ok) alert('Failed: ' + ((await res.json().catch(() => ({}))).error || res.status));
}
