function formatB(damage) {
	if (damage == null || !Number.isFinite(damage)) return 'n/a';
	return `${(damage / 1e9).toFixed(1)}B`;
}

function plural(n, word) {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// What a flagged member's damage looks like next to the guild: share of crests spent (damage per
// crest earned against the guild mean hit), then whether that reaches the configured floor.
function damageLine(p, t) {
	if (!p.dmgN) return '   ↳ damage: no damage data in this period';
	const pct = p.dmgRatioAvg * 100;
	const shown = pct >= 100 ? '100%+' : `≈${Math.round(pct)}%`;
	const verdict = p.dmgAtOrAbove ? 'at or above' : 'below';
	return `   ↳ damage: ${shown} of crests spent (${plural(p.dmgN, 'wk')}) · ${verdict} ${t.hitFloor}% of the guild mean hit`;
}

// Crests earned with no damage recorded is called out on its own, ahead of the usual flags.
function zeroSection(zeroAttackers) {
	if (!zeroAttackers.length) return [];
	const lines = [`**🚩 Earned crests but never attacked (${zeroAttackers.length})**`];
	for (const z of zeroAttackers) {
		const weeks = z.zeroWeeks > 1 || z.damageWeeks > 1 ? ` · ${z.zeroWeeks} of ${z.damageWeeks} weeks` : '';
		lines.push(`**${z.name}** · ${z.crests.toLocaleString('en-US')} crests earned, no damage recorded${weeks}`);
	}
	lines.push('');
	return lines;
}

function damageFooter(t, hitMean, damageWeekCount) {
	if (!damageWeekCount) return 'damage: no damage data yet';
	return `damage: ≈ share of crests spent = damage ÷ (guild mean hit ${formatB(hitMean)} × crests ÷ 200), floor ${t.hitFloor}%, ${plural(damageWeekCount, 'wk')} of damage data · a 🚩 uses recorded damage, so a missed scan read can show a false zero: check in-game before acting`;
}

module.exports = { formatB, damageLine, zeroSection, damageFooter };
