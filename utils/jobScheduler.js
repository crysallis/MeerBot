const path = require('path');
const { EmbedBuilder } = require('discord.js');
const db = require('./db');
const { pickColor } = require('./colors');
const { logJobRun } = require('./jobLog');

// Compute next fire_at from current fire_at + recurrence interval (prevents clock drift)
function nextFire(job) {
    const [unit, n] = (job.recurrence || 'daily:1').split(':');
    const count = parseInt(n || '1', 10);
    const base = new Date(job.fire_at).getTime();
    const days = unit === 'weekly' ? count * 7 : count;
    return new Date(base + days * 24 * 60 * 60 * 1000).toISOString();
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
        WHERE datetime(sj.fire_at) <= datetime('now')
    `).all();

    for (const job of due) {
        try {
            if (job.type === 'script_job') {
                const handlerPath = path.join(__dirname, job.handler_path);
                const handlerModule = require(handlerPath);
                const handler = typeof handlerModule === 'function' ? handlerModule : handlerModule.default;
                await handler(client, job);

                db.prepare('UPDATE scheduled_jobs SET fire_at = ? WHERE id = ?')
                    .run(nextFire(job), job.id);
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
    tick(client);
    setInterval(() => tick(client), 30_000);
    console.log('[JobScheduler] Initialized · polling every 30s');
}

module.exports = { initJobScheduler };
