import { state } from './state.js';
import { escHtml } from './utils.js';

let allReactions = [];
let editingRxId  = null;

export async function loadReactions() {
  allReactions = await fetch('/api/message-reactions').then(r => r.json());
  renderReactionsTable();
}

export function renderReactionsTable() {
  const tbody = document.getElementById('rxTableBody');
  if (!tbody) return;
  if (!allReactions.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:var(--color-neutral-content)">No rules yet. Click + Add Rule to create one.</td></tr>';
    return;
  }

  const PTYPES = { contains:'contains', exact:'exact', regex:'regex', mention:'@mention' };
  const RTYPES = { reply:'reply', message:'message', emoji:'emoji react', dm:'DM sender' };

  tbody.innerHTML = allReactions.map(r => {
    const trigger = r.pattern_type === 'mention' ? '<em>@mention</em>' : `<code>${escHtml(r.pattern)}</code> <span style="color:var(--color-neutral-content);font-size:11px">(${PTYPES[r.pattern_type]??r.pattern_type})</span>`;
    const response = `${RTYPES[r.response_type]??r.response_type}: <code>${escHtml(r.response_content||'')}</code>`;
    let scope = 'all channels';
    if (r.channel_filter) {
      const ids = JSON.parse(r.channel_filter);
      scope = ids.map(id => {
        const ch = state.channelList.find(c => c.id === id);
        return ch ? `#${ch.name}` : id;
      }).join(', ');
    }
    const status = r.enabled
      ? '<span style="color:var(--color-success);font-weight:600">ON</span>'
      : '<span style="color:var(--color-neutral-content);text-decoration:line-through">OFF</span>';
    return `<tr>
      <td style="font-weight:600;color:var(--color-base-content)">${escHtml(r.name)}</td>
      <td>${trigger}</td>
      <td>${response}</td>
      <td style="font-size:12px;color:var(--color-neutral-content)">${escHtml(scope)}</td>
      <td style="font-size:12px">${r.cooldown_seconds}s</td>
      <td>${status}</td>
      <td style="white-space:nowrap">
        <button class="save-btn" onclick="openReactionForm(${r.id})" style="font-size:11px;padding:4px 8px">Edit</button>
        <button class="reset-btn" onclick="deleteReactionRule(${r.id})" style="margin-left:4px">Delete</button>
      </td>
    </tr>`;
  }).join('');
}

export function renderDiscordMarkdown(text) {
  if (!text) return '<span style="color:var(--color-neutral-content);font-style:italic">Start typing to preview...</span>';
  let s = escHtml(text);
  s = s
    .replace(/\{user\}/gi,     '<span style="background:var(--discord-mention-bg);color:var(--discord-mention-fg);padding:1px 4px;border-radius:3px">@YourName</span>')
    .replace(/\{username\}/gi, '<span style="background:var(--discord-mention-bg);color:var(--discord-mention-fg);padding:1px 4px;border-radius:3px">YourName</span>')
    .replace(/\{server\}/gi,   '<span style="background:var(--discord-mention-bg);color:var(--discord-mention-fg);padding:1px 4px;border-radius:3px">RiffRaff</span>')
    .replace(/\{channel\}/gi,  '<span style="background:var(--discord-mention-bg);color:var(--discord-mention-fg);padding:1px 4px;border-radius:3px">#current-channel</span>');
  s = s.replace(/```(?:\w+\n)?([\s\S]*?)```/g, '<pre style="background:var(--discord-code-bg);padding:8px;border-radius:4px;font-size:12px;overflow-x:auto;margin:4px 0"><code>$1</code></pre>');
  s = s.replace(/`([^`]+)`/g, '<code style="background:var(--discord-code-bg);padding:1px 5px;border-radius:3px;font-size:12px">$1</code>');
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/_([^_]+)_/g, '<em>$1</em>');
  s = s.replace(/__(.+?)__/g, '<u>$1</u>');
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
  s = s.replace(/^&gt; (.+)/gm, '<div style="border-left:3px solid var(--discord-quote-border);padding-left:10px;color:var(--discord-fg-muted);margin:2px 0">$1</div>');
  s = s.replace(/&lt;#(\d+)&gt;/g, (_, id) => {
    const ch = state.channelList.find(c => c.id === id);
    return `<span style="background:var(--discord-mention-bg);color:var(--discord-mention-fg);padding:1px 4px;border-radius:3px">#${ch ? escHtml(ch.name) : id}</span>`;
  });
  s = s.replace(/&lt;@&amp;(\d+)&gt;/g, (_, id) => {
    const role = state.roleList.find(r => r.id === id);
    const color = role?.color && role.color !== '#000000' ? role.color : 'var(--discord-mention-fg)';
    return `<span style="background:var(--discord-mention-bg);color:${color};padding:1px 4px;border-radius:3px">@${role ? escHtml(role.name) : id}</span>`;
  });
  s = s.replace(/&lt;@(\d+)&gt;/g, '<span style="background:var(--discord-mention-bg);color:var(--discord-mention-fg);padding:1px 4px;border-radius:3px">@user</span>');
  s = s.replace(/\n/g, '<br>');
  return s;
}

