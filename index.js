require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits } = require('discord.js');
const { scheduleBirthdayCheck } = require('./utils/birthdayCheck');

// Initialize SQLite (creates tables if needed)
require('./utils/db');

const prefix = process.env.PREFIX || '!';
const token = process.env.DISCORD_TOKEN;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.commands = new Map();
client.slashCommands = new Map();

const slashPath = path.join(__dirname, 'slash-commands');
if (fs.existsSync(slashPath)) {
  for (const file of fs.readdirSync(slashPath).filter(f => f.endsWith('.js'))) {
    try {
      const cmd = require(path.join(slashPath, file));
      if (cmd?.data && typeof cmd.execute === 'function') {
        client.slashCommands.set(cmd.data.name, cmd);
        console.log(`Loaded slash command: ${cmd.data.name}`);
      }
    } catch (err) {
      console.error(`Failed to load slash command ${file}:`, err);
    }
  }
}

const commandsPath = path.join(__dirname, 'commands');
if (fs.existsSync(commandsPath)) {
  for (const file of fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
    try {
      const cmd = require(path.join(commandsPath, file));
      if (cmd?.name && typeof cmd.execute === 'function') {
        client.commands.set(cmd.name, cmd);
        console.log(`Loaded command: ${cmd.name}`);
      }
    } catch (err) {
      console.error(`Failed to load command ${file}:`, err);
    }
  }
}

client.once('clientReady', () => {
  console.log(`Ready. Logged in as ${client.user?.tag}`);
  scheduleBirthdayCheck(client);
});

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/\s+/);
  const cmdName = args.shift().toLowerCase();
  const cmd = client.commands.get(cmdName);
  if (!cmd) return;

  try {
    await cmd.execute(message, args);
  } catch (err) {
    console.error('Command error:', err);
    message.reply('There was an error while executing that command.');
  }
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
        try {
          const deploy = require('./deploy-commands');
          if (typeof deploy.registerCommands === 'function') {
            console.log('DEV_REGISTER: registering slash commands...');
            await deploy.registerCommands();
          }
        } catch (e) {
          console.error('Command registration failed:', e);
        }
      }
      await client.login(token);
    } catch (err) {
      console.error('Login failed:', err);
    }
  })();
} else {
  console.log('DISCORD_TOKEN not set. Skipping login.');
}
