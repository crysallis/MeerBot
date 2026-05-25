require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, MessageFlags } = require('discord.js');
const { scheduleBirthdayCheck } = require('./utils/birthdayCheck');
const { scheduleScanReminder } = require('./utils/scanReminder');
const { scheduleWeeklySummary } = require('./utils/weeklySummary');

require('./utils/db');

const token = process.env.DISCORD_TOKEN;

// Global sliding window rate limit — max 20 commands per 60 seconds across all users
const RATE_WINDOW_MS  = 60_000;
const RATE_MAX        = 20;
const cmdTimestamps   = [];

function isRateLimited() {
  const now = Date.now();
  while (cmdTimestamps.length && cmdTimestamps[0] < now - RATE_WINDOW_MS) {
    cmdTimestamps.shift();
  }
  if (cmdTimestamps.length >= RATE_MAX) return true;
  cmdTimestamps.push(now);
  return false;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.slashCommands = new Map();

const slashPath = path.join(__dirname, 'slash-commands');
for (const file of fs.readdirSync(slashPath).filter(f => f.endsWith('.js'))) {
  try {
    const cmd = require(path.join(slashPath, file));
    if (cmd?.data && typeof cmd.execute === 'function') {
      client.slashCommands.set(cmd.data.name, cmd);
      console.log(`Loaded: ${cmd.data.name}`);
    }
  } catch (err) {
    console.error(`Failed to load ${file}:`, err);
  }
}

client.once('clientReady', () => {
  console.log(`Ready. Logged in as ${client.user?.tag}`);
  scheduleBirthdayCheck(client);
  scheduleScanReminder(client);
  scheduleWeeklySummary(client);
});

client.on('interactionCreate', async interaction => {
  if (interaction.isAutocomplete()) {
    const cmd = client.slashCommands.get(interaction.commandName);
    if (cmd?.autocomplete) {
      try { await cmd.autocomplete(interaction); } catch (err) {
        console.error('Autocomplete error:', err);
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  const cmd = client.slashCommands.get(interaction.commandName);
  if (!cmd) return;

  if (isRateLimited()) {
    console.warn(`[RateLimit] Blocked /${interaction.commandName} from ${interaction.user.tag}`);
    return interaction.reply({ content: 'The bot is receiving too many commands right now... please try again in a moment.', flags: MessageFlags.Ephemeral });
  }

  try {
    await cmd.execute(interaction);
  } catch (err) {
    console.error('Slash command error:', err);
    const msg = 'There was an error while executing that command.';
    if (interaction.replied || interaction.deferred) {
      try { await interaction.editReply(msg); } catch (e) {}
    } else {
      try { await interaction.reply(msg); } catch (e) {}
    }
  }
});

if (token) {
  (async () => {
    try {
      if (process.env.DEV_REGISTER === 'true') {
        const deploy = require('./deploy-commands');
        if (typeof deploy.registerCommands === 'function') {
          console.log('DEV_REGISTER: registering slash commands...');
          await deploy.registerCommands();
        }
      }
      await client.login(token);
    } catch (err) {
      console.error('Login failed:', err);
    }
  })();
}
