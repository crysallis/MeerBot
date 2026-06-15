const { SlashCommandBuilder } = require('discord.js');
const { ping: pingConfig } = require('../config');
const { enforcePermissions } = require('../utils/permissions');

const COMMENTS = {
    godlike: [
        "Are you even on the internet right now? 👁️",
        "The signal arrived before you sent it. Somehow.",
        "I felt that before you clicked.",
    ],
    great: [
        "Snappy! I like it.",
        "Quick like a meerkat on lookout duty. 🦡",
        "Basically instant. Very cash money.",
    ],
    good: [
        "Solid. No complaints here.",
        "Normal human speeds. Respectable.",
        "I've had worse. I've had better. This is fine.",
    ],
    meh: [
        "A little sluggish but we're not judging.",
        "Did you sneeze while the packet was in transit?",
        "The data took a scenic route.",
        "Someone's microwave is interfering with the wifi again.",
    ],
    bad: [
        "Are you pinging from the moon? 🌕",
        "The packet stopped for coffee.",
        "I sent a raven as backup. It'll arrive first.",
        "That's... a number. It is a number.",
    ],
    terrible: [
        "I'm calling someone. This isn't okay.",
        "Sir, your internet is suffering. Please check on it.",
        "At this speed the guild will have disbanded by the time this arrives.",
        "The packet went via dial-up. I can tell.",
    ],
};

function quip(ms) {
    const t = pingConfig.tiers;
    let bucket;
    if (ms < t.godlike)      bucket = 'godlike';
    else if (ms < t.great)   bucket = 'great';
    else if (ms < t.good)    bucket = 'good';
    else if (ms < t.meh)     bucket = 'meh';
    else if (ms < t.bad)     bucket = 'bad';
    else                     bucket = 'terrible';
    const list = COMMENTS[bucket];
    return list[Math.floor(Math.random() * list.length)];
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Replies with Pong and shows latency'),
  async execute(interaction) {
    if (!(await enforcePermissions(interaction, 'ping', null))) return;
    try {
      const before = Date.now();
      await interaction.reply({ content: 'Pinging...' });
      const after = Date.now();
      const msgLatency = after - before;
      await interaction.editReply(`Pong! 🏓\nMessage latency: ${msgLatency}ms\n*${quip(msgLatency)}*`);
    } catch (err) {
      console.error('Slash ping failed:', err);
      try {
        if (!interaction.replied) await interaction.reply('Pong! (unable to measure latency)');
        else await interaction.editReply('Pong! (unable to measure latency)');
      } catch (e) {
        // ignore secondary failures
      }
    }
  }
};
