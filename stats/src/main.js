import '../../shared/theme.css';
import { THEMES, themeMode } from '../../shared/themes.js';
import './style.css';
import { Chart }          from 'chart.js';
import { initOverview }   from './charts/overview.js';
import { initPowerChart } from './charts/power.js';
import { initActivenessChart } from './charts/activeness.js';
import { initDreamRealm } from './charts/dreamrealm.js';
import { initArena }      from './charts/arena.js';
import { initSupArena }   from './charts/supremeArena.js';
import { initLab }        from './charts/lab.js';
import { initGuildDuel }  from './charts/guildDuel.js';
import { getCSSVar, cssVarRgba, escHtml } from './utils.js';

function updateChartTheme() {
    const gridColor = getCSSVar('--color-base-content');
    const tickColor = getCSSVar('--color-base-content');
    Object.values(Chart.instances).forEach(chart => {
        for (const scale of Object.values(chart.options.scales || {})) {
            if (scale.grid)  scale.grid.color  = gridColor;
            if (scale.ticks) scale.ticks.color = tickColor;
            if (scale.title) scale.title.color = tickColor;
        }
        const legend = chart.options.plugins?.legend?.labels;
        if (legend) legend.color = tickColor;
        if (chart._recolor) chart._recolor();
        chart.update('none');
    });
}

function applyTheme(theme) {
    const mode = themeMode(theme);
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-mode', mode);
    localStorage.setItem('meerbot-theme', theme);
    updateChartTheme();
}

function initTheme() {
    const t = localStorage.getItem('meerbot-theme') || 'caramellatte';
    applyTheme(t);
    const sel = document.getElementById('theme-select');
    if (sel) {
        sel.innerHTML = THEMES.map(th => `<option value="${th.value}">${th.label}</option>`).join('');
        sel.value = t;
        sel.addEventListener('change', () => applyTheme(sel.value));
    }
}

let me = null;
const initialized = {};

async function boot() {
    const res = await fetch('/auth/me');
    if (!res.ok) {
        document.getElementById('login-overlay').classList.remove('hidden');
        return;
    }
    me = await res.json();

    const nameEl   = document.getElementById('user-name');
    const igEl     = document.getElementById('user-ingame');
    const avatarEl = document.getElementById('user-avatar');
    const logoutEl = document.getElementById('logout-btn');

    if (me.ingameName) {
        igEl.textContent = me.ingameName;
        if (me.user.name.toLowerCase() !== me.ingameName.toLowerCase()) {
            nameEl.textContent = `(${me.user.name})`;
        }
    } else {
        nameEl.textContent = me.user.name;
    }
    if (me.user.avatar) {
        avatarEl.src = me.user.avatar;
        avatarEl.classList.remove('hidden');
    }
    logoutEl.classList.remove('hidden');
    logoutEl.addEventListener('click', async () => {
        await fetch('/auth/logout', { method: 'POST' });
        location.reload();
    });

    document.querySelectorAll('.tab').forEach(btn => {
        btn.addEventListener('click', () => activateTab(btn.dataset.tab));
    });

    loadPresence();
    setInterval(loadPresence, 45000);

    activateTab('overview');
}

async function loadPresence() {
    let data;
    try { data = await fetch('/api/presence').then(r => r.ok ? r.json() : null); } catch { return; }
    if (!data || data.error) return;
    const el = document.getElementById('presence');
    if (!el) return;
    const others = (data.users || []).filter(u => u.discord_id !== data.me);
    if (!others.length) { el.innerHTML = ''; return; }
    const MAX   = 5;
    const shown = others.slice(0, MAX);
    let html = '<span class="presence-label">Viewing</span>';
    html += shown.map(u => {
        const inner = u.avatar
            ? `<img src="${u.avatar}" alt="">`
            : `<span class="presence-fallback">${escHtml((u.name || '?').slice(0, 1).toUpperCase())}</span>`;
        return `<span class="presence-av" title="${escHtml(u.name || '')}">${inner}</span>`;
    }).join('');
    if (others.length > MAX) {
        html += `<span class="presence-av presence-more" title="${others.length - MAX} more">+${others.length - MAX}</span>`;
    }
    el.innerHTML = html;
}

async function activateTab(name) {
    document.querySelectorAll('.tab').forEach(b =>
        b.classList.toggle('active', b.dataset.tab === name)
    );
    document.querySelectorAll('.tab-content').forEach(s =>
        s.classList.toggle('hidden', s.id !== `tab-${name}`)
    );

    if (initialized[name]) return;
    initialized[name] = true;

    try {
        if (name === 'overview')   await initOverview(me);
        if (name === 'power')      await initPowerChart(me);
        if (name === 'activeness') await initActivenessChart(me);
        if (name === 'dreamrealm') await initDreamRealm(me);
        if (name === 'arena')      await initArena(me);
        if (name === 'suparena')   await initSupArena(me);
        if (name === 'lab')        await initLab(me);
        if (name === 'guildduel')  await initGuildDuel(me);
        // preview tab is static HTML · no async init needed
        updateChartTheme();
    } catch (err) {
        console.error('[stats] init error for tab:', name, err);
    }
}

let resizeTimer;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        Object.values(Chart.instances).forEach(c => c.resize());
    }, 100);
});

initTheme();
boot();
