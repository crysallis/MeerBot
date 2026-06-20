import { state } from './state.js';
import { utcToLocal } from './utils.js';

let allJobRows = [];
let jobSort    = { col: 'sent_at', dir: 'desc' };
let jobFilters = { name: '', sent_at: '', late: '' };

function channelOptions(selectedId) {
  return '<option value="">— not set —</option>' + state.channelList.map(ch => {
    const cleanName = ch.name.replace(/[^\w\s#\-]/gu, '').trim();
    const sel = ch.id === selectedId ? ' selected' : '';
    return `<option value="${ch.id}"${sel}>${cleanName} (${ch.id})</option>`;
  }).join('');
}

export async function setJobChannel(key, value) {
  const res = await fetch('/api/config/' + key, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) { alert('Save failed: ' + ((await res.json().catch(() => ({}))).error || res.status)); return; }
  const e = state.allConfig.find(c => c.key === key);
  if (e) { e.value = value; e.source = value ? 'DB' : 'DEFAULT'; }
}

const JOB_CHANNEL_KEY = {
  './handlers/scanReminder':     'SCAN_REMINDER_CHANNEL_ID',
  './handlers/weeklySummary':    'WEEKLY_SUMMARY_CHANNEL_ID',
  './handlers/anniversaryCheck': 'ANNIVERSARY_CHANNEL_ID',
  './handlers/birthdayCheck':    'BIRTHDAY_CHANNEL_ID',
  './handlers/dailyReset':       'GENERAL_CHANNEL_ID',
};

export function renderScheduledJobs(jobs) {
  const container = document.getElementById('sjContainer');
  if (!jobs || !jobs.length) {
    container.innerHTML = '<p style="color:var(--color-neutral-content)">No system jobs found.</p>';
    return;
  }

  container.innerHTML = '';
  for (const job of jobs) {
    const [unit, n] = (job.recurrence || 'daily:1').split(':');
    const count = n || '1';

    const chKey = JOB_CHANNEL_KEY[job.handler_path];
    const chField = chKey ? `
        <div class="sj-field">
          <label>Posts to</label>
          <select onchange="setJobChannel('${chKey}', this.value)">${channelOptions(state.allConfig.find(c => c.key === chKey)?.value)}</select>
        </div>` : '';

    const card = document.createElement('div');
    card.className = 'sj-card';
    card.style.opacity = job.enabled ? '1' : '0.5';
    card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div class="sj-name" style="margin-bottom:0;${!job.enabled ? 'text-decoration:line-through;color:var(--color-neutral-content)' : ''}">${job.display}</div>
        <button id="sj-toggle-${job.id}" onclick="toggleScheduledJob(${job.id}, ${job.enabled ? 0 : 1})"
          style="background:${job.enabled ? 'var(--color-success)' : 'var(--color-base-300)'};color:#fff;border:none;padding:4px 12px;border-radius:5px;cursor:pointer;font-size:12px;font-weight:600">
          ${job.enabled ? 'Enabled' : 'Disabled'}
        </button>
      </div>
      <div class="sj-fields">
        <div class="sj-field">
          <label>Next Fire (your local time)</label>
          <input type="datetime-local" id="sj-fire-${job.id}" value="${utcToLocal(job.fire_at)}">
        </div>
        <div class="sj-field">
          <label>Repeat every</label>
          <div class="sj-recur-row">
            <input type="number" id="sj-count-${job.id}" value="${count}" min="1" style="width:60px">
            <select id="sj-unit-${job.id}">
              <option value="daily"  ${unit === 'daily'  ? 'selected' : ''}>Day(s)</option>
              <option value="weekly" ${unit === 'weekly' ? 'selected' : ''}>Week(s)</option>
            </select>
          </div>
        </div>${chField}
        <div class="sj-field" style="margin-left:auto;align-items:flex-end">
          <button class="save-btn" onclick="saveScheduledJob(${job.id})">Save</button>
          <span class="saved-flash" id="sj-flash-${job.id}">Saved!</span>
        </div>
      </div>
      <div style="margin-top:10px; font-size:11px; color:var(--color-neutral-content)">
        Current next fire (UTC): ${job.fire_at.slice(0,16).replace('T',' ')}
      </div>`;
    container.appendChild(card);
  }
}

export async function toggleScheduledJob(id, newEnabled) {
  const res  = await fetch(`/api/scheduled-jobs/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: newEnabled }),
  });
  const data = await res.json();
  if (!data.ok) { alert('Toggle failed: ' + data.error); return; }
  const sjRes = await fetch('/api/scheduled-jobs').then(r => r.json());
  renderScheduledJobs(sjRes);
}

