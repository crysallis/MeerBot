const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show available commands'),

  async execute(interaction) {
    try {
      const helpText = `
**Available Commands:**

**Ping**
\`/ping\` — Check bot latency (message and API)

**Birthday**
\`/birthday register\` — Register your birthday with month, day, and optional year
\`/birthday list\` — View all birthdays in this guild

**Help**
\`/help\` — Show this message

For detailed examples and usage, see USAGE.md or use \`?help\` for message commands (prefix: \`?\`).
`;

      await interaction.reply(helpText);
    } catch (err) {
      console.error('Slash help error:', err);
      const content = 'Failed to display help.';
      if (!interaction.replied) await interaction.reply(content);
      else await interaction.editReply(content);
    }
  }
};