export function updatePreview() {
  const content = document.getElementById('rx-response-content')?.value || '';
  const desc    = document.getElementById('rx-embed-description')?.value || '';
  const title   = document.getElementById('rx-embed-title')?.value || '';
  const color   = document.getElementById('rx-embed-color')?.value || '#4dabf7';
  const el      = document.getElementById('rx-preview');
  if (!el) return;

  let html = '';
  if (content) html += `<div style="margin-bottom:${(title||desc)?'8px':'0'}">${renderDiscordMarkdown(content)}</div>`;

  if (title || desc) {
    const borderColor = /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#4dabf7';
    html += `<div style="border-left:4px solid ${borderColor};background:var(--discord-bg-alt);border-radius:0 4px 4px 0;padding:10px 14px;margin-top:4px">`;
    if (title) html += `<div style="font-weight:600;color:var(--discord-fg-bright);margin-bottom:${desc?'6px':'0'}">${renderDiscordMarkdown(title)}</div>`;
    if (desc)  html += `<div style="font-size:13px;color:var(--discord-fg)">${renderDiscordMarkdown(desc)}</div>`;
    html += '</div>';
  }

  el.innerHTML = html || '<span style="color:var(--color-neutral-content);font-style:italic">Start typing to preview...</span>';
}

export function buildCheatSheet() {
  const fmtEl = document.getElementById('rx-fmt-chips');
  if (fmtEl) {
    const snippets = [
      { label: '**bold**',          insert: '**bold**'          },
      { label: '*italic*',          insert: '*italic*'          },
      { label: '__underline__',     insert: '__underline__'     },
      { label: '~~strike~~',        insert: '~~strikethrough~~' },
      { label: '`inline code`',     insert: '`code`'            },
      { label: '```code block```',  insert: '```\ncode\n```'    },
      { label: '> blockquote',      insert: '> '                },
    ];
    fmtEl.innerHTML = snippets.map((s, i) =>
      `<button data-idx="${i}" class="rx-fmt-chip" style="background:var(--discord-bg-alt);border:1px solid var(--border-color);color:var(--color-base-content);padding:3px 8px;border-radius:4px;cursor:pointer;font-size:12px;text-align:left;font-family:monospace">${escHtml(s.label)}</button>`
    ).join('');
    fmtEl.querySelectorAll('.rx-fmt-chip').forEach((btn, i) => {
      btn.addEventListener('click', () => rxInsert(snippets[i].insert));
    });
  }

  const varEl = document.getElementById('rx-var-chips');
  if (varEl) {
    const vars = [
      { label: '{user}',     desc: 'Pings the sender'       },
      { label: '{username}', desc: 'Display name, no ping'  },
      { label: '{server}',   desc: 'Server name'            },
      { label: '{channel}',  desc: 'Current channel'        },
    ];
    varEl.innerHTML = '';
    for (const v of vars) {
      const btn = document.createElement('button');
      btn.style.cssText = 'background:var(--discord-bg-alt);border:1px solid var(--border-color);color:var(--color-warning);padding:3px 8px;border-radius:4px;cursor:pointer;font-size:12px;text-align:left;font-family:monospace';
      btn.title = v.desc;
      btn.textContent = v.label;
      btn.addEventListener('click', () => rxInsert(v.label));
      varEl.appendChild(btn);
    }
  }

  const chEl = document.getElementById('rx-channel-chips');
  if (chEl) {
    chEl.innerHTML = state.channelList
      .map(c => `<button onclick="rxInsert('<#${c.id}>')" style="background:var(--discord-bg-alt);border:1px solid var(--border-color);color:var(--discord-mention-fg);padding:3px 8px;border-radius:4px;cursor:pointer;font-size:12px;text-align:left">#${escHtml(c.name)}</button>`)
      .join('');
  }

  const roEl = document.getElementById('rx-role-chips');
  if (roEl) {
    roEl.innerHTML = state.roleList
      .filter(r => r.name !== '@everyone' && !r.managed)
      .map(r => {
        const color = r.color && r.color !== '#000000' ? r.color : 'var(--discord-mention-fg)';
        return `<button onclick="rxInsert('<@&${r.id}>')" style="background:var(--discord-bg-alt);border:1px solid var(--border-color);color:${color};padding:3px 8px;border-radius:4px;cursor:pointer;font-size:12px;text-align:left">@${escHtml(r.name)}</button>`;
      })
      .join('');
  }
}

