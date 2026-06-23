import '../../shared/theme.css';
import { THEMES, themeMode } from '../../shared/themes.js';
import './style.css';

import { state } from './state.js';
import { escHtml as escapeHtml } from './utils.js';

import { renderScheduledJobs, toggleScheduledJob, saveScheduledJob, renderJobs, filterJobs, sortJobs, setJobChannel } from './jobs.js';
import { loadReactions, openReactionForm, cancelReactionForm, saveReactionRule, deleteReactionRule, updatePreview, rxPatternTypeChange, rxResponseTypeChange, rxSyncColorPicker, rxFilterSelect, rxInsert, refreshDiscordData } from './reactions.js';
import { loadMembers, renderMembers, approveMember, renameMember, linkMember, mergeMemberPrompt, setWarband, setIngameId, addWarband, renameWarbandUI, archiveWarband } from './members.js';
import { loadSeasons, addSeason, toggleSeason, deleteSeason, toggleServerPanel, bulkAddServers, removeServer, loadDreamBosses, addDreamBoss, updateDreamBoss, deleteDreamBoss } from './seasons.js';
import { loadPermissions, populatePermCommands, permCommandChanged, populatePermCheckboxes, permPickRole, permPickChannel, permRemoveRole, permRemoveChannel, addPermRule, deletePermRule, removePermGroup, editPermGroup, cancelPermEdit } from './permissions.js';
import { loadAccess, setOpTier, setRoleTierUI } from './access.js';

// ── Error log (surfaces CSP violations, JS errors, unhandled rejections, fetch failures) ──

const _errorLog = [];

function reportError(type, message, detail = {}) {
  const entry = { type, message, detail, at: new Date().toISOString() };
  _errorLog.push(entry);
  renderErrorLog();
  _origFetch('/api/client-error', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  }).catch(() => {});
}

function renderErrorLog() {
  let panel = document.getElementById('errorLogPanel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'errorLogPanel';
    panel.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:9999;max-width:480px;max-height:320px;overflow-y:auto;background:var(--color-base-100);border:2px solid var(--color-error);border-radius:8px;padding:12px 14px;box-shadow:0 4px 20px rgba(0,0,0,.4);font-size:12px';
    document.body.appendChild(panel);
  }
  panel.replaceChildren();
  const header = document.createElement('div');
  header.style.cssText = 'font-weight:600;color:var(--color-error);margin-bottom:8px';
  const closeBtn = document.createElement('button');
  closeBtn.style.cssText = 'float:right;background:none;border:none;color:var(--color-neutral-content);cursor:pointer;font-size:14px;line-height:1;padding:0';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => panel.remove());
  header.appendChild(closeBtn);
  header.appendChild(document.createTextNode(`⚠ Client Errors (${_errorLog.length})`));
  panel.appendChild(header);
  for (const e of _errorLog.slice(-20).reverse()) {
    const row = document.createElement('div');
    row.style.cssText = 'border-bottom:1px solid var(--color-base-300);padding:4px 0;margin-bottom:4px';
    row.innerHTML = `<span style="color:var(--color-error);font-weight:600">[${escapeHtml(e.type)}]</span>
      <span style="color:var(--color-base-content);margin-left:6px">${escapeHtml(e.message)}</span>
      <div style="color:var(--color-neutral-content);font-size:10px;margin-top:2px">${e.at.replace('T',' ').slice(0,19)}</div>`;
    panel.appendChild(row);
  }
}

// CSP violations
document.addEventListener('securitypolicyviolation', e => {
  reportError('CSP', `Blocked: ${e.blockedURI} in ${e.violatedDirective}`, { sourceFile: e.sourceFile, lineNumber: e.lineNumber });
});

// Uncaught JS errors
window.addEventListener('error', e => {
  reportError('JS Error', e.message, { source: e.filename, line: e.lineno, col: e.colno });
});

// Unhandled promise rejections
window.addEventListener('unhandledrejection', e => {
  const msg = e.reason instanceof Error ? e.reason.message : String(e.reason);
  reportError('Unhandled Promise', msg);
});

// ── Auth / access tier ────────────────────────────────────────────────────────

const AUTH = { tier: null, csrf: null, user: null };

