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

    const card = document.createElement('div');
    card.className = 'sj-card';
    card.style.opacity = job.enabled ? '1' : '0.5';

    // Header row: name + toggle button
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px';
    const nameEl = document.createElement('div');
    nameEl.className = 'sj-name';
    nameEl.style.cssText = 'margin-bottom:0' + (!job.enabled ? ';text-decoration:line-through;color:var(--color-neutral-content)' : '');
    nameEl.textContent = job.display;
    const toggleBtn = document.createElement('button');
    toggleBtn.id = `sj-toggle-${job.id}`;
    toggleBtn.style.cssText = `background:${job.enabled ? 'var(--color-success)' : 'var(--color-base-300)'};color:#fff;border:none;padding:4px 12px;border-radius:5px;cursor:pointer;font-size:12px;font-weight:600`;
    toggleBtn.textContent = job.enabled ? 'Enabled' : 'Disabled';
    toggleBtn.addEventListener('click', () => toggleScheduledJob(job.id, job.enabled ? 0 : 1));
    header.append(nameEl, toggleBtn);

    // Fields
    const fields = document.createElement('div');
    fields.className = 'sj-fields';

    // Next fire field
    const fireField = document.createElement('div');
    fireField.className = 'sj-field';
    fireField.innerHTML = '<label>Next Fire (your local time)</label>';
    const fireInput = document.createElement('input');
    fireInput.type = 'datetime-local';
    fireInput.id = `sj-fire-${job.id}`;
    fireInput.value = utcToLocal(job.fire_at);
    fireField.appendChild(fireInput);

    // Recurrence field
    const recurField = document.createElement('div');
    recurField.className = 'sj-field';
    recurField.innerHTML = '<label>Repeat every</label>';
    const recurRow = document.createElement('div');
    recurRow.className = 'sj-recur-row';
    const countInput = document.createElement('input');
    countInput.type = 'number';
    countInput.id = `sj-count-${job.id}`;
    countInput.value = count;
    countInput.min = '1';
    countInput.style.width = '60px';
    const unitSel = document.createElement('select');
    unitSel.id = `sj-unit-${job.id}`;
    for (const [val, label] of [['daily', 'Day(s)'], ['weekly', 'Week(s)']]) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      if (unit === val) opt.selected = true;
      unitSel.appendChild(opt);
    }
    recurRow.append(countInput, unitSel);
    recurField.appendChild(recurRow);

    fields.append(fireField, recurField);

    // Optional "Posts to" channel field
    const chKey = JOB_CHANNEL_KEY[job.handler_path];
    if (chKey) {
      const chField = document.createElement('div');
      chField.className = 'sj-field';
      chField.innerHTML = '<label>Posts to</label>';
      const chSel = document.createElement('select');
      chSel.innerHTML = channelOptions(state.allConfig.find(c => c.key === chKey)?.value);
      chSel.addEventListener('change', () => setJobChannel(chKey, chSel.value));
      chField.appendChild(chSel);
      fields.appendChild(chField);
    }

    // Save button field
    const saveField = document.createElement('div');
    saveField.className = 'sj-field';
    saveField.style.cssText = 'margin-left:auto;align-items:flex-end';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'save-btn';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => saveScheduledJob(job.id));
    const flashSpan = document.createElement('span');
    flashSpan.className = 'saved-flash';
    flashSpan.id = `sj-flash-${job.id}`;
    flashSpan.textContent = 'Saved!';
    saveField.append(saveBtn, flashSpan);
    fields.appendChild(saveField);

    // UTC note
    const utcNote = document.createElement('div');
    utcNote.style.cssText = 'margin-top:10px;font-size:11px;color:var(--color-neutral-content)';
    utcNote.textContent = `Current next fire (UTC): ${job.fire_at.slice(0,16).replace('T',' ')}`;

    card.append(header, fields, utcNote);
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
