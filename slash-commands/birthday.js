const { SlashCommandBuilder } = require('discord.js');
const Birthday = require('../models/Birthday');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('birthday')
    .setDescription('Register or manage your birthday')
    .addSubcommand(sub =>
      sub.setName('register')
        .setDescription('Register your birthday')
        .addIntegerOption(opt =>
          opt.setName('month').setDescription('Month (1-12)').setRequired(true).setMinValue(1).setMaxValue(12)
        )
        .addIntegerOption(opt =>
          opt.setName('day').setDescription('Day (1-31)').setRequired(true).setMinValue(1).setMaxValue(31)
        )
        .addIntegerOption(opt =>
          opt.setName('year').setDescription('Birth year (optional)').setRequired(false).setMinValue(1900)
        )
    )
    .addSubcommand(sub =>
      sub.setName('list').setDescription('List all birthdays in this guild')
    ),

  async execute(interaction) {
    try {
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'register') {
        const month = interaction.options.getInteger('month');
        const day   = interaction.options.getInteger('day');
        const year  = interaction.options.getInteger('year');

        Birthday.upsert(
          interaction.user.id,
          interaction.user.username,
          month, day, year,
          interaction.guildId
        );

        const dateStr = year ? `${month}/${day}/${year}` : `${month}/${day}`;
        await interaction.reply(`Birthday registered: ${dateStr} 🎂`);

      } else if (subcommand === 'list') {
        const birthdays = Birthday.findByGuild(interaction.guildId);

        if (!birthdays.length) {
          return interaction.reply('No birthdays registered in this guild yet.');
        }

        let listStr = '**Birthdays in this guild:**\n';
        for (const bday of birthdays) {
          const dateStr = bday.year ? `${bday.month}/${bday.day}/${bday.year}` : `${bday.month}/${bday.day}`;
          listStr += `<@${bday.user_id}> - ${dateStr}\n`;
        }
        await interaction.reply(listStr);
      }
    } catch (err) {
      console.error('Slash birthday error:', err);
      const msg = 'Failed to process birthday command.';
      if (!interaction.replied) await interaction.reply(msg);
      else await interaction.editReply(msg);
    }
  }
};
