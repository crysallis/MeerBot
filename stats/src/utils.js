export function escHtml(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function getCSSVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function cssVarRgba(name, alpha) {
    const val = getCSSVar(name);
    if (!val) return `rgba(0,0,0,${alpha})`;
    if (val.startsWith('#')) {
        const hex = val.replace('#', '');
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        return `rgba(${r},${g},${b},${alpha})`;
    }
    // OKLCH and other modern formats: use color-mix for alpha (Canvas 2D + Chrome 111+ / FF 113+ / Safari 16.2+)
    return `color-mix(in srgb, ${val} ${Math.round(alpha * 100)}%, transparent)`;
}
