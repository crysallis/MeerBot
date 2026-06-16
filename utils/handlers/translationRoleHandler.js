const { EmbedBuilder } = require('discord.js');
const { pickColor } = require('../colors');
const botConfig = require('../botConfig');

const TRANSLATION_ROLE_ID = '1516271538217943131';

async function handleTranslationRole(oldMember, newMember, client) {
    const gained = !oldMember.roles.cache.has(TRANSLATION_ROLE_ID)
                && newMember.roles.cache.has(TRANSLATION_ROLE_ID);
    if (!gained) return;

    const embed = new EmbedBuilder()
        .setTitle('🌐 Translation Bot · How to Use')
        .setColor(pickColor())
        .setURL('https://interaction-bot.com/')
        .setDescription(
            'Here\'s how to use the translation bot in this server.\n\n' +
            'Aquí te explicamos cómo usar el bot de traducción en este servidor.'
        )
        .addFields(
            {
                name: '🇬🇧 How to translate',
                value: [
                    '· **React with a flag** on any message to translate it to that language',
                    '· **Slash command** · `/translate`',
                    '· **Mobile** · Press and hold a message → Apps → Translate',
                    '· **Desktop** · Right-click a message → Apps → Translate',
                ].join('\n'),
            },
            {
                name: '🇪🇸 Cómo traducir',
                value: [
                    '· **Reacciona con una bandera** en cualquier mensaje para traducirlo a ese idioma',
                    '· **Comando** · `/translate`',
                    '· **Móvil** · Pulsa y mantén un mensaje → Apps → Translate',
                    '· **PC** · Clic derecho en un mensaje → Apps → Translate',
                ].join('\n'),
            }
        );

    try {
        await newMember.send({ embeds: [embed] });
    } catch (err) {
        console.error(`[translationRole] DM failed for ${newMember.user.tag}: ${err.message}`);
        const channelId = botConfig.get('GENERAL_CHANNEL_ID');
        const channel = client.channels.cache.get(channelId);
        if (channel?.isTextBased()) {
            await channel.send(
                `<@${newMember.id}> Meerbot tried to contact you about your car insurance but was unable to reach you 🚗` +
                ` *(Check your DMs -- we sent you info about the translation bot!)*`
            ).catch(() => {});
        }
    }

    await newMember.roles.remove(TRANSLATION_ROLE_ID).catch(err => {
        console.error(`[translationRole] Failed to remove role from ${newMember.user.tag}: ${err.message}`);
    });
}

module.exports = { handleTranslationRole };
