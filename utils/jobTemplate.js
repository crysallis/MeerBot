'use strict';

const MAX_LATE_MINUTES = 120;

function renderTemplate(text, vars) {
    if (!text) return text;
    return text.replace(/\{\{(\w+)\}\}/g, (match, key) => (key in vars ? String(vars[key]) : match));
}

function shouldFireToday(daysOfWeek, date) {
    if (!daysOfWeek) return true;
    const isoDay = date.getUTCDay() === 0 ? 7 : date.getUTCDay(); // JS: Sun=0 -> ISO: Sun=7, Mon=1..Sat=6
    const allowed = daysOfWeek.split(',').map(s => parseInt(s.trim(), 10));
    return allowed.includes(isoDay);
}

function computeLateness(fireAt, now, lateWarningMinutes) {
    const lateMs = now.getTime() - new Date(fireAt).getTime();
    const lateMinutes = Math.round(lateMs / 60_000);
    return {
        lateMinutes,
        isLate: lateMinutes > lateWarningMinutes,
        tooLateToSend: lateMinutes > MAX_LATE_MINUTES,
    };
}

// The only function permitted to turn the structured `mentions` field into real
// Discord mention syntax. Embeds (title/body) never notify regardless of
// allowedMentions -- content is the one field that can, so this mapping is the
// actual ping guard, not decoration.
function buildMentions(mentions) {
    const parse = [];
    const roles = [];
    let content = '';

    for (const m of mentions) {
        if (m.type === 'everyone' || m.type === 'here') {
            content += `@${m.type} `;
            if (!parse.includes('everyone')) parse.push('everyone');
        } else if (m.type === 'role') {
            content += `<@&${m.id}> `;
            roles.push(m.id);
        }
    }

    const allowedMentions = { parse };
    if (roles.length) allowedMentions.roles = roles;

    return { content: content.trim(), allowedMentions };
}

module.exports = { renderTemplate, shouldFireToday, computeLateness, buildMentions, MAX_LATE_MINUTES };
