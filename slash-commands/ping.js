const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Replies with Pong and shows latency'),
  async execute(interaction) {
    try {
      const before = Date.now();
      await interaction.reply({ content: 'Pinging...' });
      const after = Date.now();
      const msgLatency = after - before;
      const apiLatency = Math.round(interaction.client.ws.ping);
      await interaction.editReply(`Pong! 🏓\nMessage latency: ${msgLatency}ms`);
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
