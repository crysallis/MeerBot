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
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(op.group)}</td>` +
      `<td>${escapeHtml(op.label)}${op.overridden ? ' <span style="color:var(--color-neutral-content)">(custom)</span>' : ''}</td>` +
      `<td></td>`;
    const sel = document.createElement('select');
    for (const t of ['read', 'manage', 'local']) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      if (op.tier === t) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => setOpTier(op.key, sel.value));
    tr.lastElementChild.appendChild(sel);
    opsBody.appendChild(tr);
  }

  const rolesBody = document.getElementById('accessRolesBody');
  rolesBody.innerHTML = '';
  const roles = (state.roleList || []).slice().sort((a, b) => (b.position || 0) - (a.position || 0));
  for (const role of roles) {
    const cur = tierMap[role.id] || 'none';
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(role.name)}</td><td></td>`;
    const sel = document.createElement('select');
    for (const t of ['none', 'read', 'manage']) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      if (cur === t) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => setRoleTierUI(role.id, sel.value));
    tr.lastElementChild.appendChild(sel);
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
