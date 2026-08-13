const path = require('path');
const { EmbedBuilder } = require('discord.js');
const db = require('./db');
const { pickColor } = require('./colors');
const { logJobRun } = require('./jobLog');
const botConfig = require('./botConfig');
const { renderTemplate, shouldFireToday, computeLateness, buildMentions, MAX_LATE_MINUTES } = require('./jobTemplate');
const { stripVariationSelectors } = require('./handlers/gloryctaReactionGuard');

const MONTHLY_LAST_DAY = -1;

// Months aren't a fixed number of days, so monthly recurrence can't fit the
// days*ms formula below -- day_of_month is the source of truth for the day
// and is never read back off fire_at, otherwise a clamped short month would
// permanently ratchet the date down next cycle (Jan 31 -> Feb 28 -> Mar 28 ->
// ...). Clamping happens before the date is constructed, not via Date.UTC
// overflow (Date.UTC(y, 1, 31) rolls into March rather than clamping to 28).
function computeMonthlyNext(fireAtIso, count, dayOfMonth, nowMs, lastDayOffset = 0) {
    const prev = new Date(fireAtIso);
    const hh = prev.getUTCHours();
    const mm = prev.getUTCMinutes();
    const ss = prev.getUTCSeconds();
    const year = prev.getUTCFullYear();
    let month = prev.getUTCMonth();

    function build(m) {
        const lastDayOfMonth = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
        let day;
        if (dayOfMonth === MONTHLY_LAST_DAY) {
            // Clamp so "N days before" can never cross into the previous month,
            // even if a larger offset was saved while looking at a longer month
            // (e.g. 28 saved in a 31-day month, later evaluated against a 28-day
            // February) -- recomputed fresh per month, same principle as the
            // dayOfMonth clamp below.
            const offset = Math.min(Math.max(lastDayOffset || 0, 0), lastDayOfMonth - 1);
            day = lastDayOfMonth - offset;
        } else {
            day = Math.min(dayOfMonth, lastDayOfMonth);
        }
        return Date.UTC(year, m, day, hh, mm, ss);
    }

    month += count;
    let next = build(month);
    while (next <= nowMs) {
        month += count;
        next = build(month);
    }
    return new Date(next).toISOString();
}

// Compute next fire_at from current fire_at + recurrence interval (prevents clock
// drift). Fast-forwards past any intervals missed while the bot was down, so a
// multi-day outage yields one catch-up fire instead of one per tick.
function nextFire(job) {
    const [unit, n] = (job.recurrence || 'daily:1').split(':');
    const count = parseInt(n || '1', 10);

    if (unit === 'monthly') {
        return computeMonthlyNext(job.fire_at, count, job.day_of_month, Date.now(), job.last_day_offset);
    }

    const days = unit === 'weekly' ? count * 7 : count;
    const intervalMs = days * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let next = new Date(job.fire_at).getTime() + intervalMs;
    while (next <= now) next += intervalMs;
    return new Date(next).toISOString();
}

// Bootstrap helpers -- used only once on first startup per job
function nextDailyAt(hh, mm) {
    const now = new Date();
    const candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm, 0, 0));
    if (candidate <= now) candidate.setUTCDate(candidate.getUTCDate() + 1);
    return candidate.toISOString();
}

function nextWeeklyAt(dayOfWeek, hh, mm) {
    const now = new Date();
    let daysUntil = (dayOfWeek - now.getUTCDay() + 7) % 7;
    if (daysUntil === 0) {
        const todayFire = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm));
        if (todayFire <= now) daysUntil = 7;
    }
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntil, hh, mm, 0, 0)).toISOString();
}

const SYSTEM_JOBS = [
    { handler_path: './handlers/scanReminder',    recurrence: 'daily:1',  initialFireAt: () => nextDailyAt(20, 0)       },
    { handler_path: './handlers/weeklySummary',   recurrence: 'weekly:1', initialFireAt: () => nextWeeklyAt(1, 9, 0)   },
    { handler_path: './handlers/anniversaryCheck', recurrence: 'daily:1', initialFireAt: () => nextDailyAt(18, 0)       },
    { handler_path: './handlers/afkExpiry',        recurrence: 'daily:1', initialFireAt: () => nextDailyAt(0, 0)        },
    { handler_path: './handlers/birthdayCheck',    recurrence: 'daily:1', initialFireAt: () => nextDailyAt(0, 0)        },
];

function bootstrap() {
    const now = new Date().toISOString();
    for (const jobDef of SYSTEM_JOBS) {
        const exists = db.prepare(
            'SELECT 1 FROM scheduled_jobs sj JOIN script_jobs scj ON scj.job_id = sj.id WHERE scj.handler_path = ?'
        ).get(jobDef.handler_path);

        if (!exists) {
            const fireAt = jobDef.initialFireAt();
            const result = db.prepare(
                'INSERT INTO scheduled_jobs (type, fire_at, recurrence, created_at) VALUES (?, ?, ?, ?)'
            ).run('script_job', fireAt, jobDef.recurrence, now);

            db.prepare(
                'INSERT INTO script_jobs (job_id, handler_path) VALUES (?, ?)'
            ).run(result.lastInsertRowid, jobDef.handler_path);

            console.log(`[JobScheduler] Bootstrapped: ${jobDef.handler_path} → ${fireAt}`);
        }
    }
}

