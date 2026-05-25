module.exports = {
  name: 'help',
  description: 'Show available commands',
  async execute(message, args) {
    try {
      const prefix = process.env.PREFIX || '?';
      
      const helpText = `
**Available Commands:**

**Ping**
\`${prefix}ping\` — Check bot latency (message and API)

**Birthday**
\`${prefix}birthday MM-DD\` — Register your birthday
\`${prefix}birthday MM-DD-YYYY\` — Register birthday with birth year (for age display)
\`${prefix}birthday list\` — View all birthdays in this guild
\`${prefix}birthday trigger\` — Manually check for and announce birthdays today

**Help**
\`${prefix}help\` — Show this message

For detailed examples and usage, see USAGE.md or use \`/help\` for slash commands.
`;

      message.reply(helpText);
    } catch (err) {
      console.error('Help command error:', err);
      message.reply('Failed to display help.');
    }
  }
};
