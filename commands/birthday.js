const Birthday = require('../models/Birthday');
const { checkBirthdays } = require('../utils/birthdayCheck');

module.exports = {
  name: 'birthday',
  description: 'Register or view your birthday',
  async execute(message, args) {
    try {
      if (!args.length) {
        return message.reply('Usage: `?birthday list`, `?birthday trigger`, or `?birthday MM-DD` or `?birthday MM-DD-YYYY`');
      }

      const subcommand = args[0].toLowerCase();

      if (subcommand === 'list') {
        const birthdays = Birthday.findByGuild(message.guildId);
        if (!birthdays.length) {
          return message.reply('No birthdays registered in this guild yet.');
        }
        let listStr = '**Birthdays in this guild:**\n';
        for (const bday of birthdays) {
          const dateStr = bday.year ? `${bday.month}/${bday.day}/${bday.year}` : `${bday.month}/${bday.day}`;
          listStr += `<@${bday.user_id}> - ${dateStr}\n`;
        }
        return message.reply(listStr);
      }

      if (subcommand === 'trigger') {
        await message.reply('Checking for birthdays today...');
        await checkBirthdays(message.client);
        return message.reply('Birthday check complete!');
      }

      const parts = args[0].split('-').map(p => parseInt(p, 10));
      if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) {
        return message.reply('Invalid format. Use `MM-DD` or `MM-DD-YYYY`.');
      }

      const [month, day, year] = parts;
      if (month < 1 || month > 12 || day < 1 || day > 31) {
        return message.reply('Invalid month (1-12) or day (1-31).');
      }

      Birthday.upsert(message.author.id, message.author.username, month, day, year, message.guildId);

      const dateStr = year ? `${month}/${day}/${year}` : `${month}/${day}`;
      message.reply(`Birthday registered: ${dateStr} 🎂`);
    } catch (err) {
      console.error('Birthday command error:', err);
      message.reply('Failed to register birthday.');
    }
  }
};