async function handleRemindme(client, job) {
    try {
        const guild     = job.guild_id ? client.guilds.cache.get(job.guild_id) : null;
        const setOn     = job.created_at ? new Date(job.created_at).toUTCString().replace(' GMT', ' UTC') : null;

        const embed = new EmbedBuilder()
            .setTitle('⏰ Reminder')
            .setDescription(job.message)
            .setColor(pickColor())
            .setTimestamp();

        if (setOn)         embed.addFields({ name: 'Set on',   value: setOn,        inline: true });
        if (guild?.name)   embed.addFields({ name: 'Server',   value: guild.name,   inline: true });

        let delivered = false;
        try {
            const user = await client.users.fetch(job.user_id);
            await user.send({ embeds: [embed] });
            delivered = true;
        } catch {}

        if (!delivered) {
            const channel = await client.channels.fetch(job.channel_id).catch(() => null);
            if (channel) {
                await channel.send({ content: `<@${job.user_id}>`, embeds: [embed] });
            } else {
                console.error(`[Remindme] Could not deliver reminder to user ${job.user_id}`);
            }
        }
    } catch (err) {
        console.error('[Remindme] Error:', err);
    } finally {
        logJobRun(`remindme_${job.id}`);
    }
}

async function handleRecruitmentFollowup(client, job) {
    try {
        const embed = new EmbedBuilder()
            .setTitle('👤 Recruitment Follow-up')
            .setDescription(`2 days since first contact with **${job.recruit_name ?? 'Unknown'}**.\nUse \`/recruitment update\` to log progress.`)
            .setColor(pickColor())
            .setTimestamp();

        const channel = await client.channels.fetch(job.rf_channel_id).catch(() => null);
        if (channel) {
            await channel.send({ content: `<@${job.rf_user_id}>`, embeds: [embed] });
        }

        try {
            const user = await client.users.fetch(job.rf_user_id);
            await user.send({ embeds: [embed] });
        } catch {}
    } catch (err) {
        console.error('[RecruitmentFollowup] Error:', err);
    }
}

async function handleGloryctaTally(client, job) {
    const poll = db.prepare('SELECT * FROM glorycta_polls WHERE job_id = ?').get(job.id);
    if (!poll) {
        console.error(`[Glorycta] No poll row found for tally job ${job.id}`);
        return;
    }

    try {
        const channel = await client.channels.fetch(poll.channel_id);
        const message = await channel.messages.fetch(poll.message_id);

        const reactionA = findPollReaction(message.reactions.cache, poll.emoji_a);
        const reactionB = findPollReaction(message.reactions.cache, poll.emoji_b);
        const usersA = reactionA ? [...(await reactionA.users.fetch()).values()].filter(u => !u.bot) : [];
        const usersB = reactionB ? [...(await reactionB.users.fetch()).values()].filter(u => !u.bot) : [];

        const resolve = discordUser => {
            const member = db.prepare('SELECT ingame_name FROM members WHERE discord_id = ?').get(discordUser.id);
            return member ? `${discordUser.tag} (${member.ingame_name})` : discordUser.tag;
        };

        const linesA = usersA.length ? usersA.map(resolve).map(s => `· ${s}`).join('\n') : '*No votes*';
        const linesB = usersB.length ? usersB.map(resolve).map(s => `· ${s}`).join('\n') : '*No votes*';

        const embed = new EmbedBuilder()
            .setColor(pickColor())
            .setTitle('⚔️ Clash of Glory · Vote Results')
            .addFields(
                { name: `${poll.emoji_a} UTC ${poll.label_a} (${usersA.length})`, value: linesA.slice(0, 1024), inline: true },
                { name: `${poll.emoji_b} UTC ${poll.label_b} (${usersB.length})`, value: linesB.slice(0, 1024), inline: true },
            );

        await channel.send({ embeds: [embed] });
        await message.unpin().catch(err => console.error('[Glorycta] Failed to unpin poll message:', err.message));
    } catch (err) {
        console.error(`[Glorycta] Tally failed for poll ${poll.id} (message ${poll.message_id}):`, err.message);
    } finally {
        db.deleteGloryctaPoll(poll.id);
        logJobRun(`glorycta_${job.id}`);
    }
}

// message.reactions.cache is a Map keyed by Discord's canonical emoji.name
// (see discord.js ReactionManager#_add: `data.emoji.id ?? data.emoji.name`) --
// an exact-string lookup, not normalized. The EMOJI_POOL in utils/glorycta.js
// includes VS16-suffixed entries (e.g. '⚔️'), and gloryctaReactionGuard.js
// already found that a naive === against the DB-stored emoji can mismatch
// depending on how a given client echoed the variation selector. A cache.get()
// miss here doesn't throw -- it just returns undefined, which the handler below
// would silently render as "*No votes*", a quiet undercount rather than a crash.
// Reusing the same stripVariationSelectors() normalization the guard already
// verified (collision-free across all 40 EMOJI_POOL entries) avoids that.
function findPollReaction(reactionsCache, emoji) {
    const target = stripVariationSelectors(emoji);
    return reactionsCache.find(r => stripVariationSelectors(r.emoji.name) === target);
}