export function rxInsert(text) {
  const target = document._rxLastFocus;
  if (!target) return;
  const start = target.selectionStart ?? target.value.length;
  const end   = target.selectionEnd   ?? target.value.length;
  target.value = target.value.slice(0, start) + text + target.value.slice(end);
  target.selectionStart = target.selectionEnd = start + text.length;
  target.focus();
  updatePreview();
}

export async function refreshDiscordData() {
  const statusEl = document.getElementById('rx-refresh-status');
  statusEl.textContent = 'Refreshing...';
  statusEl.style.color = 'var(--color-neutral-content)';
  try {
    const res  = await fetch('/api/refresh-discord-data', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    const [chRes, roRes] = await Promise.all([
      fetch('/api/channels').then(r => r.json()),
      fetch('/api/roles').then(r => r.json()),
    ]);
    state.channelList = chRes.channels ?? [];
    state.roleList    = roRes.roles    ?? [];
    buildCheatSheet();
    populateRxChannelSelect('rx-channel-filter-select');
    statusEl.textContent = 'Refreshed!';
    statusEl.style.color = 'var(--color-success)';
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
  } catch (err) {
    statusEl.textContent = 'Failed: ' + err.message;
    statusEl.style.color = 'var(--color-error)';
  }
}

export function populateRxChannelSelect(selectId, selectedIds = []) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  sel.innerHTML = '';
  for (const ch of state.channelList) {
    const opt = document.createElement('option');
    opt.value = ch.id;
    opt.textContent = `#${ch.name} (${ch.id})`;
    if (selectedIds.includes(ch.id)) opt.selected = true;
    sel.appendChild(opt);
  }
}

export function populateRxResponseChannelSelect(selectedId = '') {
  const sel = document.getElementById('rx-response-channel');
  if (!sel) return;
  while (sel.options.length > 1) sel.remove(1);
  for (const ch of state.channelList) {
    const opt = document.createElement('option');
    opt.value = ch.id;
    opt.textContent = `#${ch.name} (${ch.id})`;
    if (ch.id === selectedId) opt.selected = true;
    sel.appendChild(opt);
  }
}

export function rxFilterSelect(selectId, filter) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const lc = filter.toLowerCase();
  for (const opt of sel.options) {
    if (!opt.value) continue;
    opt.hidden = lc && !opt.text.toLowerCase().includes(lc);
  }
}

export function rxSyncColorPicker() {
  const val = document.getElementById('rx-embed-color').value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(val)) {
    document.getElementById('rx-embed-color-picker').value = val;
  }
}

export function rxPatternTypeChange() {
  const type = document.getElementById('rx-pattern-type').value;
  const wrap = document.getElementById('rx-pattern-wrap');
  if (wrap) wrap.style.display = type === 'mention' ? 'none' : '';
}

export function rxResponseTypeChange() {
  const type = document.getElementById('rx-response-type').value;
  const label = document.getElementById('rx-content-label');
  const wrap  = document.getElementById('rx-resp-channel-wrap');
  if (label) label.textContent = type === 'emoji' ? 'Emoji Character *' : 'Response Content *';
  if (wrap)  wrap.style.display = type === 'message' ? '' : 'none';
}

