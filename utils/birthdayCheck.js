const Birthday = require('../models/Birthday');
const { EmbedBuilder } = require('discord.js');

async function checkBirthdays(client) {
  try {
    const today = new Date();
    const month = today.getMonth() + 1;
    const day = today.getDate();

    const todayBirthdays = Birthday.findToday();

    if (!todayBirthdays.length) {
      console.log(`[Birthday Check] No birthdays today (${month}/${day})`);
      return;
    }

    console.log(`[Birthday Check] Found ${todayBirthdays.length} birthday(s) on ${month}/${day}`);

    const byGuild = {};
    for (const bday of todayBirthdays) {
      if (!byGuild[bday.guild_id]) byGuild[bday.guild_id] = [];
      byGuild[bday.guild_id].push(bday);
    }

    for (const guildId in byGuild) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        console.log(`[Birthday Check] Guild ${guildId} not found in cache`);
        continue;
      }

      const channelId = process.env.BIRTHDAY_CHANNEL_ID;
      if (!channelId) {
        console.log(`[Birthday Check] BIRTHDAY_CHANNEL_ID not set; skipping guild ${guildId}`);
        continue;
      }

      const channel = guild.channels.cache.get(channelId);
      if (!channel || !channel.isTextBased()) {
        console.log(`[Birthday Check] Channel ${channelId} not found or not text-based`);
        continue;
      }

      const birthdays = byGuild[guildId];
      const userMentions = birthdays.map(b => `<@${b.user_id}>`).join(', ');

      let description = '';
      for (const bday of birthdays) {
        if (bday.year) {
          const age = new Date().getFullYear() - bday.year;
          description += `<@${bday.user_id}> is turning ${age}! 🎂\n`;
        } else {
          description += `<@${bday.user_id}> is having a birthday! 🎂\n`;
        }
      }

      const embed = new EmbedBuilder()
        .setColor(0xFF69B4)
        .setTitle('🎉 Happy Birthday! 🎉')
        .setDescription(description.trim())
        .setFooter({ text: `${month}/${day}` });

      try {
        await channel.send({ content: userMentions, embeds: [embed] });
        console.log(`[Birthday Check] Sent to ${guildId}/${channelId}`);
      } catch (err) {
        console.error(`[Birthday Check] Failed to send to ${guildId}/${channelId}:`, err);
      }
    }
  } catch (err) {
    console.error('[Birthday Check] Error:', err);
  }
}

function scheduleBirthdayCheck(client) {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);

  const msUntilMidnight = tomorrow - now;
  console.log(`[Birthday Check] Scheduled in ${Math.round(msUntilMidnight / 1000)}s`);

  setTimeout(() => {
    checkBirthdays(client);
    setInterval(() => checkBirthdays(client), 24 * 60 * 60 * 1000);
  }, msUntilMidnight);
}

module.exports = { checkBirthdays, scheduleBirthdayCheck };
