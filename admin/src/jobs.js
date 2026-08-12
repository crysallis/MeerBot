import { state } from './state.js';
import { utcToLocal } from './utils.js';
import { createChipPicker } from './chipPicker.js';

let allJobRows = [];
let jobSort    = { col: 'sent_at', dir: 'desc' };
let jobFilters = { name: '', sent_at: '', late: '' };

const mentionPickers = new Map(); // picker id -> chipPicker handle

// Marks a field invalid with a red border + message under it, or clears that
// state when message is falsy. Reuses the input's existing parent container
// (a .sj-field div) so the message sits directly beneath the field.
function setFieldError(input, message) {
  const field = input.closest('.sj-field') || input.parentElement;
  let msgEl = field.querySelector('.field-error-msg');
  if (message) {
    input.style.borderColor = 'var(--color-error)';
    if (!msgEl) {
      msgEl = document.createElement('div');
      msgEl.className = 'field-error-msg';
      msgEl.style.cssText = 'font-size:11px;color:var(--color-error);margin-top:4px';
      field.appendChild(msgEl);
    }
    msgEl.textContent = message;
  } else {
    input.style.borderColor = '';
    msgEl?.remove();
  }
}

function clearFieldErrors(inputs) {
  for (const input of inputs) setFieldError(input, '');
}

function formatTileFireTime(isoStr) {
  const d = new Date(isoStr);
  if (isNaN(d)) return '';
  const pad = n => String(n).padStart(2, '0');
  let hours = d.getHours();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${hours}:${pad(d.getMinutes())} ${ampm}`;
}

function formatUtcPreview(fireLocal) {
  if (!fireLocal) return '';
  const d = new Date(fireLocal);
  if (isNaN(d)) return '';
  const pad = n => String(n).padStart(2, '0');
  return `Will fire at ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC on ${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// Appends a live "will fire at HH:MM UTC" hint under a datetime-local input,
// updating as the user types -- the field itself always drives the actual
// scheduled UTC instant (see utils.js utcToLocal), this is just a preview.
function attachUtcPreview(fireInput) {
  const hint = document.createElement('div');
  hint.className = 'muted-note';
  hint.style.marginTop = '4px';
  hint.textContent = formatUtcPreview(fireInput.value);
  fireInput.addEventListener('input', () => {
    hint.textContent = formatUtcPreview(fireInput.value);
  });
  return hint;
}

function channelOptions(selectedId) {
  return '<option value="">— not set —</option>' + state.channelList.map(ch => {
    const sel = ch.id === selectedId ? ' selected' : '';
    return `<option value="${ch.id}"${sel}>${ch.name} (${ch.id})</option>`;
  }).join('');
}

const DOW = [['1','Mon'],['2','Tue'],['3','Wed'],['4','Thu'],['5','Fri'],['6','Sat'],['7','Sun']];
const MONTHLY_LAST_DAY = -1;

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
  if (values.length === 7) return null;
  if (values.length === 0) return '0'; // no valid ISO day (1-7) => shouldFireToday never matches
  return values.join(',');
}

// -1 is the "last day of month" sentinel -- distinct from picking 31, since
// 31 clamps to a short month's actual last day while -1 always means it.
function domPicker(id, selectedValue) {
  const sel = document.createElement('select');
  sel.id = id;
  const opts = [];
  for (let d = 1; d <= 31; d++) opts.push([String(d), String(d)]);
  opts.push(['-1', 'Last day of month']);
  for (const [val, label] of opts) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    if (String(selectedValue ?? 1) === val) opt.selected = true;
    sel.appendChild(opt);
  }
  return sel;
}

// Only meaningful when day_of_month is MONTHLY_LAST_DAY (-1). "On" needs no
// number (implicitly offset 0); "Before" reveals a required >=1 number input.
// The per-month clamp that prevents crossing into the previous month happens
// server-side in computeMonthlyNext -- this field has no client-side max.
function lastDayOffsetField(idPrefix, initialOffset) {
  const wrap = document.createElement('div');
  wrap.className = 'sj-field';
  wrap.id = `${idPrefix}-wrap`;
  wrap.innerHTML = '<label>Fire</label>';

  const row = document.createElement('div');
  row.className = 'sj-recur-row';

  const qualSel = document.createElement('select');
  qualSel.id = `${idPrefix}-qual`;
  for (const [val, label] of [['on', 'On'], ['before', 'Before']]) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    qualSel.appendChild(opt);
  }

  const numInput = document.createElement('input');
  numInput.type = 'number';
  numInput.id = `${idPrefix}-num`;
  numInput.min = '1';
  numInput.style.width = '60px';

  const initial = parseInt(initialOffset, 10) || 0;
  if (initial > 0) {
    qualSel.value = 'before';
    numInput.value = String(initial);
  } else {
    qualSel.value = 'on';
    numInput.value = '1';
    numInput.style.display = 'none';
  }

  qualSel.addEventListener('change', () => {
    numInput.style.display = qualSel.value === 'before' ? '' : 'none';
  });

  const daysLabel = document.createElement('span');
  daysLabel.textContent = 'day(s)';
  daysLabel.className = 'muted-note';

  row.append(qualSel, numInput, daysLabel);
  wrap.appendChild(row);
  return wrap;
}

