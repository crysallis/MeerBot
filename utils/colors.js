const COLORS = [
    0x9A9B99, // muted grey   (comments)
    0x9AA83A, // yellow-green (strings)
    0x6089B4, // muted blue   (numbers/properties)
    0xCE6700, // deep orange  (functions)
    0x9872A2, // muted purple (constants)
    0xD08442, // warm amber   (interpolation/tags)
];

function pickColor() {
    return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function toRgba(hex, alpha = 1) {
    const r = (hex >> 16) & 0xff;
    const g = (hex >> 8) & 0xff;
    const b = hex & 0xff;
    return `rgba(${r},${g},${b},${alpha})`;
}

module.exports = { pickColor, toRgba };
