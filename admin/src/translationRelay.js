import { escHtml } from './utils.js';
import { state } from './state.js';

let relayData = [];

export async function loadTranslationRelay() {
    try {
        relayData = await fetch('/api/translation-relay').then(r => r.json());
    } catch {
        relayData = [];
    }
    renderTranslationRelay();
    await loadBatchTimeout();
}

async function loadBatchTimeout() {
    try {
        const { seconds } = await fetch('/api/translation-relay/batch-timeout').then(r => r.json());
        const input = document.getElementById('relayBatchTimeout');
        if (input) input.value = seconds;
    } catch {
        // If load fails, input stays blank and save will be the next action
    }
}

function channelLabel(channelId) {
    const ch = state.channelList.find(c => c.id === channelId);
    return ch ? `${ch.name.replace(/[^\w\s#-]/gu, '').trim()} (${channelId})` : channelId;
}

export function renderTranslationRelay() {
    const tbody = document.getElementById('translationRelayBody');
    if (!tbody) return;
    if (!relayData.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="color:var(--color-neutral-content)">No relay channels configured.</td></tr>';
    } else {
        tbody.innerHTML = '';
        for (const r of relayData) {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="color:var(--color-base-content)">${escHtml(channelLabel(r.channel_id))}</td>
                <td>${escHtml(r.language)}</td>
                <td>${escHtml(r.flag_emoji)}</td>
                <td class="action-col"></td>`;
            const delBtn = document.createElement('button');
            delBtn.className = 'reset-btn';
            delBtn.textContent = 'Remove';
            delBtn.addEventListener('click', () => removeRelayChannel(r.id, channelLabel(r.channel_id)));
            tr.lastElementChild.append(delBtn);
            tbody.appendChild(tr);
        }
    }

    const select = document.getElementById('newRelayChannel');
    if (select) {
        select.innerHTML = '<option value="">— choose a channel —</option>' +
            state.channelList.map(ch => `<option value="${ch.id}">${escHtml(ch.name)} (${ch.id})</option>`).join('');
    }
}

async function addRelayChannel() {
    const channelId = document.getElementById('newRelayChannel').value;
    const language = document.getElementById('newRelayLanguage').value.trim();
    const flagEmoji = document.getElementById('newRelayFlag').value.trim();
    if (!channelId || !language || !flagEmoji) {
        alert('Channel, language, and flag emoji are all required.');
        return;
    }
    const res = await fetch('/api/translation-relay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, language, flagEmoji }),
    });
    const body = await res.json();
    if (!res.ok) {
        alert(body.error || 'Failed to add channel');
        return;
    }
    document.getElementById('newRelayLanguage').value = '';
    document.getElementById('newRelayFlag').value = '';
    await loadTranslationRelay();
}

async function removeRelayChannel(id, label) {
    if (!confirm(`Remove ${label} from the translation relay?`)) return;
    const res = await fetch(`/api/translation-relay/${id}`, { method: 'DELETE' });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || 'Failed to remove channel');
        return;
    }
    await loadTranslationRelay();
}

async function saveBatchTimeout() {
    const input = document.getElementById('relayBatchTimeout');
    const status = document.getElementById('relayBatchTimeoutStatus');
    const seconds = parseInt(input.value, 10);
    const res = await fetch('/api/translation-relay/batch-timeout', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds }),
    });
    const body = await res.json();
    if (!res.ok) {
        status.textContent = body.error || 'Failed to save';
        return;
    }
    status.textContent = 'Saved.';
    setTimeout(() => { status.textContent = ''; }, 2000);
}

export function initTranslationRelay() {
    document.getElementById('addRelayChannelBtn')?.addEventListener('click', addRelayChannel);
    document.getElementById('saveRelayBatchTimeoutBtn')?.addEventListener('click', saveBatchTimeout);
}
