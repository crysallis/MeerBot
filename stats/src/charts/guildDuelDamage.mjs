// Pure helpers for the Guild Duel damage chart and the table's damage column. Kept free of DOM and
// Chart.js so they can be tested with node:test.

export function formatDamage(damage) {
    if (damage >= 1e9) {
        const b = damage / 1e9;
        if (b >= 100) return `${Math.round(b).toLocaleString('en-US')}B`;
        const shown = Math.round(b * 10) / 10;
        return `${Number.isInteger(shown) ? shown : shown.toFixed(1)}B`;
    }
    return `${Math.round(damage / 1e6)}M`;
}

// report = /api/guild-duel's `damage` object: { periods, rows: [{member_id, period_start, damage}], afk: {period: [ids]} }
export function indexDamage(report) {
    const r = report || { periods: [], rows: [], afk: {} };
    const by = new Map(r.rows.map(x => [`${x.member_id}|${x.period_start}`, x.damage]));
    const afk = new Map(Object.entries(r.afk || {}).map(([p, ids]) => [p, new Set(ids)]));
    return { periods: r.periods, hasData: new Set(r.periods), by, afk };
}

function cell(total, afk, hasData) {
    if (total > 0) return { kind: 'amount', text: afk ? `${formatDamage(total)} · AFK` : formatDamage(total), total };
    if (afk) return { kind: 'afk', text: 'AFK', total: 0 };
    if (hasData) return { kind: 'none', text: 'No damage', total: 0 };
    return { kind: 'blank', text: '·', total: 0 };
}

// member = { id, crestsByPeriod }. "No damage" is only said for a week that has damage data, so weeks from
// before damage capture never read as an accusation, and an AFK week reads AFK instead.
export function damageFor(idx, member, period) {
    const isAfk = p => idx.afk.get(p)?.has(member.id) || false;
    if (period !== 'all') {
        return cell(idx.by.get(`${member.id}|${period}`) || 0, isAfk(period), idx.hasData.has(period));
    }
    const total = idx.periods.reduce((sum, p) => sum + (idx.by.get(`${member.id}|${p}`) || 0), 0);
    const relevant = idx.periods.filter(p => member.crestsByPeriod[p] !== undefined);
    if (total > 0) return cell(total, false, true);
    if (relevant.some(p => !isAfk(p))) return cell(0, false, true);
    if (relevant.length) return cell(0, true, true);
    return cell(0, false, false);
}

export function damageSeries(idx, members, period) {
    const hasData = period === 'all' ? idx.periods.length > 0 : idx.hasData.has(period);
    if (!hasData) return { hasData: false, rows: [] };
    const rows = members
        .map(m => ({ id: m.id, name: m.name, damage: damageFor(idx, m, period).total }))
        .filter(r => r.damage > 0)
        .sort((a, b) => b.damage - a.damage);
    return { hasData: true, rows };
}