// Reads the offset field built by lastDayOffsetField. Returns 0 for "On" or
// when the qualifier select isn't present (e.g. day-of-month isn't "last day").
function readLastDayOffset(idPrefix) {
  const qualSel = document.getElementById(`${idPrefix}-qual`);
  if (!qualSel || qualSel.value === 'on') return 0;
  const numInput = document.getElementById(`${idPrefix}-num`);
  const n = parseInt(numInput.value, 10);
  return isNaN(n) || n < 1 ? 1 : n;
}

function mentionsPicker(id, initialMentions) {
  const roleOptions = state.roleList
    .filter(r => r.name !== '@everyone' && !r.managed)
    .map(r => ({ value: `role:${r.id}`, label: '@' + r.name }));

  const options = [
    { value: 'everyone', label: '@everyone' },
    { value: 'here', label: '@here' },
    ...roleOptions,
  ];

  const initial = (initialMentions || []).map(m =>
    m.type === 'role'
      ? { value: `role:${m.id}`, label: '@' + (state.roleList.find(r => r.id === m.id)?.name ?? m.id) }
      : { value: m.type, label: '@' + m.type }
  );

  const picker = createChipPicker({ options, initial, placeholder: '-- add mention --' });
  mentionPickers.set(id, picker);
  return picker.el;
}

