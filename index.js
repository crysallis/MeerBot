require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Partials, MessageFlags, ActivityType } = require('discord.js');
const { initJobScheduler } = require('./utils/jobScheduler');
const { logCommand } = require('./utils/commandLogger');
const { handleMessage } = require('./utils/messageReactions');
const { handleTranslationRole } = require('./utils/handlers/translationRoleHandler');
const { handlePromoCode } = require('./utils/handlers/promoCodeHandler');
const { handleTranslationRelay, handleTranslationReactionSync, handleTranslationEditSync, handleTranslationDeleteSync } = require('./utils/handlers/translationRelayHandler');
const { handleTransferButton } = require('./utils/handlers/transferButtonHandler');
const { handleGloryctaReactionGuard } = require('./utils/handlers/gloryctaReactionGuard');
const { handleGloryctaCancelButton } = require('./utils/handlers/gloryctaCancelButtonHandler');
const { rateLimit } = require('./config');

require('./utils/db');

const token = process.env.DISCORD_TOKEN;

const cmdTimestamps = [];

function isRateLimited() {
  const now = Date.now();
  while (cmdTimestamps.length && cmdTimestamps[0] < now - rateLimit.windowMs) {
    cmdTimestamps.shift();
  }
  if (cmdTimestamps.length >= rateLimit.maxCommands) return true;
  cmdTimestamps.push(now);
  return false;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Reaction],
});

client.slashCommands = new Map();

const slashPath = path.join(__dirname, 'slash-commands');
for (const file of fs.readdirSync(slashPath).filter(f => f.endsWith('.js'))) {
  try {
    const cmd = require(path.join(slashPath, file));
    if (cmd?.data && typeof cmd.execute === 'function') {
      client.slashCommands.set(cmd.data.name, cmd);
      console.log(`Loaded: ${cmd.data.name}`);
    }
  } catch (err) {
    console.error(`Failed to load ${file}:`, err);
  }
}

client.once('clientReady', () => {
  console.log(`Ready. Logged in as ${client.user?.tag}`);
  client.user.setActivity('github.com/crysallis/MeerBot · /help', { type: ActivityType.Playing });
  initJobScheduler(client);
});

client.on('messageCreate', message => {
  handleMessage(message, client);
  handlePromoCode(message);
  handleTranslationRelay(message, client).catch(err => console.error('[TranslationRelay] Unhandled error:', err));
});
client.on('messageReactionAdd', (reaction, user) => {
  handleTranslationReactionSync(reaction, user, client, true).catch(err => console.error('[TranslationRelay] Reaction sync (add) unhandled error:', err));
  handleGloryctaReactionGuard(reaction, user, client).catch(err => console.error('[Glorycta] Reaction guard unhandled error:', err));
});
client.on('messageReactionRemove', (reaction, user) => {
  handleTranslationReactionSync(reaction, user, client, false).catch(err => console.error('[TranslationRelay] Reaction sync (remove) unhandled error:', err));
});
client.on('messageUpdate', async (oldMessage, newMessage) => {
  // partials: [Partials.Message] means newMessage can arrive uncached (author undefined,
  // content unavailable). Fetch it rather than silently dropping the edit -- mirrors the
  // existing precedent in handleTranslationReactionSync (Task 3), which fetches partial
  // reactions instead of discarding them. A fetch failure (e.g. message since deleted)
  // still bails out, same as before.
  if (newMessage.partial) {
    try {
      newMessage = await newMessage.fetch();
    } catch (err) {
      console.error('[TranslationRelay] Failed to fetch partial message for edit sync:', err.message);
      return;
    }
  }
  // Discord also fires messageUpdate ~1s after link-embed unfurl with identical content --
  // skip those so an edit sync isn't triggered (and Claude isn't re-billed) for a no-op edit.
  // When oldMessage itself is partial, its content can't be compared reliably at all (may
  // be missing/stale) -- treat that case as "skip" too, rather than falling through to a
  // real re-translation for what's likely just another no-op embed-load update.
  if (oldMessage?.partial || oldMessage?.content === newMessage.content) return;
  handleTranslationEditSync(newMessage, client).catch(err => console.error('[TranslationRelay] Edit sync unhandled error:', err));
});
client.on('messageDelete', message => {
  // message.id is always present even when the message arrives partial (uncached) -- and
  // a deleted message can't be fetched from the API anyway, so there's nothing to fetch
  // here unlike the messageUpdate case above.
  handleTranslationDeleteSync(message, client).catch(err => console.error('[TranslationRelay] Delete sync unhandled error:', err));
});
client.on('guildMemberUpdate', (oldMember, newMember) => handleTranslationRole(oldMember, newMember, client));

client.on('interactionCreate', async interaction => {
  if (interaction.isButton()) {
    try {
      const handled = await handleTransferButton(interaction);
      if (!handled) await handleGloryctaCancelButton(interaction);
    } catch (err) {
      console.error('Button interaction error:', err);
    }
    return;
  }

  if (interaction.isAutocomplete()) {
    if (interaction.guildId !== process.env.GUILD_ID) return;
    const cmd = client.slashCommands.get(interaction.commandName);
    if (cmd?.autocomplete) {
      try { await cmd.autocomplete(interaction); } catch (err) {
        console.error('Autocomplete error:', err);
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  if (interaction.guildId !== process.env.GUILD_ID) return;
  const cmd = client.slashCommands.get(interaction.commandName);
  if (!cmd) return;

  if (isRateLimited()) {
    console.warn(`[RateLimit] Blocked /${interaction.commandName} from ${interaction.user.tag}`);
    return interaction.reply({ content: 'The bot is receiving too many commands right now... please try again in a moment.', flags: MessageFlags.Ephemeral });
  }

  logCommand(interaction);

  try {
    await cmd.execute(interaction);
  } catch (err) {
    console.error('Slash command error:', err);
    const msg = 'There was an error while executing that command.';
    if (interaction.replied || interaction.deferred) {
      try { await interaction.editReply(msg); } catch (e) {}
    } else {
      try { await interaction.reply(msg); } catch (e) {}
    }
  }
});

if (token) {
  (async () => {
    try {
      if (process.env.DEV_REGISTER === 'true') {
        const deploy = require('./deploy-commands');
        if (typeof deploy.registerCommands === 'function') {
          console.log('DEV_REGISTER: registering slash commands...');
          await deploy.registerCommands();
        }
      }
      await client.login(token);
    } catch (err) {
      console.error('Login failed:', err);
    }
  })();
}