const _origFetch = window.fetch.bind(window);
window.fetch = async function (input, init = {}) {
  const url    = typeof input === 'string' ? input : (input && input.url) || '';
  const method = (init.method || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();
  if (url.startsWith('/api/') && method !== 'GET' && method !== 'HEAD' && AUTH.csrf) {
    init.headers = Object.assign({}, init.headers, { 'X-CSRF-Token': AUTH.csrf });
  }
  let res;
  try {
    res = await _origFetch(input, init);
  } catch (err) {
    reportError('Fetch Error', `${method} ${url} — ${err.message}`);
    throw err;
  }
  if (res.status === 401 && url.startsWith('/api/')) showLogin();
  if (!res.ok && url.startsWith('/api/') && method !== 'GET' && method !== 'HEAD') {
    res.clone().json().then(data => {
      if (data?.error) reportError('API Error', `${method} ${url} → ${res.status}: ${data.error}`);
    }).catch(() => reportError('API Error', `${method} ${url} → ${res.status}`));
  }
  return res;
};

function showLogin(message) {
  let el = document.getElementById('loginOverlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'loginOverlay';
    el.className = 'login-overlay';
    document.body.appendChild(el);
  }
  el.innerHTML = '<div class="login-card"><img src="./images/meerbot_logo.png" alt="" style="width:64px">' +
    '<h2>Meer<span>Bot</span> Admin</h2>' +
    '<p>' + (message || 'Sign in to continue.') + '</p>' +
    '<a class="login-btn" href="/auth/login">Log in with Discord</a></div>';
  el.style.display = 'grid';
}

function applyAccess(me) {
  AUTH.tier = me.tier;
  AUTH.csrf = me.csrf;
  AUTH.user = me.user;
  document.body.classList.remove('tier-read', 'tier-manage', 'tier-local');
  document.body.classList.add('tier-' + me.tier);
  const who = document.getElementById('whoami');
  if (who) who.textContent = (me.user?.name || '') + ' · ' + me.tier;
  const av = document.getElementById('userAvatar');
  if (av) {
    if (me.user?.avatar) { av.src = me.user.avatar; av.style.display = ''; }
    else { av.removeAttribute('src'); av.style.display = 'none'; }
  }

  const BANNERS = {
    read:   'Read-only access — you can view everything; editing is disabled.',
    manage: 'Manage access — some controls are reserved to the host PC and are disabled here.',
  };
  const main   = document.querySelector('main');
  let banner   = document.getElementById('readonlyBanner');
  if (BANNERS[me.tier]) {
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'readonlyBanner';
      banner.className = 'readonly-banner';
      main.insertBefore(banner, main.firstChild);
    }
    banner.textContent = BANNERS[me.tier];
  } else if (banner) {
    banner.remove();
  }

  if (!applyAccess._presence) {
    applyAccess._presence = true;
    loadPresence();
    setInterval(loadPresence, 45000);
  }

  if (!applyAccess._observing) {
    new MutationObserver(() => {
      if (applyAccess._scheduled) return;
      applyAccess._scheduled = true;
      requestAnimationFrame(() => { applyAccess._scheduled = false; lockTiers(); });
    }).observe(document.body, { childList: true, subtree: true });
    applyAccess._observing = true;
  }
  lockTiers();
}

function lockTiers() {
  const tier = AUTH.tier;
  if (!tier) return;
  document.querySelectorAll('input, select, textarea, button').forEach(el => {
    if (el.closest('.theme-controls') || el.classList.contains('logout-btn') ||
        el.closest('.login-overlay') || el.classList.contains('view-ok')) return;
    const localOnly = el.classList.contains('needs-local') || !!el.closest('.needs-local');
    if (el.closest('#tabs') && !localOnly) return;
    el.disabled = localOnly ? (tier !== 'local') : (tier === 'read');
  });
}

async function logout() {
  await _origFetch('/auth/logout', { method: 'POST' });
  showLogin('Signed out.');
}

// ── Mobile nav drawer ─────────────────────────────────────────────────────────

function toggleNav() { document.body.classList.toggle('nav-open'); }
function closeNav()  { document.body.classList.remove('nav-open'); }