function readMentionsPicker(id) {
  return (mentionPickers.get(id)?.getSelected() ?? []).map(entry => {
    const [kind, roleId] = entry.value.split(':');
    return kind === 'role' ? { type: 'role', id: roleId } : { type: kind };
  });
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
    container.innerHTML = '<p class="muted-note">No system jobs found.</p>';
    return;
  }

  container.innerHTML = '';
  for (const job of jobs) {
    const [unit, n] = (job.recurrence || 'daily:1').split(':');
    const count = n || '1';

    const card = document.createElement('div');
    card.className = 'sj-card';
    card.style.opacity = job.enabled ? '1' : '0.5';

    // Tile summary: name, status badge, next fire (local) -- always visible,
    // click anywhere on it to expand/collapse the full editing form below.
    const tile = document.createElement('div');
    tile.className = 'sj-tile';
    const tileName = document.createElement('div');
    tileName.className = 'sj-tile-name' + (!job.enabled ? ' disabled' : '');
    tileName.textContent = job.display;
    const tileStatus = document.createElement('span');
    tileStatus.className = 'sj-tile-status' + (job.enabled ? ' enabled' : '');
    tileStatus.textContent = job.enabled ? 'Enabled' : 'Disabled';
    const tileFire = document.createElement('div');
    tileFire.className = 'sj-tile-fire';
    tileFire.textContent = formatTileFireTime(job.fire_at);
    tile.append(tileName, tileStatus, tileFire);
    tile.addEventListener('click', () => card.classList.toggle('expanded'));

    const toggleBtn = document.createElement('button');
    toggleBtn.id = `sj-toggle-${job.id}`;
    toggleBtn.className = 'toggle-btn' + (job.enabled ? ' enabled' : '');
    toggleBtn.textContent = job.enabled ? 'Enabled' : 'Disabled';
    toggleBtn.addEventListener('click', () => toggleScheduledJob(job.id, job.enabled ? 0 : 1));

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
    fireField.append(fireInput, attachUtcPreview(fireInput));

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
    for (const [val, label] of [['daily', 'Day(s)'], ['weekly', 'Week(s)'], ['monthly', 'Month(s)']]) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      if (unit === val) opt.selected = true;
      unitSel.appendChild(opt);
    }
    recurRow.append(countInput, unitSel);
    recurField.appendChild(recurRow);

    const domField = document.createElement('div');
    domField.className = 'sj-field';
    domField.innerHTML = '<label>Day of month</label>';
    const domSelect = domPicker(`sj-dom-${job.id}`, job.day_of_month);
    domField.appendChild(domSelect);
    domField.style.display = unit === 'monthly' ? '' : 'none';

    const offsetField = lastDayOffsetField(`sj-offset-${job.id}`, job.last_day_offset);
    offsetField.style.display = (unit === 'monthly' && domSelect.value === String(MONTHLY_LAST_DAY)) ? '' : 'none';

    domSelect.addEventListener('change', () => {
      offsetField.style.display = domSelect.value === String(MONTHLY_LAST_DAY) ? '' : 'none';
    });
    unitSel.addEventListener('change', () => {
      domField.style.display = unitSel.value === 'monthly' ? '' : 'none';
      offsetField.style.display = (unitSel.value === 'monthly' && domSelect.value === String(MONTHLY_LAST_DAY)) ? '' : 'none';
    });

    fields.append(fireField, recurField, domField, offsetField);

    // Optional "Posts to" channel field
    const chKey = JOB_CHANNEL_KEY[job.handler_path];
    if (chKey) {
      const chField = document.createElement('div');
      chField.className = 'sj-field';
      chField.innerHTML = '<label>Posts to</label>';
      const chSel = document.createElement('select');
      chSel.className = 'channel-select';
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
      chSel.className = 'channel-select';
      chSel.innerHTML = channelOptions(job.channel_id);
      chField.appendChild(chSel);
      fields.appendChild(chField);

      const dowField = document.createElement('div');
      dowField.className = 'sj-field';
      dowField.innerHTML = '<label>Days</label>';
      dowField.appendChild(dowPicker(`tj-dow-${job.id}`, job.days_of_week));
      dowField.style.display = unit === 'monthly' ? 'none' : '';
      unitSel.addEventListener('change', () => {
        dowField.style.display = unitSel.value === 'monthly' ? 'none' : '';
      });
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
    }

    // Action row: Enabled/Disabled, Delete Job (text jobs only), Save -- grouped together
    const actionsRow = document.createElement('div');
    actionsRow.style.cssText = 'display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:14px';
    actionsRow.appendChild(toggleBtn);

    if (job.type === 'text_job') {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'reset-btn';
      deleteBtn.textContent = 'Delete Job';
      deleteBtn.addEventListener('click', () => deleteTextJob(job.id));
      actionsRow.appendChild(deleteBtn);
    }

    const saveBtn = document.createElement('button');
    saveBtn.className = 'save-btn';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => job.type === 'text_job' ? saveTextJobFull(job.id) : saveScheduledJob(job.id));
    const flashSpan = document.createElement('span');
    flashSpan.className = 'saved-flash';
    flashSpan.id = `sj-flash-${job.id}`;
    flashSpan.textContent = 'Saved!';
    actionsRow.append(saveBtn, flashSpan);

    // UTC note
    const utcNote = document.createElement('div');
    utcNote.className = 'sj-utc-note muted-note';
    utcNote.style.marginTop = '10px';
    utcNote.textContent = `Current next fire (UTC): ${job.fire_at.slice(0,16).replace('T',' ')}`;

    const body = document.createElement('div');
    body.className = 'sj-body';
    body.append(fields, utcNote, actionsRow);

    card.append(tile, body);
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
  const fireInput = document.getElementById(`sj-fire-${id}`);
  const fireLocal = fireInput.value;
  const count     = document.getElementById(`sj-count-${id}`).value;
  const unit      = document.getElementById(`sj-unit-${id}`).value;
  const domEl     = document.getElementById(`sj-dom-${id}`);
  const dayOfMonth = unit === 'monthly' ? parseInt(domEl.value, 10) : null;
  const lastDayOffset = (unit === 'monthly' && dayOfMonth === MONTHLY_LAST_DAY) ? readLastDayOffset(`sj-offset-${id}`) : null;

  if (!fireLocal) { setFieldError(fireInput, 'Next fire time is required'); return false; }
  setFieldError(fireInput, '');
  const fireAt   = new Date(fireLocal).toISOString();
  const recurrence = `${unit}:${count}`;

  const res = await fetch(`/api/scheduled-jobs/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fire_at: fireAt, recurrence, day_of_month: dayOfMonth, last_day_offset: lastDayOffset }),
  });
  const data = await res.json();
  if (!data.ok) { setFieldError(fireInput, data.error); return false; }

  const card = document.getElementById(`sj-fire-${id}`).closest('.sj-card');
  const utcLine = card.querySelector('.sj-utc-note');
  if (utcLine) utcLine.textContent = `Current next fire (UTC): ${fireAt.slice(0,16).replace('T',' ')}`;
  const tileFire = card.querySelector('.sj-tile-fire');
  if (tileFire) tileFire.textContent = formatTileFireTime(fireAt);

  const flashEl = document.getElementById(`sj-flash-${id}`);
  if (flashEl) { flashEl.classList.add('show'); setTimeout(() => flashEl.classList.remove('show'), 2000); }
  return true;
}

export async function saveTextJobFull(id) {
  const channelInput = document.getElementById(`tj-channel-${id}`);
  const bodyInput    = document.getElementById(`tj-body-${id}`);
  clearFieldErrors([channelInput, bodyInput]);

  let hasError = false;
  if (!channelInput.value) { setFieldError(channelInput, 'Channel is required'); hasError = true; }
  if (!bodyInput.value.trim()) { setFieldError(bodyInput, 'Body is required'); hasError = true; }
  if (hasError) return;

  const scheduleOk = await saveScheduledJob(id); // schedule/recurrence fields, existing behavior
  if (!scheduleOk) return;

  const payload = {
    channel_id: channelInput.value,
    title:      document.getElementById(`tj-title-${id}`).value,
    body:       bodyInput.value,
    days_of_week: readDowPicker(`tj-dow-${id}`),
    mentions:   readMentionsPicker(`tj-mentions-${id}`),
  };

  const res = await fetch(`/api/text-jobs/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) { setFieldError(bodyInput, data.error); return; }

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
  chSel.className = 'channel-select';
  chSel.innerHTML = channelOptions('');
  chField.appendChild(chSel);

  const fireField = document.createElement('div');
  fireField.className = 'sj-field';
  fireField.innerHTML = '<label>First Fire (your local time)</label>';
  const fireInput = document.createElement('input');
  fireInput.type = 'datetime-local';
  fireInput.id = 'cj-fire';
  fireField.append(fireInput, attachUtcPreview(fireInput));

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
  for (const [val, label] of [['daily', 'Day(s)'], ['weekly', 'Week(s)'], ['monthly', 'Month(s)']]) {
    const opt = document.createElement('option'); opt.value = val; opt.textContent = label;
    unitSel.appendChild(opt);
  }
  recurRow.append(countInput, unitSel);
  recurField.appendChild(recurRow);

  const domSelect = domPicker('cj-dom', null);
  const domField = document.createElement('div');
  domField.className = 'sj-field';
  domField.innerHTML = '<label>Day of month</label>';
  domField.appendChild(domSelect);
  domField.style.display = 'none';

  const offsetField = lastDayOffsetField('cj-offset', null);
  offsetField.style.display = 'none';
  domSelect.addEventListener('change', () => {
    offsetField.style.display = (domField.style.display !== 'none' && domSelect.value === String(MONTHLY_LAST_DAY)) ? '' : 'none';
  });

  const dowField = document.createElement('div');
  dowField.className = 'sj-field';
  dowField.innerHTML = '<label>Days</label>';
  dowField.appendChild(dowPicker('cj-dow', null));

  unitSel.addEventListener('change', () => {
    domField.style.display = unitSel.value === 'monthly' ? '' : 'none';
    dowField.style.display = unitSel.value === 'monthly' ? 'none' : '';
    offsetField.style.display = (unitSel.value === 'monthly' && domSelect.value === String(MONTHLY_LAST_DAY)) ? '' : 'none';
  });

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
  fields.append(nameField, chField, fireField, recurField, domField, offsetField, dowField, titleField, bodyField, mentionsField, actionsField);
  form.appendChild(fields);
}

