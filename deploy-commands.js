require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');

async function registerCommands() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.APPLICATION_ID;
  const guildId = process.env.GUILD_ID; // optional but recommended for quick updates

  if (!token || !clientId) {
    throw new Error('DISCORD_TOKEN and APPLICATION_ID must be set in environment to deploy commands.');
  }

  const commands = [];
  const commandsPath = path.join(__dirname, 'slash-commands');
  if (fs.existsSync(commandsPath)) {
    const files = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
    for (const file of files) {
      const cmd = require(path.join(commandsPath, file));
      if (cmd && cmd.data && typeof cmd.data.toJSON === 'function') {
        commands.push(cmd.data.toJSON());
      }
    }
  }

  const rest = new REST({ version: '10' }).setToken(token);

  if (guildId) {
    console.log(`Registering ${commands.length} guild command(s) to guild ${guildId}...`);
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log('Guild commands registered.');
  } else {
    console.log(`Registering ${commands.length} global command(s)...`);
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('Global commands registered (may take up to an hour to propagate).');
  }
}

module.exports = { registerCommands };

// If run directly, run registration
if (require.main === module) {
  registerCommands().catch(err => {
    console.error('Failed to register commands:', err);
    process.exit(1);
  });
}
