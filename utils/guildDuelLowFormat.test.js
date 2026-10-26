const { test } = require('node:test');
const assert = require('node:assert');
const { formatB, damageLine, zeroSection, damageFooter } = require('./guildDuelLowFormat');

const T = { hitFloor: 50 };

test('formatB writes damage in billions with one decimal', () => {
	assert.strictEqual(formatB(13.7e9), '13.7B');
	assert.strictEqual(formatB(5.18e9), '5.2B');
	assert.strictEqual(formatB(null), 'n/a');
});

test('a member below the floor reads as a share of crests spent and below the floor', () => {
	const line = damageLine({ dmgN: 1, dmgRatioAvg: 0.04, dmgAtOrAbove: false }, T);
	assert.strictEqual(line, '   ↳ damage: ≈4% of crests spent (1 wk) · below 50% of the guild mean hit');
});

test('a member at or above the floor says so', () => {
	const line = damageLine({ dmgN: 2, dmgRatioAvg: 0.8, dmgAtOrAbove: true }, T);
	assert.strictEqual(line, '   ↳ damage: ≈80% of crests spent (2 wks) · at or above 50% of the guild mean hit');
});

test('a share of 100 percent or more is shown as 100%+ without the approximation sign', () => {
	const line = damageLine({ dmgN: 1, dmgRatioAvg: 1.37, dmgAtOrAbove: true }, T);
	assert.strictEqual(line, '   ↳ damage: 100%+ of crests spent (1 wk) · at or above 50% of the guild mean hit');
});

test('no damage data in the period is stated plainly', () => {
	const line = damageLine({ dmgN: 0, dmgRatioAvg: null, dmgAtOrAbove: null }, T);
	assert.strictEqual(line, '   ↳ damage: no damage data in this period');
});

test('the floor shown follows the setting', () => {
	assert.ok(damageLine({ dmgN: 1, dmgRatioAvg: 0.1, dmgAtOrAbove: false }, { hitFloor: 65 }).includes('below 65% of the guild mean hit'));
});

test('the red-flag section names each member with the crests they earned and no damage', () => {
	const lines = zeroSection([
		{ name: 'Alpha', zeroWeeks: 1, damageWeeks: 1, crests: 3000 },
		{ name: 'Bravo', zeroWeeks: 2, damageWeeks: 3, crests: 1720 },
	]);
	assert.deepStrictEqual(lines, [
		'**🚩 Earned crests but never attacked (2)**',
		'**Alpha** · 3,000 crests earned, no damage recorded',
		'**Bravo** · 1,720 crests earned, no damage recorded · 2 of 3 weeks',
		'',
	]);
});

test('with nobody to call out the section is empty', () => {
	assert.deepStrictEqual(zeroSection([]), []);
});

test('the footer explains the estimate and warns that a scan miss can look like a zero', () => {
	const text = damageFooter({ hitFloor: 50 }, 13.7e9, 1);
	assert.ok(text.includes('guild mean hit 13.7B'));
	assert.ok(text.includes('50%'));
	assert.ok(text.includes('1 wk of damage data'));
	assert.ok(text.toLowerCase().includes('check in-game'));
});

test('the footer says so when no week has damage data', () => {
	assert.ok(damageFooter({ hitFloor: 50 }, null, 0).includes('no damage data yet'));
});
