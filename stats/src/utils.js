export function escHtml(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function getCSSVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function cssVarRgba(name, alpha) {
    const val = getCSSVar(name);
    if (!val) return `rgba(0,0,0,${alpha})`;
    // Resolve any CSS color (hex, oklch, etc.) to rgb() via a hidden element,
    // then apply alpha -- Canvas 2D cannot use color-mix() as a fill style.
    const el = Object.assign(document.createElement('div'), {
        style: `position:absolute;width:0;height:0;overflow:hidden;color:${val}`
    });
    document.body.appendChild(el);
    const rgb = getComputedStyle(el).color; // always "rgb(r, g, b)"
    document.body.removeChild(el);
    const m = rgb.match(/\d+/g);
    if (!m) return `rgba(0,0,0,${alpha})`;
    return `rgba(${m[0]},${m[1]},${m[2]},${alpha})`;
}
