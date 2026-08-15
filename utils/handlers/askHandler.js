const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { COMMANDS } = require('../../slash-commands/help.js');
const { buildCapabilitySummary } = require('./askCapabilities');
const db = require('../db');

const anthropic = new Anthropic();

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const rateLimitLog = new Map(); // userId -> timestamp[]

const README = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8');
const ARCHITECTURE = fs.readFileSync(path.join(__dirname, '..', '..', 'ARCHITECTURE.md'), 'utf8');

const COMMANDS_TEXT = Object.entries(COMMANDS).map(([name, info]) => {
    const subs = info.subcommands.map(s => `  - ${s.name} — ${s.desc}`).join('\n');
    return `/${name} — ${info.description}\n${subs}`;
}).join('\n\n');

function isRateLimited(userId) {
    const now = Date.now();
    const timestamps = (rateLimitLog.get(userId) || []).filter(t => t > now - RATE_LIMIT_WINDOW_MS);
    if (timestamps.length >= RATE_LIMIT_MAX) {
        rateLimitLog.set(userId, timestamps);
        return true;
    }
    timestamps.push(now);
    rateLimitLog.set(userId, timestamps);
    return false;
}

async function handleAsk(message, client) {
    if (message.author.bot) return;
    if (message.guild !== null) return; // DM only

    if (isRateLimited(message.author.id)) {
        await message.reply("You've hit the limit of 10 questions per hour — try again later.").catch(() => {});
        return;
    }

    try {
        const guild = client.guilds.cache.get(process.env.GUILD_ID);
        const member = guild ? await guild.members.fetch(message.author.id).catch(() => null) : null;

        const capabilitySummary = member
            ? buildCapabilitySummary(member, COMMANDS)
            : 'Unable to determine this user\'s roles — answer generally, without personalized yes/no permission claims.';

        const system = [
            'You are MeerBot, a Discord bot for an AFK Journey guild called RiffRaff. A guild member has DMed you asking what you can do or how to do something.',
            'Answer ONLY using the command list, README, and capability summary below. Do not invent commands, features, or behavior not described in this context.',
            'Give the exact slash command syntax when relevant (e.g. `/glory cta time1: time2: duration:`).',
            'The capability summary below reflects THIS SPECIFIC user\'s real permissions — use it to give a direct yes/no answer when they ask if they can do something, including which channel if restricted.',
            'Keep answers short and conversational, a few sentences at most unless they ask for a full list.',
            'If asked something unrelated to the bot or the guild, politely say you can only help with MeerBot questions.',
            '--- COMMAND LIST ---',
            COMMANDS_TEXT,
            '--- README ---',
            README,
            '--- ARCHITECTURE (internal detail — only surface what\'s relevant to the question) ---',
            ARCHITECTURE,
            '--- THIS USER\'S CAPABILITIES ---',
            capabilitySummary,
        ].join('\n\n');

        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5',
            max_tokens: 1024,
            system,
            messages: [{ role: 'user', content: message.content }],
        });

        db.insertAskUsage({
            userId: message.author.id,
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
        });

        const text = response.content?.[0]?.text?.trim();
        await message.reply(text || "I couldn't come up with an answer to that — try `/help` for the full command list.");
    } catch (err) {
        console.error('[AskHandler] Failed to answer DM question:', err);
        await message.reply("Something went wrong answering that — try `/help` for the full command list.").catch(() => {});
    }
}

module.exports = { handleAsk, isRateLimited };
