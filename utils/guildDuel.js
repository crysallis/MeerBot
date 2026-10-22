function guildDuelPeriodKey(now = new Date()) {
	const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	const daysSinceMonday = (now.getUTCDay() + 6) % 7;
	const DAY = 24 * 60 * 60 * 1000;
	return new Date(today - (daysSinceMonday + 7) * DAY).toISOString().slice(0, 10);
}

module.exports = { guildDuelPeriodKey };
