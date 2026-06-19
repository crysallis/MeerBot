const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { getRecentCodes } = require('../utils/handlers/promoCodeHandler');

const PROMO_CHANNEL_ID = '1229551249209430066';

module.exports = {
  data: new SlashCommandBuilder()
    .setName('promocodes')
    .setDescription('Lists the last 10 AFK Journey promo codes'),

  async execute(interaction) {
    const codes = getRecentCodes(10);

    const embed = new EmbedBuilder()
      .setTitle('AFK Journey Promo Codes')
      .setColor(0x5865F2);

    if (!codes.length) {
      embed.setDescription('No promo codes on record yet.');
    } else {
      const lines = codes.map(({ code, posted_at }) => {
        const ts = Math.floor(new Date(posted_at).getTime() / 1000);
        return `\`${code}\` · <t:${ts}:d>`;
      });
      embed.setDescription(lines.join('\n'));
      embed.setFooter({ text: `More codes in #promo-codes` });
    }

    embed.addFields({
      name: 'Promo Codes Channel',
      value: `<#${PROMO_CHANNEL_ID}>`,
      inline: false,
    });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
};
