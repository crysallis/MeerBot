const COLORS = [
	0x9a9b99, // muted grey   (comments)
	0x9aa83a, // yellow-green (strings)
	0x6089b4, // muted blue   (numbers/properties)
	0xce6700, // deep orange  (functions)
	0x9872a2, // muted purple (constants)
	0xd08442, // warm amber   (interpolation/tags)
	0x7785cc,
	0x002bff,
	0x2a4d7e,
	0xadf5ff,
	0x001c81,
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
