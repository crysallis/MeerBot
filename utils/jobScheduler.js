const path = require('path');
const { EmbedBuilder } = require('discord.js');
const db = require('./db');
const { pickColor } = require('./colors');
const { logJobRun } = require('./jobLog');

// Compute next fire_at from current fire_at + recurrence interval (prevents clock
// drift). Fast-forwards past any intervals missed while the bot was down, so a
// multi-day outage yields one catch-up fire instead of one per tick.
function nextFire(job) {
    const [unit, n] = (job.recurrence || 'daily:1').split(':');
    const count = parseInt(n || '1', 10);
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
    { handler_path: './handlers/dailyReset',       recurrence: 'daily:1', initialFireAt: () => nextDailyAt(0, 0)        },
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

async function tick(client) {
    const due = db.prepare(`
        SELECT sj.id, sj.type, sj.recurrence, sj.fire_at, sj.created_at,
               rj.user_id, rj.channel_id, rj.guild_id, rj.message,
               scj.handler_path, scj.args,
               rf.user_id AS rf_user_id, rf.channel_id AS rf_channel_id, rf.recruitment_id,
               rec.name AS recruit_name
        FROM scheduled_jobs sj
        LEFT JOIN remindme_jobs rj ON rj.job_id = sj.id
        LEFT JOIN script_jobs scj ON scj.job_id = sj.id
        LEFT JOIN recruitment_followups rf ON rf.job_id = sj.id
        LEFT JOIN recruitment rec ON rec.id = rf.recruitment_id
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
            } else if (job.type === 'remindme') {
                await handleRemindme(client, job);
                db.prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(job.id);
            } else if (job.type === 'recruitment_followup') {
                await handleRecruitmentFollowup(client, job);
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

module.exports = { initJobScheduler };