export async function saveScheduledJob(id) {
  const fireLocal = document.getElementById(`sj-fire-${id}`).value;
  const count     = document.getElementById(`sj-count-${id}`).value;
  const unit      = document.getElementById(`sj-unit-${id}`).value;

  if (!fireLocal) { alert('Please set a next fire time.'); return; }
  const fireAt   = new Date(fireLocal).toISOString();
  const recurrence = `${unit}:${count}`;

  const res = await fetch(`/api/scheduled-jobs/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fire_at: fireAt, recurrence }),
  });
  const data = await res.json();
  if (!data.ok) { alert('Save failed: ' + data.error); return; }

  const card = document.getElementById(`sj-fire-${id}`).closest('.sj-card');
  const utcLine = card.querySelector('div[style*="margin-top"]');
  if (utcLine) utcLine.textContent = `Current next fire (UTC): ${fireAt.slice(0,16).replace('T',' ')}`;

  const flashEl = document.getElementById(`sj-flash-${id}`);
  if (flashEl) { flashEl.classList.add('show'); setTimeout(() => flashEl.classList.remove('show'), 2000); }
}

export function renderJobs(rows) {
  allJobRows = rows;
  applyJobView();
}

export function filterJobs(col, val) {
  jobFilters[col] = val.toLowerCase();
  applyJobView();
}

export function sortJobs(col) {
  if (jobSort.col === col) {
    jobSort.dir = jobSort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    jobSort.col = col;
    jobSort.dir = col === 'sent_at' ? 'desc' : 'asc';
  }
  updateSortArrows();
  applyJobView();
}

export function updateSortArrows() {
  for (const col of ['name', 'sent_at', 'late']) {
    const el = document.getElementById('sort-' + col);
    if (!el) continue;
    if (col === jobSort.col) {
      el.textContent = jobSort.dir === 'asc' ? '↑' : '↓';
      el.classList.add('active');
    } else {
      el.textContent = '↕';
      el.classList.remove('active');
    }
  }
}

export function applyJobView() {
  const tbody = document.getElementById('jobsBody');
  if (!allJobRows.length) {
    tbody.innerHTML = '<tr><td colspan="3" style="color:var(--color-neutral-content)">No runs recorded yet.</td></tr>';
    return;
  }

  const mapped = allJobRows.map(r => ({
    name:      r.name,
    sent_at:   r.sent_at ? r.sent_at.slice(0, 19).replace('T', ' ') : r.sent_date,
    late:      r.late ? 'yes' : '—',
    lateClass: r.late ? 'late-yes' : 'late-no',
  }));

  const filtered = mapped.filter(r =>
    r.name.toLowerCase().includes(jobFilters.name) &&
    r.sent_at.toLowerCase().includes(jobFilters.sent_at) &&
    r.late.toLowerCase().includes(jobFilters.late)
  );

  filtered.sort((a, b) => {
    const cmp = (a[jobSort.col] || '').localeCompare(b[jobSort.col] || '');
    return jobSort.dir === 'asc' ? cmp : -cmp;
  });

  tbody.innerHTML = filtered.length
    ? filtered.map(r => `
        <tr>
          <td>${r.name}</td>
          <td>${r.sent_at}</td>
          <td class="${r.lateClass}">${r.late}</td>
        </tr>`).join('')
    : '<tr><td colspan="3" style="color:var(--color-neutral-content)">No matches.</td></tr>';
}
