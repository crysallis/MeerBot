const { EmbedBuilder } = require('discord.js');
const { pickColor } = require('./colors');
const { parseUtcDate, isoDate, addDays, weekStartOf, afkMemberIdsForWeek, isMemberAfkForWeek } = require('./duelWeeks');

const HIT_CRESTS = 200;
const DEFAULT_HIT_FLOOR = 0.5;
const MIN_ROWS = 10;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dayLabel(dateStr) {
    const d = parseUtcDate(dateStr);
    return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function formatWeekRange(weekStart) {
    const end = addDays(weekStart, 6);
    return `${dayLabel(weekStart)} to ${dayLabel(end)}, ${end.slice(0, 4)} (UTC)`;
}

function formatBossWindow(weekStart) {
    return `${dayLabel(addDays(weekStart, 5))} to ${dayLabel(addDays(weekStart, 6))}`;
}

function shortRange(weekStart) {
    const strip = s => dayLabel(s).split(' ').slice(1).join(' ');
    const end = addDays(weekStart, 6);
    return `${strip(weekStart)} to ${strip(end)}, ${end.slice(0, 4)}`;
}

// Hits are crests / 200. The yardstick is the guild's mean damage per hit among members who attacked
// (total damage / total hits); "unspent" hits are estimated at that mean. hitFloor is the shared
// Guild Duel setting (a share of the mean hit, 0.5 = half): a dealer under it "used only a small part
// of their crests". No member ids or names come out.
function evaluateRecap(rows, afkIds, hitFloor = DEFAULT_HIT_FLOOR) {
    const active = rows.filter(r => !afkIds.has(r.member_id));
    const dealers = active.filter(r => r.crests > 0 && r.damage > 0);
    if (dealers.length === 0) return null;

    const totalDamage = dealers.reduce((s, r) => s + r.damage, 0);
    const totalHits = dealers.reduce((s, r) => s + r.crests / HIT_CRESTS, 0);
    const meanPerHit = totalDamage / totalHits;

    const zeroRows = active.filter(r => r.crests >= HIT_CRESTS && !(r.damage > 0));
    const zeroHits = zeroRows.reduce((s, r) => s + r.crests / HIT_CRESTS, 0);

    let lowCount = 0;
    let lowHits = 0;
    for (const r of dealers) {
        const hits = r.crests / HIT_CRESTS;
        if (r.damage / hits < hitFloor * meanPerHit) {
            lowCount++;
            lowHits += hits - r.damage / meanPerHit;
        }
    }

    const combinedHits = zeroHits + lowHits;
    const combinedDamage = combinedHits * meanPerHit;
    return {
        dealers: dealers.length,
        totalDamage,
        totalHits,
        avgPerHit: meanPerHit,
        meanPerHit,
        zero: { count: zeroRows.length, hits: zeroHits, damage: zeroHits * meanPerHit },
        low: { count: lowCount, hits: lowHits, damage: lowHits * meanPerHit },
        combined: { hits: combinedHits, damage: combinedDamage, pct: (combinedDamage / totalDamage) * 100 },
        afkExcluded: rows.length - active.length,
    };
}

function recapWeeksWithData(handle) {
    return handle.prepare(
        `SELECT period_start FROM guild_duel_rankings GROUP BY period_start
         HAVING COUNT(damage) >= ? AND COUNT(crests) >= ? ORDER BY period_start DESC`
    ).all(MIN_ROWS, MIN_ROWS).map(r => r.period_start);
}

function classifyWeek(handle, weekStart, now = new Date()) {
    if (!weekStart) return { kind: 'invalid' };
    const currentWeek = weekStartOf(isoDate(now));
    if (weekStart > currentWeek) return { kind: 'future', weekStart };
    if (weekStart === currentWeek) return { kind: 'current', weekStart };

    const counts = handle.prepare(
        'SELECT COUNT(damage) AS d, COUNT(crests) AS c FROM guild_duel_rankings WHERE period_start = ?'
    ).get(weekStart);
    if (counts.d >= MIN_ROWS) {
        return counts.c >= MIN_ROWS ? { kind: 'ok', weekStart } : { kind: 'crests-pending', weekStart };
    }
    const firstRow = handle.prepare(
        `SELECT MIN(period_start) AS p FROM
           (SELECT period_start FROM guild_duel_rankings GROUP BY period_start HAVING COUNT(damage) >= ?)`
    ).get(MIN_ROWS);
    const firstWeek = firstRow ? firstRow.p : null;
    return !firstWeek || weekStart < firstWeek
        ? { kind: 'before-data', weekStart, firstWeek }
        : { kind: 'no-data', weekStart };
}

function listRecapWeeks(handle, now = new Date()) {
    const currentWeek = weekStartOf(isoDate(now));
    return recapWeeksWithData(handle)
        .filter(w => w < currentWeek)
        .map(w => ({ weekStart: w, label: shortRange(w) }));
}

function fmtB(damage) {
    return `${Math.round(damage / 1e9).toLocaleString('en-US')}B`;
}

function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function groupLine(group) {
    if (group.count === 0) return 'None';
    return `${plural(group.count, 'member')}\nabout ${Math.round(group.hits)} unspent hits · roughly ${fmtB(group.damage)}`;
}

function buildRecapEmbed(result, weekStart) {
    const hits = Math.round(result.totalHits).toLocaleString('en-US');
    return new EmbedBuilder()
        .setTitle('Guild Duel recap')
        .setDescription(`${formatWeekRange(weekStart)}\nBoss window: ${formatBossWindow(weekStart)}`)
        .addFields(
            {
                name: 'Guild total',
                value: `**${fmtB(result.totalDamage)}** damage over about **${hits} hits**\nAverage **${(result.avgPerHit / 1e9).toFixed(1)}B per hit**`,
            },
            { name: 'Earned crests, never attacked', value: groupLine(result.zero) },
            { name: 'Used only a small part of their crests', value: groupLine(result.low) },
            {
                name: 'Left on the table',
                value: `about **${Math.round(result.combined.hits)} unspent hits** · roughly **${fmtB(result.combined.damage)}**\n${result.combined.pct.toFixed(1)}% on top of what we dealt`,
            },
        )
        .setFooter({ text: `AFK members excluded · estimates use the guild mean hit (${(result.meanPerHit / 1e9).toFixed(2)}B) · one hit = ${HIT_CRESTS} crests` })
        .setColor(pickColor());
}

function recapMessage(c) {
    switch (c.kind) {
        case 'invalid':
            return 'Use the format YYYY-MM-DD, like 2026-10-22 (any day inside the duel week works), or leave it empty for the latest finished duel.';
        case 'before-data':
            return `We can't do a recap for that duel because we weren't capturing damage data yet.${c.firstWeek ? ` The first duel we have is ${shortRange(c.firstWeek)}.` : ''}`;
        case 'current':
            return `That duel is still in progress${c.weekStart ? ` (it ends ${dayLabel(addDays(c.weekStart, 6))} UTC)` : ''}. Please check again next week after the current duel is over.`;
        case 'future':
            return "That duel hasn't happened yet.";
        case 'crests-pending':
            return "The crest totals for that duel haven't been scanned yet. Check again after Monday's Battle Report scan.";
        case 'no-data':
            return "We don't have damage data for that duel.";
        case 'none':
            return 'There is no finished duel with data to recap yet.';
        default:
            return "We can't do a recap for that duel.";
    }
}

module.exports = {
    weekStartOf, formatWeekRange, formatBossWindow, shortRange, afkMemberIdsForWeek, isMemberAfkForWeek, evaluateRecap,
    classifyWeek, listRecapWeeks, buildRecapEmbed, recapMessage,
};
