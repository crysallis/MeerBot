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

const DOW = [['1','Mon'],['2','Tue'],['3','Wed'],['4','Thu'],['5','Fri'],['6','Sat'],['7','Sun']];

function dowPicker(id, selectedCsv) {
  const selected = new Set((selectedCsv || '1,2,3,4,5,6,7').split(',').filter(Boolean));
  const wrap = document.createElement('div');
  wrap.className = 'dow-picker';
  wrap.id = id;
  for (const [val, label] of DOW) {
    const chip = document.createElement('span');
    chip.className = 'dow-chip' + (selected.has(val) ? ' selected' : '');
    chip.textContent = label;
    chip.dataset.value = val;
    chip.addEventListener('click', () => chip.classList.toggle('selected'));
    wrap.appendChild(chip);
  }
  return wrap;
}

function readDowPicker(id) {
  const wrap = document.getElementById(id);
  const values = [...wrap.querySelectorAll('.dow-chip.selected')].map(c => c.dataset.value);
  return values.length === 7 ? null : values.join(',');
}

function mentionsPicker(id, selectedMentions) {
  const selected = selectedMentions || [];
  const wrap = document.createElement('div');
  wrap.className = 'mentions-picker';
  wrap.id = id;

  const isSelected = (type, roleId) => selected.some(m => m.type === type && (type !== 'role' || m.id === roleId));

  for (const type of ['everyone', 'here']) {
    const chip = document.createElement('span');
    chip.className = 'mention-chip' + (isSelected(type) ? ' selected' : '');
    chip.textContent = '@' + type;
    chip.dataset.type = type;
    chip.addEventListener('click', () => chip.classList.toggle('selected'));
    wrap.appendChild(chip);
  }

  for (const r of state.roleList.filter(r => r.name !== '@everyone' && !r.managed)) {
    const chip = document.createElement('span');
    chip.className = 'mention-chip' + (isSelected('role', r.id) ? ' selected' : '');
    chip.textContent = '@' + r.name;
    chip.dataset.type = 'role';
    chip.dataset.id = r.id;
    chip.addEventListener('click', () => chip.classList.toggle('selected'));
    wrap.appendChild(chip);
  }

  return wrap;
}

function readMentionsPicker(id) {
  const wrap = document.getElementById(id);
  return [...wrap.querySelectorAll('.mention-chip.selected')].map(c => ({
    type: c.dataset.type,
    ...(c.dataset.type === 'role' ? { id: c.dataset.id } : {}),
  }));
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

    if (job.type === 'text_job') {
      const chField = document.createElement('div');
      chField.className = 'sj-field';
      chField.innerHTML = '<label>Posts to</label>';
      const chSel = document.createElement('select');
      chSel.id = `tj-channel-${job.id}`;
      chSel.innerHTML = channelOptions(job.channel_id);
      chField.appendChild(chSel);
      fields.appendChild(chField);

      const dowField = document.createElement('div');
      dowField.className = 'sj-field';
      dowField.innerHTML = '<label>Days</label>';
      dowField.appendChild(dowPicker(`tj-dow-${job.id}`, job.days_of_week));
      fields.appendChild(dowField);

      const titleField = document.createElement('div');
      titleField.className = 'sj-field';
      titleField.style.flexBasis = '100%';
      titleField.innerHTML = '<label>Title</label>';
      const titleInput = document.createElement('input');
      titleInput.type = 'text';
      titleInput.id = `tj-title-${job.id}`;
      titleInput.value = job.title || '';
      titleInput.style.width = '100%';
      titleField.appendChild(titleInput);
      fields.appendChild(titleField);

      const bodyField = document.createElement('div');
      bodyField.className = 'sj-field';
      bodyField.style.flexBasis = '100%';
      bodyField.innerHTML = '<label>Body</label>';
      const bodyInput = document.createElement('textarea');
      bodyInput.id = `tj-body-${job.id}`;
      bodyInput.rows = 4;
      bodyInput.style.width = '100%';
      bodyInput.value = job.body || '';
      bodyField.appendChild(bodyInput);
      fields.appendChild(bodyField);

      const mentionsField = document.createElement('div');
      mentionsField.className = 'sj-field';
      mentionsField.style.flexBasis = '100%';
      mentionsField.innerHTML = '<label>Mentions (pings on send)</label>';
      mentionsField.appendChild(mentionsPicker(`tj-mentions-${job.id}`, job.mentions));
      fields.appendChild(mentionsField);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'reset-btn';
      deleteBtn.textContent = 'Delete Job';
      deleteBtn.addEventListener('click', () => deleteTextJob(job.id));
      header.appendChild(deleteBtn);
    }

    // Save button field
    const saveField = document.createElement('div');
    saveField.className = 'sj-field';
    saveField.style.cssText = 'margin-left:auto;align-items:flex-end';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'save-btn';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => job.type === 'text_job' ? saveTextJobFull(job.id) : saveScheduledJob(job.id));
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

