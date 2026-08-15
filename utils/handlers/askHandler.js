const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { COMMANDS } = require('../../slash-commands/help.js');
const { buildCapabilitySummary } = require('./askCapabilities');
const db = require('../db');

const anthropic = new Anthropic();

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const HISTORY_TURNS = 3;
// userId -> { timestamp, question, answer }[] -- doubles as the rate-limit log
// and the conversation history, both aged out on the same rolling hour window.
const rateLimitLog = new Map();

const README = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8');
const ARCHITECTURE = fs.readFileSync(path.join(__dirname, '..', '..', 'ARCHITECTURE.md'), 'utf8');

const COMMANDS_TEXT = Object.entries(COMMANDS).map(([name, info]) => {
    const subs = info.subcommands.map(s => `  - ${s.name} — ${s.desc}`).join('\n');
    return `/${name} — ${info.description}\n${subs}`;
}).join('\n\n');

function currentEntries(userId) {
    const now = Date.now();
    return (rateLimitLog.get(userId) || []).filter(e => e.timestamp > now - RATE_LIMIT_WINDOW_MS);
}

// Counts as an attempt regardless of what happens after -- a question that
// gets through the limiter but then fails in the Claude call still consumes
// a slot, same as the original rate-limit-only behavior. Each call pushes one
// entry (question/answer filled in later by recordExchange once answered).
function isRateLimited(userId) {
    const entries = currentEntries(userId);
    if (entries.length >= RATE_LIMIT_MAX) {
        rateLimitLog.set(userId, entries);
        return true;
    }
    entries.push({ timestamp: Date.now(), question: null, answer: null });
    rateLimitLog.set(userId, entries);
    return false;
}

// Last HISTORY_TURNS ANSWERED exchanges still inside the rate-limit window,
// oldest first -- same aging as isRateLimited, so history and quota expire
// together. Excludes the in-flight entry isRateLimited just pushed for the
// current question (question is still null at that point).
function getRecentHistory(userId) {
    return currentEntries(userId).filter(e => e.question !== null).slice(-HISTORY_TURNS);
}

// Fills in the question/answer on the most recent (in-flight) entry that
// isRateLimited pushed for this question, rather than adding a new slot.
function recordExchange(userId, question, answer) {
    const entries = currentEntries(userId);
    const last = entries[entries.length - 1];
    if (last && last.question === null) {
        last.question = question;
        last.answer = answer;
    } else {
        entries.push({ timestamp: Date.now(), question, answer });
    }
    rateLimitLog.set(userId, entries);
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
            'Reply like a person texting back a quick answer in Discord DMs, not like a doc page. Write in plain sentences and short paragraphs.',
            'Do not use markdown headers, bold section titles, or emoji. Do not structure the answer into labeled sections like "Usage", "How it works", or "Voting mechanics" — just explain it conversationally.',
            'Only use a bullet list when the user is asking for a literal list of things (e.g. which commands they can use) — never to break down how a single command works.',
            'Keep answers short, a few sentences at most, even for "how does X work" questions. If there is genuinely a lot to say, give the short version and offer to go deeper if asked.',
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

        const history = getRecentHistory(message.author.id).flatMap(e => ([
            { role: 'user', content: e.question },
            { role: 'assistant', content: e.answer },
        ]));

        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5',
            max_tokens: 1024,
            system,
            messages: [...history, { role: 'user', content: message.content }],
        });

        db.insertAskUsage({
            userId: message.author.id,
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
        });

        const text = response.content?.[0]?.text?.trim()
            || "I couldn't come up with an answer to that — try `/help` for the full command list.";
        await message.reply(text);
        recordExchange(message.author.id, message.content, text);
    } catch (err) {
        console.error('[AskHandler] Failed to answer DM question:', err);
        await message.reply("Something went wrong answering that — try `/help` for the full command list.").catch(() => {});
    }
}

module.exports = { handleAsk, isRateLimited, getRecentHistory, recordExchange };
