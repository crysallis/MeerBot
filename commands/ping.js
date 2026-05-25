module.exports = {
  name: 'ping',
  description: 'Replies with Pong and shows latency',
  async execute(message, args) {
    try {
      // Send an initial reply so we can measure round-trip latency
      const sent = await message.reply('Pinging...');

      // Round-trip latency between user message and bot reply
      const msgLatency = sent.createdTimestamp - message.createdTimestamp;

      // Edit the reply to include timings
      await sent.edit(`Pong! 🏓\nMessage latency: ${msgLatency}ms`);
    } catch (err) {
      console.error('Ping command failed:', err);
      try {
        await message.reply('Pong! (unable to measure latency)');
      } catch (e) {
        // swallow secondary errors
      }
    }
  }
};