export async function saveTextJobFull(id) {
  await saveScheduledJob(id); // schedule/recurrence fields, existing behavior

  const payload = {
    channel_id: document.getElementById(`tj-channel-${id}`).value,
    title:      document.getElementById(`tj-title-${id}`).value,
    body:       document.getElementById(`tj-body-${id}`).value,
    days_of_week: readDowPicker(`tj-dow-${id}`),
    mentions:   readMentionsPicker(`tj-mentions-${id}`),
  };
  if (!payload.body.trim()) { alert('Body is required.'); return; }

  const res = await fetch(`/api/text-jobs/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) { alert('Save failed: ' + data.error); return; }

  const flashEl = document.getElementById(`sj-flash-${id}`);
  if (flashEl) { flashEl.classList.add('show'); setTimeout(() => flashEl.classList.remove('show'), 2000); }
}

export async function deleteTextJob(id) {
  if (!confirm('Delete this job? This cannot be undone.')) return;
  const res = await fetch(`/api/text-jobs/${id}`, { method: 'DELETE' });
  const data = await res.json();
  if (!data.ok) { alert('Delete failed: ' + data.error); return; }
  const sjRes = await fetch('/api/scheduled-jobs').then(r => r.json());
  renderScheduledJobs(sjRes);
}

export function toggleCreateJobForm() {
  const form = document.getElementById('cjForm');
  const isHidden = form.style.display === 'none';
  form.style.display = isHidden ? 'block' : 'none';
  if (isHidden) renderCreateJobForm();
}

export function renderCreateJobForm() {
  const form = document.getElementById('cjForm');
  form.innerHTML = '';

  const nameField = document.createElement('div');
  nameField.className = 'sj-field';
  nameField.innerHTML = '<label>Job Name</label>';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.id = 'cj-name';
  nameField.appendChild(nameInput);

  const chField = document.createElement('div');
  chField.className = 'sj-field';
  chField.innerHTML = '<label>Posts to</label>';
  const chSel = document.createElement('select');
  chSel.id = 'cj-channel';
  chSel.innerHTML = channelOptions('');
  chField.appendChild(chSel);

  const fireField = document.createElement('div');
  fireField.className = 'sj-field';
  fireField.innerHTML = '<label>First Fire (your local time)</label>';
  const fireInput = document.createElement('input');
  fireInput.type = 'datetime-local';
  fireInput.id = 'cj-fire';
  fireField.appendChild(fireInput);

  const recurField = document.createElement('div');
  recurField.className = 'sj-field';
  recurField.innerHTML = '<label>Repeat every</label>';
  const recurRow = document.createElement('div');
  recurRow.className = 'sj-recur-row';
  const countInput = document.createElement('input');
  countInput.type = 'number'; countInput.id = 'cj-count'; countInput.value = '1'; countInput.min = '1';
  countInput.style.width = '60px';
  const unitSel = document.createElement('select');
  unitSel.id = 'cj-unit';
  for (const [val, label] of [['daily', 'Day(s)'], ['weekly', 'Week(s)']]) {
    const opt = document.createElement('option'); opt.value = val; opt.textContent = label;
    unitSel.appendChild(opt);
  }
  recurRow.append(countInput, unitSel);
  recurField.appendChild(recurRow);

  const dowField = document.createElement('div');
  dowField.className = 'sj-field';
  dowField.innerHTML = '<label>Days</label>';
  dowField.appendChild(dowPicker('cj-dow', null));

  const titleField = document.createElement('div');
  titleField.className = 'sj-field';
  titleField.style.flexBasis = '100%';
  titleField.innerHTML = '<label>Title</label>';
  const titleInput = document.createElement('input');
  titleInput.type = 'text'; titleInput.id = 'cj-title'; titleInput.style.width = '100%';
  titleField.appendChild(titleInput);

  const bodyField = document.createElement('div');
  bodyField.className = 'sj-field';
  bodyField.style.flexBasis = '100%';
  bodyField.innerHTML = '<label>Body</label>';
  const bodyInput = document.createElement('textarea');
  bodyInput.id = 'cj-body'; bodyInput.rows = 4; bodyInput.style.width = '100%';
  bodyField.appendChild(bodyInput);

  const mentionsField = document.createElement('div');
  mentionsField.className = 'sj-field';
  mentionsField.style.flexBasis = '100%';
  mentionsField.innerHTML = '<label>Mentions (pings on send)</label>';
  mentionsField.appendChild(mentionsPicker('cj-mentions', []));

  const actionsField = document.createElement('div');
  actionsField.className = 'sj-field';
  const createBtn = document.createElement('button');
  createBtn.className = 'save-btn';
  createBtn.textContent = 'Create Job';
  createBtn.addEventListener('click', submitNewTextJob);
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'reset-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => { form.style.display = 'none'; });
  actionsField.append(createBtn, cancelBtn);

  const fields = document.createElement('div');
  fields.className = 'sj-fields';
  fields.append(nameField, chField, fireField, recurField, dowField, titleField, bodyField, mentionsField, actionsField);
  form.appendChild(fields);
}

export async function submitNewTextJob() {
  const fireLocal = document.getElementById('cj-fire').value;
  if (!fireLocal) { alert('Please set a first fire time.'); return; }

  const payload = {
    name:       document.getElementById('cj-name').value,
    channel_id: document.getElementById('cj-channel').value,
    title:      document.getElementById('cj-title').value,
    body:       document.getElementById('cj-body').value,
    fire_at:    new Date(fireLocal).toISOString(),
    recurrence: `${document.getElementById('cj-unit').value}:${document.getElementById('cj-count').value}`,
    days_of_week: readDowPicker('cj-dow'),
    mentions:   readMentionsPicker('cj-mentions'),
  };

  const res = await fetch('/api/text-jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) { alert('Create failed: ' + data.error); return; }

  document.getElementById('cjForm').style.display = 'none';
  const sjRes = await fetch('/api/scheduled-jobs').then(r => r.json());
  renderScheduledJobs(sjRes);
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