const _mobileMQ = matchMedia('(max-width: 768px)');
function setupMobileChrome(e) {
  const mobile      = e.matches;
  const headerRight = document.querySelector('.header-right');
  const drawerUtils = document.getElementById('drawerUtils');
  const toggleBtn   = document.getElementById('navToggle');
  const items = [document.querySelector('.theme-controls'),
                 document.getElementById('restartBtn'),
                 document.getElementById('restartStatus'),
                 document.querySelector('.logout-btn')].filter(Boolean);
  if (mobile) {
    for (const el of items) drawerUtils.appendChild(el);
  } else {
    const order = ['.logout-btn', '#restartStatus', '#restartBtn', '.theme-controls'];
    for (const sel of order) {
      const el = drawerUtils.querySelector(sel);
      if (el) headerRight.insertBefore(el, toggleBtn);
    }
    closeNav();
  }
}

// ── Presence ──────────────────────────────────────────────────────────────────

async function loadPresence() {
  let data;
  try { data = await _origFetch('/api/presence').then(r => r.ok ? r.json() : null); } catch { return; }
  if (!data || data.error) return;
  const el = document.getElementById('presence');
  if (!el) return;
  const others = (data.users || []).filter(u => u.discord_id !== data.me);
  if (!others.length) { el.innerHTML = ''; return; }
  const MAX  = 5;
  const shown = others.slice(0, MAX);
  let html = '<span class="presence-label">Viewing</span>';
  html += shown.map(u => {
    const inner = u.avatar
      ? `<img src="${u.avatar}" alt="">`
      : `<span class="presence-fallback">${escapeHtml((u.name || '?').slice(0, 1).toUpperCase())}</span>`;
    return `<span class="presence-av" title="${escapeHtml(u.name || '')}">${inner}</span>`;
  }).join('');
  if (others.length > MAX) {
    html += `<span class="presence-av presence-more" title="${others.length - MAX} more">+${others.length - MAX}</span>`;
  }
  el.innerHTML = html;
}

// ── Theme system ──────────────────────────────────────────────────────────────

function applyTheme(theme) {
  const mode = themeMode(theme);
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.setAttribute('data-mode', mode);
  localStorage.setItem('meerbot-theme', theme);
}

// Restore theme select value + attach listeners (DOM is ready; module is deferred)
(function () {
  const t = localStorage.getItem('meerbot-theme') || 'caramellatte';
  applyTheme(t);
  const sel = document.getElementById('theme-select');
  if (sel) {
    sel.innerHTML = THEMES.map(th => `<option value="${th.value}">${th.label}</option>`).join('');
    sel.value = t;
    sel.addEventListener('change', () => applyTheme(sel.value));
  }
})();

// ── Config tab constants ──────────────────────────────────────────────────────

const CATEGORY_LABELS = {
  channels:    'Commands',
  timing:      'Job Timing',
  thresholds:  'Thresholds',
  permissions: 'Permissions',
  scan_modes:  'Scan Modes',
};

const JOB_CHANNEL_KEYS = new Set([
  'SCAN_REMINDER_CHANNEL_ID', 'WEEKLY_SUMMARY_CHANNEL_ID',
  'ANNIVERSARY_CHANNEL_ID', 'BIRTHDAY_CHANNEL_ID', 'GENERAL_CHANNEL_ID',
]);

