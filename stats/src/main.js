import '../../shared/theme.css';
import './style.css';
import { Chart }          from 'chart.js';
import { initOverview }   from './charts/overview.js';
import { initPowerChart } from './charts/power.js';
import { initDreamRealm } from './charts/dreamrealm.js';
import { initArena }      from './charts/arena.js';
import { initLab }        from './charts/lab.js';

function getCSSVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function hexToRgba(hex, alpha) {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

function updateChartTheme() {
    const gridColor = hexToRgba(getCSSVar('--border'), 0.6);
    const tickColor = getCSSVar('--accent');
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

function applyTheme(theme, mode) {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-mode', mode);
    const btn = document.getElementById('mode-toggle');
    if (btn) btn.textContent = mode === 'dark' ? '☀️' : '🌙';
    localStorage.setItem('meerbot-theme', theme);
    localStorage.setItem('meerbot-mode', mode);
    updateChartTheme();
}

function initTheme() {
    const t = localStorage.getItem('meerbot-theme') || 'jewel';
    const m = localStorage.getItem('meerbot-mode')  || 'dark';
    applyTheme(t, m);
    const sel = document.getElementById('theme-select');
    if (sel) {
        sel.value = t;
        sel.addEventListener('change', () =>
            applyTheme(sel.value, document.documentElement.getAttribute('data-mode') || 'dark')
        );
    }
    const btn = document.getElementById('mode-toggle');
    if (btn) {
        btn.addEventListener('click', () => {
            const cur = document.documentElement.getAttribute('data-mode') || 'dark';
            applyTheme(document.documentElement.getAttribute('data-theme') || 'jewel', cur === 'dark' ? 'light' : 'dark');
        });
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

    activateTab('overview');
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
        if (name === 'dreamrealm') await initDreamRealm(me);
        if (name === 'arena')      await initArena(me);
        if (name === 'lab')        await initLab(me);
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
