function autoDelete(interaction, ms = 30_000) {
    setTimeout(async () => {
        try { await interaction.deleteReply(); } catch {}
    }, ms);
}

module.exports = { autoDelete };
