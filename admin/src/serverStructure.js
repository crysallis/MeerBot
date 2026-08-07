import { escHtml } from './utils.js';

let ssData = { fetched_at: null, categories: [], uncategorised: [] };

export async function loadServerStructure() {
  try {
    ssData = await fetch('/api/server-structure').then(r => r.json());
  } catch {
    ssData = { fetched_at: null, categories: [], uncategorised: [] };
  }
  renderServerStructure();
}

function everyoneBadge(canView) {
  return canView
    ? `<span style="color:var(--color-success); font-size:11px">Everyone can view</span>`
    : `<span style="color:var(--color-error); font-size:11px">Everyone CANNOT view</span>`;
}

function overwriteRows(overwrites) {
  if (!overwrites.length) return `<p class="muted-note" style="font-size:12px">No role overwrites.</p>`;
  const rows = overwrites.map(ow => `
    <tr>
      <td>${ow.kind === 'role' ? escHtml(ow.name) : `user:${escHtml(ow.name)}`}</td>
      <td style="color:var(--color-success)">${ow.allow.map(escHtml).join(', ') || '-'}</td>
      <td style="color:var(--color-error)">${ow.deny.map(escHtml).join(', ') || '-'}</td>
    </tr>`).join('');
  return `
    <table class="jobs-table" style="margin-top:6px">
      <thead><tr class="jobs-header-row"><th>Role</th><th>Allow</th><th>Deny</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function channelBlock(ch) {
  const syncedTag = ch.synced
    ? `<span class="muted-note" style="font-size:11px">synced to category</span>`
    : `<span style="color:var(--color-warning); font-size:11px">custom permissions</span>`;
  return `
    <div class="panel-card" style="margin:8px 0 8px 20px">
      <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap">
        <strong>#${escHtml(ch.name)}</strong>
        ${syncedTag}
        ${everyoneBadge(ch.everyoneCanView)}
      </div>
      ${ch.synced ? '' : overwriteRows(ch.overwrites)}
    </div>`;
}

function categoryBlock(cat) {
  const channels = cat.channels.map(channelBlock).join('');
  return `
    <div class="panel-card" style="margin-bottom:16px">
      <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap">
        <span class="section-title" style="font-size:15px; margin:0">${escHtml(cat.name)}</span>
        ${everyoneBadge(cat.everyoneCanView)}
      </div>
      ${overwriteRows(cat.overwrites)}
      ${channels}
    </div>`;
}

export function renderServerStructure() {
  const treeEl = document.getElementById('ssTree');
  const fetchedEl = document.getElementById('ssFetchedAt');
  if (!treeEl) return;

  fetchedEl.textContent = ssData.fetched_at
    ? `Last refreshed: ${new Date(ssData.fetched_at).toLocaleString()}`
    : 'Never refreshed';

  if (!ssData.categories.length && !ssData.uncategorised.length) {
    treeEl.innerHTML = `<p class="muted-note">No data yet — click Refresh from Discord.</p>`;
    return;
  }

  const cats = ssData.categories.map(categoryBlock).join('');
  const orphans = ssData.uncategorised.length
    ? `<div class="panel-card" style="margin-bottom:16px">
         <div class="section-title" style="font-size:15px">(No category)</div>
         ${ssData.uncategorised.map(channelBlock).join('')}
       </div>`
    : '';

  treeEl.innerHTML = cats + orphans;
}

export async function refreshServerStructure() {
  const statusEl = document.getElementById('ssRefreshStatus');
  statusEl.textContent = 'Refreshing...';
  statusEl.style.color = 'var(--color-base-content)';
  try {
    const res = await fetch('/api/server-structure/refresh', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    await loadServerStructure();
    statusEl.textContent = 'Refreshed!';
    statusEl.style.color = 'var(--color-success)';
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
  } catch (err) {
    statusEl.textContent = 'Failed: ' + err.message;
    statusEl.style.color = 'var(--color-error)';
  }
}