export function openReactionForm(id) {
  editingRxId = id;
  const form = document.getElementById('rxForm');
  const title = document.getElementById('rxFormTitle');

  populateRxChannelSelect('rx-channel-filter-select');
  populateRxResponseChannelSelect();

  if (id === null) {
    title.textContent = 'Add Reaction Rule';
    document.getElementById('rx-name').value = '';
    document.getElementById('rx-pattern-type').value = 'contains';
    document.getElementById('rx-pattern').value = '';
    document.getElementById('rx-response-type').value = 'reply';
    document.getElementById('rx-response-content').value = '';
    document.getElementById('rx-cooldown').value = '60';
    document.getElementById('rx-ignore-case').checked = true;
    document.getElementById('rx-require-mention').checked = false;
    document.getElementById('rx-enabled').checked = true;
    document.getElementById('rx-embed-title').value = '';
    document.getElementById('rx-embed-description').value = '';
    document.getElementById('rx-embed-color').value = '';
    document.getElementById('rx-embed-color-picker').value = '#4dabf7';
    document.getElementById('rx-error').textContent = '';
    for (const opt of document.getElementById('rx-channel-filter-select').options) opt.selected = false;
  } else {
    const rule = allReactions.find(r => r.id === id);
    if (!rule) return;
    title.textContent = `Edit Rule · ${rule.name}`;
    document.getElementById('rx-name').value = rule.name;
    document.getElementById('rx-pattern-type').value = rule.pattern_type;
    document.getElementById('rx-pattern').value = rule.pattern;
    document.getElementById('rx-response-type').value = rule.response_type;
    document.getElementById('rx-response-content').value = rule.response_content;
    document.getElementById('rx-cooldown').value = rule.cooldown_seconds;
    document.getElementById('rx-ignore-case').checked = !!rule.ignore_case;
    document.getElementById('rx-require-mention').checked = !!rule.require_mention;
    document.getElementById('rx-enabled').checked = !!rule.enabled;
    document.getElementById('rx-error').textContent = '';

    document.getElementById('rx-embed-title').value = rule.embed_title || '';
    document.getElementById('rx-embed-description').value = rule.embed_description || '';
    const color = rule.embed_color || '';
    document.getElementById('rx-embed-color').value = color;
    if (/^#[0-9a-fA-F]{6}$/.test(color)) document.getElementById('rx-embed-color-picker').value = color;

    const selectedChannels = rule.channel_filter ? JSON.parse(rule.channel_filter) : [];
    for (const opt of document.getElementById('rx-channel-filter-select').options) {
      opt.selected = selectedChannels.includes(opt.value);
    }
    populateRxResponseChannelSelect(rule.response_channel || '');
  }

  rxPatternTypeChange();
  rxResponseTypeChange();
  form.style.display = '';
  buildCheatSheet();
  updatePreview();

  for (const elId of ['rx-response-content', 'rx-embed-title', 'rx-embed-description']) {
    const el = document.getElementById(elId);
    if (el) el.addEventListener('focus', () => { document._rxLastFocus = el; }, { once: false });
  }

  document.getElementById('rx-name').focus();
}

export function cancelReactionForm() {
  document.getElementById('rxForm').style.display = 'none';
  editingRxId = null;
}

export async function saveReactionRule() {
  const errEl = document.getElementById('rx-error');
  errEl.textContent = '';

  const name = document.getElementById('rx-name').value.trim();
  if (!name) { errEl.textContent = 'Name is required.'; return; }

  const pattern_type = document.getElementById('rx-pattern-type').value;
  const pattern      = document.getElementById('rx-pattern').value.trim();
  if (pattern_type !== 'mention' && !pattern) { errEl.textContent = 'Pattern is required.'; return; }

  const response_type    = document.getElementById('rx-response-type').value;
  const response_content = document.getElementById('rx-response-content').value.trim();
  const embed_title       = document.getElementById('rx-embed-title').value.trim();
  const embed_description = document.getElementById('rx-embed-description').value.trim();
  const embed_color       = document.getElementById('rx-embed-color').value.trim();

  if (!response_content && !embed_title && !embed_description && response_type !== 'emoji') {
    errEl.textContent = 'Provide response text, an embed title/description, or both.';
    return;
  }

  const selectedChannels = [...document.getElementById('rx-channel-filter-select').selectedOptions].map(o => o.value);
  const channel_filter   = selectedChannels.length ? JSON.stringify(selectedChannels) : null;
  const response_channel = document.getElementById('rx-response-channel')?.value || null;

  const body = {
    name, pattern, pattern_type,
    ignore_case:       document.getElementById('rx-ignore-case').checked,
    require_mention:   document.getElementById('rx-require-mention').checked,
    response_type, response_content,
    response_channel:  response_channel || null,
    channel_filter,
    cooldown_seconds:  parseInt(document.getElementById('rx-cooldown').value, 10) || 60,
    enabled:           document.getElementById('rx-enabled').checked,
    embed_title:       embed_title || null,
    embed_description: embed_description || null,
    embed_color:       embed_color || null,
  };

  const url    = editingRxId === null ? '/api/message-reactions' : `/api/message-reactions/${editingRxId}`;
  const method = editingRxId === null ? 'POST' : 'PUT';

  const res  = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!data.ok) { errEl.textContent = data.error || 'Save failed.'; return; }

  await loadReactions();
  cancelReactionForm();
}

export async function deleteReactionRule(id) {
  const rule = allReactions.find(r => r.id === id);
  if (!confirm(`Delete rule "${rule?.name ?? id}"?`)) return;
  const res  = await fetch(`/api/message-reactions/${id}`, { method: 'DELETE' });
  const data = await res.json();
  if (!data.ok) { alert('Delete failed: ' + data.error); return; }
  await loadReactions();
}