function channelOptions(selectedId) {
  return '<option value="">— not set —</option>' + state.channelList.map(ch => {
    const cleanName = ch.name.replace(/[^\w\s#\-]/gu, '').trim();
    const sel = ch.id === selectedId ? ' selected' : '';
    return `<option value="${ch.id}"${sel}>${cleanName} (${ch.id})</option>`;
  }).join('');
}

let activeTab = 'channels';

// ── Boot / init ───────────────────────────────────────────────────────────────

async function init() {
  const [configRes, channelsRes, rolesRes, jobsRes, sjRes, commandsRes] = await Promise.all([
    fetch('/api/config').then(r => r.json()),
    fetch('/api/channels').then(r => r.json()),
    fetch('/api/roles').then(r => r.json()),
    fetch('/api/jobs').then(r => r.json()),
    fetch('/api/scheduled-jobs').then(r => r.json()),
    fetch('/api/commands').then(r => r.json()),
  ]);

  state.COMMAND_SUBS = commandsRes;
  state.allConfig    = configRes;
  state.channelList  = channelsRes.channels ?? [];
  state.roleList     = rolesRes.roles ?? [];

  if (channelsRes.fetched_at) {
    document.getElementById('channelsFetchedAt').textContent =
      'Channel list fetched: ' + channelsRes.fetched_at.slice(0, 10);
  }

  renderTabs();
  renderAllSections();
  renderScheduledJobs(sjRes);
  renderJobs(jobsRes);
  await loadReactions();
  await loadMembers();
  await loadSeasons();
  await loadPermissions();
  populatePermCommands();
  populatePermCheckboxes();
  await loadDreamBosses().catch(e => console.warn('DR Bosses load failed:', e));
  loadBotStatus();
}

// ── Tab rendering ─────────────────────────────────────────────────────────────

function renderTabs() {
  const categories = [...new Set(state.allConfig.map(c => c.category))];
  const tabsEl     = document.getElementById('tabs');
  tabsEl.innerHTML = '';

  for (const cat of categories) {
    const btn = document.createElement('button');
    btn.className = 'tab' + (cat === activeTab ? ' active' : '');
    btn.textContent = CATEGORY_LABELS[cat] ?? cat;
    btn.onclick = () => switchTab(cat);
    tabsEl.appendChild(btn);
  }

  const extras = [
    { id: 'reactions',     label: 'Reactions',       local: false },
    { id: 'scheduledjobs', label: 'Scheduled Jobs',  local: false },
    { id: 'jobs',          label: 'Job Runs',         local: false },
    { id: 'members',       label: 'Members',          local: false },
    { id: 'warbands',      label: 'Warbands',         local: false },
    { id: 'dreambosses',   label: 'DR Bosses',        local: false },
    { id: 'seasons',       label: 'Seasons',          local: false },
    { id: 'access',        label: 'Access',           local: true  },
  ];
  for (const { id, label, local } of extras) {
    const btn = document.createElement('button');
    btn.className = 'tab' + (local ? ' needs-local' : '') + (activeTab === id ? ' active' : '');
    btn.textContent = label;
    btn.onclick = () => switchTab(id);
    tabsEl.appendChild(btn);
  }
}

function switchTab(cat) {
  activeTab = cat;
  closeNav();
  document.querySelectorAll('.tab').forEach((t, i) => {
    const cats = [...new Set(state.allConfig.map(c => c.category)), 'reactions', 'scheduledjobs', 'jobs', 'members', 'warbands', 'dreambosses', 'seasons', 'access'];
    t.classList.toggle('active', cats[i] === cat);
  });
  if (cat === 'access') loadAccess();
  document.querySelectorAll('.section').forEach(s => {
    s.classList.toggle('visible', s.id === 'section-' + cat);
  });
}

// ── Config sections ───────────────────────────────────────────────────────────

function renderAllSections() {
  const container  = document.getElementById('sections');
  container.innerHTML = '';
  const categories = [...new Set(state.allConfig.map(c => c.category))];

  for (const cat of categories) {
    const entries = state.allConfig.filter(c => c.category === cat && !JOB_CHANNEL_KEYS.has(c.key));
    const section = document.createElement('div');
    section.className = 'section' + (cat === activeTab ? ' visible' : '');
    section.id = 'section-' + cat;
    section.innerHTML = `<div class="section-title">${CATEGORY_LABELS[cat] ?? cat}</div>`;

    const card = document.createElement('div');
    card.className = 'panel-card';

    const table = document.createElement('table');
    table.innerHTML = `<thead><tr>
      <th>Setting</th><th>Description</th><th>Value</th><th>Source</th><th></th>
    </tr></thead>`;
    const tbody = document.createElement('tbody');
    for (const entry of entries) tbody.appendChild(buildRow(entry, cat));
    table.appendChild(tbody);
    card.appendChild(table);
    section.appendChild(card);
    container.appendChild(section);
  }
}

function buildRow(entry, cat) {
  const tr = document.createElement('tr');
  tr.id = 'row-' + entry.key;
  if (cat === 'scan_modes' || entry.key === 'SCAN_AUTHORIZED_USER') tr.classList.add('needs-local');

  const inputId = 'input-' + entry.key;

  // label col
  const tdLabel = document.createElement('td');
  tdLabel.className = 'label-col';
  tdLabel.textContent = entry.label;

  // desc col
  const tdDesc = document.createElement('td');
  tdDesc.className = 'desc-col';
  tdDesc.textContent = entry.description;

  // value col — build input via DOM to avoid inline event handlers (CSP blocks script-src-attr)
  const tdVal = document.createElement('td');
  tdVal.className = 'val-col';

  if (cat === 'channels') {
    const filterInput = document.createElement('input');
    filterInput.className = 'channel-filter';
    filterInput.type = 'text';
    filterInput.id = 'filter-' + entry.key;
    filterInput.placeholder = 'Filter channels...';
    filterInput.style.marginBottom = '4px';
    filterInput.addEventListener('input', () => filterChannel(entry.key));

    const sel = document.createElement('select');
    sel.id = inputId;
    sel.dataset.key = entry.key;
    const blankOpt = document.createElement('option');
    blankOpt.value = '';
    blankOpt.textContent = '— not set —';
    sel.appendChild(blankOpt);
    for (const ch of state.channelList) {
      const opt = document.createElement('option');
      opt.value = ch.id;
      opt.textContent = ch.name.replace(/[^\w\s#\-]/gu, '').trim() + ' (' + ch.id + ')';
      if (ch.id === entry.value) opt.selected = true;
      sel.appendChild(opt);
    }
    tdVal.appendChild(filterInput);
    tdVal.appendChild(sel);
  } else if (cat === 'timing') {
    const inp = document.createElement('input');
    inp.type = 'time';
    inp.id = inputId;
    inp.value = entry.value || '';
    inp.dataset.key = entry.key;
    tdVal.appendChild(inp);
  } else if (cat === 'scan_modes') {
    const sel = document.createElement('select');
    sel.id = inputId;
    sel.dataset.key = entry.key;
    const offOpt = document.createElement('option');
    offOpt.value = 'false';
    offOpt.textContent = 'Off';
    if (entry.value !== 'true') offOpt.selected = true;
    const onOpt = document.createElement('option');
    onOpt.value = 'true';
    onOpt.textContent = 'On';
    if (entry.value === 'true') onOpt.selected = true;
    sel.appendChild(offOpt);
    sel.appendChild(onOpt);
    tdVal.appendChild(sel);
  } else if (cat === 'thresholds') {
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.id = inputId;
    inp.value = entry.value || '';
    inp.min = '1';
    inp.dataset.key = entry.key;
    inp.style.width = '80px';
    tdVal.appendChild(inp);
  } else {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.id = inputId;
    inp.value = entry.value || '';
    inp.dataset.key = entry.key;
    inp.placeholder = 'Discord user ID';
    tdVal.appendChild(inp);
  }

  // badge col
  const configBadgeClass = { DB: 'config-badge-db', ENV: 'config-badge-env', DEFAULT: 'config-badge-default' }[entry.source] || 'config-badge-default';
  const tdBadge = document.createElement('td');
  tdBadge.className = 'config-badge-col';
  const badge = document.createElement('span');
  badge.className = 'config-badge ' + configBadgeClass;
  badge.id = 'config-badge-' + entry.key;
  badge.textContent = entry.source;
  tdBadge.appendChild(badge);

  // action col
  const tdAction = document.createElement('td');
  tdAction.className = 'action-col';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'save-btn';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', () => saveKey(entry.key));
  tdAction.appendChild(saveBtn);

  if (entry.source === 'DB') {
    tdAction.appendChild(makeResetBtn(entry.key));
  }

  const flashSpan = document.createElement('span');
  flashSpan.className = 'saved-flash';
  flashSpan.id = 'flash-' + entry.key;
  flashSpan.textContent = 'Saved!';
  tdAction.appendChild(flashSpan);

  tr.appendChild(tdLabel);
  tr.appendChild(tdDesc);
  tr.appendChild(tdVal);
  tr.appendChild(tdBadge);
  tr.appendChild(tdAction);
  return tr;
}

function makeResetBtn(key) {
  const btn = document.createElement('button');
  btn.className = 'reset-btn';
  btn.title = 'Remove DB override, revert to ENV/DEFAULT';
  btn.textContent = '✕';
  btn.addEventListener('click', () => resetKey(key));
  return btn;
}

function filterChannel(key) {
  const filter = document.getElementById('filter-' + key).value.toLowerCase();
  const select = document.getElementById('input-' + key);
  for (const opt of select.options) {
    opt.hidden = filter && !opt.text.toLowerCase().includes(filter);
  }
}

async function saveKey(key) {
  const input = document.getElementById('input-' + key);
  const value = input.value;
  const res   = await fetch('/api/config/' + key, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  const data = await res.json();
  if (!data.ok) { alert('Save failed: ' + data.error); return; }
  updateBadge(key, 'DB');
  flash(key);
  const tr = document.getElementById('row-' + key);
  if (!tr.querySelector('.reset-btn')) {
    tr.querySelector('.action-col').insertBefore(makeResetBtn(key), tr.querySelector('.saved-flash'));
  }
}

async function resetKey(key) {
  const res  = await fetch('/api/config/' + key, { method: 'DELETE' });
  const data = await res.json();
  if (!data.ok) { alert('Reset failed: ' + data.error); return; }
  const configs = await fetch('/api/config').then(r => r.json());
  const entry   = configs.find(c => c.key === key);
  if (entry) {
    const input = document.getElementById('input-' + key);
    if (input) input.value = entry.value || '';
    updateBadge(key, entry.source);
  }
  const tr = document.getElementById('row-' + key);
  tr.querySelector('.reset-btn')?.remove();
  flash(key, 'Reset!');
}

function updateBadge(key, source) {
  const badge = document.getElementById('config-badge-' + key);
  if (!badge) return;
  badge.textContent = source;
  badge.className = 'config-badge ' + ({ DB: 'config-badge-db', ENV: 'config-badge-env', DEFAULT: 'config-badge-default' }[source] || 'config-badge-default');
}

function flash(key, msg = 'Saved!') {
  const el = document.getElementById('flash-' + key);
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2000);
}

// ── Bot status ────────────────────────────────────────────────────────────────

async function restartBot() {
  const btn    = document.getElementById('restartBtn');
  const status = document.getElementById('restartStatus');
  btn.disabled  = true;
  btn.textContent = '⟳ Restarting...';
  status.textContent = '';
  try {
    const res  = await fetch('/api/bot/restart', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      status.textContent = 'Restarted!';
      btn.textContent = '⟳ Restart Bot';
      setTimeout(() => { status.textContent = ''; }, 5000);
    } else {
      status.textContent = 'Failed — check PM2 logs';
      btn.textContent = '⟳ Restart Bot';
    }
  } catch {
    status.textContent = 'Error — is PM2 running?';
    btn.textContent = '⟳ Restart Bot';
  }
  btn.disabled = false;
}

function fmtUptime(ms) {
  if (ms == null || ms < 0) return '--';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

async function loadBotStatus() {
  try {
    const data = await fetch('/api/bot-status').then(r => r.json());
    const dot  = document.getElementById('statusDot');
    dot.className = 'status-dot ' + (data.status === 'online' ? 'status-online' : data.status === 'stopped' ? 'status-stopped' : 'status-other');
    document.getElementById('statStatus').textContent = data.status ?? '--';
    document.getElementById('statCpu').textContent    = data.cpu != null ? data.cpu + '%' : '--';
    document.getElementById('statMemory').textContent = data.memory ? (data.memory / 1024 / 1024).toFixed(1) + ' MB' : '--';
    document.getElementById('statUptime').textContent = fmtUptime(data.uptime_ms);
    const footerStatus = document.getElementById('footerBotStatus');
    if (footerStatus) footerStatus.textContent = `Bot ${data.status ?? '--'} · uptime ${fmtUptime(data.uptime_ms)}`;
  } catch {
    document.getElementById('statStatus').textContent = 'unavailable';
  }
}

// ── Window assignments (HTML onclick handlers need globals) ───────────────────

Object.assign(window, {
  logout, toggleNav, closeNav,
  setJobChannel, toggleScheduledJob, saveScheduledJob, filterJobs, sortJobs,
  filterChannel, saveKey, resetKey,
  restartBot, applyTheme,
  openReactionForm, cancelReactionForm, saveReactionRule, deleteReactionRule,
  updatePreview, rxPatternTypeChange, rxResponseTypeChange, rxSyncColorPicker,
  rxFilterSelect, rxInsert, refreshDiscordData,
  renderMembers, approveMember, renameMember, linkMember, mergeMemberPrompt,
  setWarband, setIngameId, addWarband, renameWarbandUI, archiveWarband,
  addSeason, toggleSeason, deleteSeason, toggleServerPanel,
  bulkAddServers, removeServer, addDreamBoss, updateDreamBoss, deleteDreamBoss,
  permCommandChanged, permPickRole, permPickChannel, permRemoveRole, permRemoveChannel,
  addPermRule, deletePermRule, removePermGroup, editPermGroup, cancelPermEdit,
  setOpTier, setRoleTierUI,
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

(async function bootstrap() {
  let me;
  try {
    const res = await _origFetch('/auth/me');
    if (!res.ok) return showLogin();
    me = await res.json();
  } catch { return showLogin('Could not reach the server.'); }
  applyAccess(me);
  setupMobileChrome(_mobileMQ);
  _mobileMQ.addEventListener('change', setupMobileChrome);

  // Static HTML handlers (CSP blocks onclick= attributes)
  document.getElementById('logoutBtn')?.addEventListener('click', logout);
  document.getElementById('restartBtn')?.addEventListener('click', restartBot);
  document.getElementById('navToggle')?.addEventListener('click', toggleNav);
  document.getElementById('navBackdrop')?.addEventListener('click', closeNav);

  document.getElementById('rxAddBtn')?.addEventListener('click', () => openReactionForm(null));
  document.getElementById('rxSaveBtn')?.addEventListener('click', saveReactionRule);
  document.getElementById('rxCancelBtn')?.addEventListener('click', cancelReactionForm);
  document.getElementById('rxRefreshBtn')?.addEventListener('click', refreshDiscordData);
  document.getElementById('rx-pattern-type')?.addEventListener('change', rxPatternTypeChange);
  document.getElementById('rx-response-type')?.addEventListener('change', rxResponseTypeChange);
  document.getElementById('rx-response-content')?.addEventListener('input', updatePreview);
  document.getElementById('rx-resp-channel-filter')?.addEventListener('input', e => rxFilterSelect('rx-response-channel', e.target.value));
  document.getElementById('rx-embed-title')?.addEventListener('input', updatePreview);
  document.getElementById('rx-embed-color-picker')?.addEventListener('input', e => { document.getElementById('rx-embed-color').value = e.target.value; updatePreview(); });
  document.getElementById('rx-embed-color')?.addEventListener('input', () => { rxSyncColorPicker(); updatePreview(); });
  document.getElementById('rx-embed-description')?.addEventListener('input', updatePreview);
  document.getElementById('rx-ch-filter')?.addEventListener('input', e => rxFilterSelect('rx-channel-filter-select', e.target.value));

  document.getElementById('sort-th-name')?.addEventListener('click', () => sortJobs('name'));
  document.getElementById('sort-th-sent_at')?.addEventListener('click', () => sortJobs('sent_at'));
  document.getElementById('sort-th-late')?.addEventListener('click', () => sortJobs('late'));
  document.getElementById('jf-name')?.addEventListener('input', e => filterJobs('name', e.target.value));
  document.getElementById('jf-sent_at')?.addEventListener('input', e => filterJobs('sent_at', e.target.value));
  document.getElementById('jf-late')?.addEventListener('input', e => filterJobs('late', e.target.value));

  document.getElementById('memberFilter')?.addEventListener('input', renderMembers);
  document.getElementById('addWarbandBtn')?.addEventListener('click', addWarband);
  document.getElementById('addSeasonBtn')?.addEventListener('click', addSeason);
  document.getElementById('addDreamBossBtn')?.addEventListener('click', addDreamBoss);

  document.getElementById('perm-command')?.addEventListener('change', permCommandChanged);
  document.getElementById('perm-role-pick')?.addEventListener('change', permPickRole);
  document.getElementById('perm-channel-pick')?.addEventListener('change', permPickChannel);
  document.getElementById('perm-add-btn')?.addEventListener('click', addPermRule);
  document.getElementById('perm-cancel-btn')?.addEventListener('click', cancelPermEdit);

  init();
})();
