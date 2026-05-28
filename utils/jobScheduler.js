const path = require('path');
const { EmbedBuilder } = require('discord.js');
const db = require('./db');
const botConfig = require('./botConfig');
const { pickColor } = require('./colors');
const { logJobRun } = require('./jobLog');

function nextDaily(timeStr = '00:00') {
    const [h, m] = timeStr.split(':').map(Number);
    const now = new Date();
    const candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m, 0, 0));
    if (candidate <= now) candidate.setUTCDate(candidate.getUTCDate() + 1);
    return candidate.toISOString();
}

function nextWeekly(dayOfWeek, timeStr = '09:00') {
    const [h, m] = timeStr.split(':').map(Number);
    const now = new Date();
    let daysUntil = (dayOfWeek - now.getUTCDay() + 7) % 7;
    if (daysUntil === 0) {
        const todayFire = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m));
        if (todayFire <= now) daysUntil = 7;
    }
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntil, h, m, 0, 0));
    return next.toISOString();
}

const SYSTEM_JOBS = [
    {
        handler_path: './handlers/scanReminder',
        recurrence: 'daily',
        nextFireAt: () => nextDaily(botConfig.get('SCAN_REMINDER_TIME', '20:00')),
    },
    {
        handler_path: './handlers/weeklySummary',
        recurrence: 'weekly:1',
        nextFireAt: () => nextWeekly(1, botConfig.get('WEEKLY_SUMMARY_TIME', '09:00')),
    },
    {
        handler_path: './handlers/anniversaryCheck',
        recurrence: 'daily',
        nextFireAt: () => nextDaily(botConfig.get('ANNIVERSARY_TIME', '18:00')),
    },
    {
        handler_path: './handlers/afkExpiry',
        recurrence: 'daily',
        nextFireAt: () => nextDaily('00:00'),
    },
    {
        handler_path: './handlers/birthdayCheck',
        recurrence: 'daily',
        nextFireAt: () => nextDaily('00:00'),
    },
    {
        handler_path: './handlers/dailyReset',
        recurrence: 'daily',
        nextFireAt: () => nextDaily('00:00'),
    },
];

function bootstrap() {
    const now = new Date().toISOString();
    for (const jobDef of SYSTEM_JOBS) {
        const exists = db.prepare(
            'SELECT 1 FROM scheduled_jobs sj JOIN script_jobs scj ON scj.job_id = sj.id WHERE scj.handler_path = ?'
        ).get(jobDef.handler_path);

        if (!exists) {
            const fireAt = jobDef.nextFireAt();
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
        const embed = new EmbedBuilder()
            .setTitle('⏰ Reminder')
            .setDescription(job.message)
            .setColor(pickColor())
            .setTimestamp();

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

async function tick(client) {
    const due = db.prepare(`
        SELECT sj.id, sj.type, sj.recurrence, sj.fire_at,
               rj.user_id, rj.channel_id, rj.guild_id, rj.message,
               scj.handler_path, scj.args
        FROM scheduled_jobs sj
        LEFT JOIN remindme_jobs rj ON rj.job_id = sj.id
        LEFT JOIN script_jobs scj ON scj.job_id = sj.id
        WHERE sj.fire_at <= datetime('now')
    `).all();

    for (const job of due) {
        try {
            if (job.type === 'script_job') {
                const handlerPath = path.join(__dirname, job.handler_path);
                const handlerModule = require(handlerPath);
                const handler = typeof handlerModule === 'function' ? handlerModule : handlerModule.default;
                await handler(client, job);

                const jobDef = SYSTEM_JOBS.find(j => j.handler_path === job.handler_path);
                if (jobDef) {
                    db.prepare('UPDATE scheduled_jobs SET fire_at = ?, last_fired_at = ? WHERE id = ?')
                        .run(jobDef.nextFireAt(), new Date().toISOString(), job.id);
                }
            } else if (job.type === 'remindme') {
                await handleRemindme(client, job);
                db.prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(job.id);
            }
        } catch (err) {
            console.error(`[JobScheduler] Error on job ${job.id} (${job.type}${job.handler_path ? ' / ' + job.handler_path : ''}):`, err);
        }
    }
}

function initJobScheduler(client) {
    bootstrap();
    tick(client); // immediate check on startup (catches any jobs due while bot was offline)
    setInterval(() => tick(client), 30_000);
    console.log('[JobScheduler] Initialized · polling every 30s');
}

module.exports = { initJobScheduler };