export async function submitNewTextJob() {
  const nameInput    = document.getElementById('cj-name');
  const channelInput = document.getElementById('cj-channel');
  const fireInput    = document.getElementById('cj-fire');
  const bodyInput    = document.getElementById('cj-body');
  clearFieldErrors([nameInput, channelInput, fireInput, bodyInput]);

  let hasError = false;
  if (!nameInput.value.trim()) { setFieldError(nameInput, 'Job name is required'); hasError = true; }
  if (!channelInput.value) { setFieldError(channelInput, 'Channel is required'); hasError = true; }
  if (!fireInput.value) { setFieldError(fireInput, 'First fire time is required'); hasError = true; }
  if (!bodyInput.value.trim()) { setFieldError(bodyInput, 'Body is required'); hasError = true; }
  if (hasError) return;

  const unit = document.getElementById('cj-unit').value;
  const cjDayOfMonth = unit === 'monthly' ? parseInt(document.getElementById('cj-dom').value, 10) : null;
  const payload = {
    name:       nameInput.value,
    channel_id: channelInput.value,
    title:      document.getElementById('cj-title').value,
    body:       bodyInput.value,
    fire_at:    new Date(fireInput.value).toISOString(),
    recurrence: `${unit}:${document.getElementById('cj-count').value}`,
    day_of_month: cjDayOfMonth,
    last_day_offset: (unit === 'monthly' && cjDayOfMonth === MONTHLY_LAST_DAY) ? readLastDayOffset('cj-offset') : null,
    days_of_week: readDowPicker('cj-dow'),
    mentions:   readMentionsPicker('cj-mentions'),
  };

  const res = await fetch('/api/text-jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) { setFieldError(bodyInput, data.error); return; }

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
    tbody.innerHTML = '<tr><td colspan="3" class="muted-note">No runs recorded yet.</td></tr>';
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
    : '<tr><td colspan="3" class="muted-note">No matches.</td></tr>';
}