async function handleTextJob(client, job) {
    const now = new Date();

    // Day filter first: a non-firing day (e.g. a Mon-Fri job ticking on a Saturday)
    // is not a "run" at all, so it must not touch the lateness/log path below --
    // otherwise a too-late check on a day the job was never going to fire logs a
    // spurious entry in scheduler_log.
    if (!shouldFireToday(job.tj_days_of_week, now)) {
        return;
    }

    const { lateMinutes, isLate, tooLateToSend } = computeLateness(
        job.fire_at, now, Number(botConfig.get('LATE_WARNING_MINUTES', '30'))
    );

    if (tooLateToSend) {
        console.log(`[TextJob] Skipped ${job.tj_name} (${lateMinutes} min late, max ${MAX_LATE_MINUTES})`);
        logJobRun(job.tj_log_name, isLate);
        return;
    }

    try {
        const title = renderTemplate(job.tj_title || '', {});
        const body  = renderTemplate(job.tj_body || '', {});
        const mentions = JSON.parse(job.tj_mentions || '[]');
        const { content, allowedMentions } = buildMentions(mentions);

        const embed = new EmbedBuilder()
            .setDescription(body)
            .setColor(pickColor());
        if (title) embed.setTitle(title);

        const channel = await client.channels.fetch(job.tj_channel_id);
        await channel.send({ content, embeds: [embed], allowedMentions });
        logJobRun(job.tj_log_name, isLate);
        console.log(`[TextJob] Sent ${job.tj_name}${isLate ? ` (${lateMinutes} min late)` : ''}`);
    } catch (err) {
        console.error(`[TextJob] Error on ${job.tj_name}:`, err);
    }
}

async function tick(client) {
    const due = db.prepare(`
        SELECT sj.id, sj.type, sj.recurrence, sj.fire_at, sj.created_at, sj.day_of_month,
               rj.user_id, rj.channel_id, rj.guild_id, rj.message,
               scj.handler_path, scj.args,
               rf.user_id AS rf_user_id, rf.channel_id AS rf_channel_id, rf.recruitment_id,
               rec.name AS recruit_name,
               tj.name AS tj_name, tj.channel_id AS tj_channel_id, tj.title AS tj_title,
               tj.body AS tj_body, tj.mentions AS tj_mentions, tj.days_of_week AS tj_days_of_week,
               tj.log_name AS tj_log_name
        FROM scheduled_jobs sj
        LEFT JOIN remindme_jobs rj ON rj.job_id = sj.id
        LEFT JOIN script_jobs scj ON scj.job_id = sj.id
        LEFT JOIN recruitment_followups rf ON rf.job_id = sj.id
        LEFT JOIN recruitment rec ON rec.id = rf.recruitment_id
        LEFT JOIN text_jobs tj ON tj.job_id = sj.id
        WHERE datetime(sj.fire_at) <= datetime('now') AND sj.enabled = 1
    `).all();

    for (const job of due) {
        try {
            if (job.type === 'script_job') {
                // Advance fire_at BEFORE running the handler: a persistently
                // throwing handler waits for its next scheduled run instead of
                // retrying every 30s tick forever.
                db.prepare('UPDATE scheduled_jobs SET fire_at = ? WHERE id = ?')
                    .run(nextFire(job), job.id);

                const handlerPath = path.join(__dirname, job.handler_path);
                const handlerModule = require(handlerPath);
                const handler = typeof handlerModule === 'function' ? handlerModule : handlerModule.default;
                await handler(client, job);
            } else if (job.type === 'text_job') {
                db.prepare('UPDATE scheduled_jobs SET fire_at = ? WHERE id = ?')
                    .run(nextFire(job), job.id);
                await handleTextJob(client, job);
            } else if (job.type === 'remindme') {
                await handleRemindme(client, job);
                db.prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(job.id);
            } else if (job.type === 'recruitment_followup') {
                await handleRecruitmentFollowup(client, job);
                db.prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(job.id);
            } else if (job.type === 'glorycta_tally') {
                await handleGloryctaTally(client, job);
                db.prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(job.id);
            }
        } catch (err) {
            console.error(`[JobScheduler] Error on job ${job.id} (${job.type}${job.handler_path ? ' / ' + job.handler_path : ''}):`, err);
        }
    }
}

function initJobScheduler(client) {
    bootstrap();
    tick(client);
    setInterval(() => tick(client), 30_000);
    console.log('[JobScheduler] Initialized · polling every 30s');
}

module.exports = { initJobScheduler, computeMonthlyNext, MONTHLY_LAST_DAY, findPollReaction };
