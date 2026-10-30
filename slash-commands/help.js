const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { getPerm, enforcePermissions } = require('../utils/permissions');
const { pickColor } = require('../utils/colors');

const COMMANDS = {
    birthday: {
        description: 'Register and celebrate guild member birthdays.',
        subcommands: [
            { name: '/birthday register month: day:', desc: 'Register your birthday. Day is validated against the month (Feb 29 is allowed for leap-day births). Only you see the reply.' },
            { name: '/birthday list',                       desc: 'List all registered birthdays, sorted by month/day. Shows in-game name if linked. Only you see the reply.' },
            { name: '/birthday remove',                     desc: 'Remove your registered birthday. Only you see the reply.' },
        ],
    },
    guild: {
        description: 'Guild member statistics · all use the most recent snapshot.',
        subcommands: [
            { name: '/guild power',        desc: 'All members ranked by combat power (highest first) The reply is public.' },
            { name: '/guild top number:',  desc: 'Top N members by combat power (default 10, max 50) The reply is public.' },
            { name: '/guild inactive',     desc: 'All members ranked by last active (longest offline first) The reply is public.' },
            { name: '/guild activeness',   desc: 'All members ranked by activeness score (lowest first) The reply is public.' },
            { name: '/guild growth',       desc: 'Top 5 members by power increase vs previous snapshot The reply is public.' },
            { name: '/guild nogrowth',     desc: 'Members with zero power growth vs previous snapshot The reply is public.' },
            { name: '/guild status',       desc: 'Guild summary: member count, total power, active counts, last scan time The reply is public.' },
            { name: '/guild newcomers',    desc: 'Members who were not in the previous snapshot The reply is public.' },
            { name: '/guild chart number:', desc: 'Power growth line chart for current members over the last 10 scans. Optional N to limit to top N by power. The reply is public.' },
            { name: '/guild warbands',     desc: 'All warbands with member counts, total power, and average activeness. The reply is public.' },
            { name: '/guild unlinked',     desc: 'Active members not yet linked to a Discord account. The reply is public.' },
            { name: '/guild seasongrowth season:', desc: 'Every active member ranked by power growth within a season -- each member\'s own first scan of that season vs their own last scan of that season. The reply is public.' },
            { name: '/guild seasontonow season:', desc: 'Same as seasongrowth, but growth runs from a season\'s start up to the most recent scan overall, even past that season\'s end -- use for an in-progress season. The reply is public.' },
        ],
    },
    ping: {
        description: 'Health check with a fun latency tier comment.',
        subcommands: [
            { name: '/ping', desc: 'Replies with Pong and the measured message latency in ms. The reply is public.' },
        ],
    },
    glory: {
        description: 'Clash of Glory guild coordination · vote on a battle time, confirm the decided time, and count reactions.',
        subcommands: [
            { name: '/glory cta time1: time2: duration:', desc: 'Post a poll offering two UTC HH:MM battle times to vote between. Closes and tallies automatically after `duration` hours. Has a Cancel Vote button, same permission as the command. Posts the poll publicly in the channel; you get a private confirmation.' },
            { name: '/glory confirm time:', desc: 'Post the decided UTC HH:MM battle time (shown in Local + UTC, same as `/glory cta`) for yes/no/maybe (✅/❌/🤔) availability confirmation. No time limit, not auto-tallied. Posts the check publicly in the channel; you get a private confirmation.' },
            { name: '/glory count message:', desc: 'Count reactions on a `/glory cta` or `/glory confirm` post. Pass a message link (right-click/long-press the post → Copy Message Link). Posts the tally publicly in the channel the post is in; you get a private confirmation.' },
        ],
    },
    guildduel: {
        description: 'Guild Duel Battle Report data · see who the scan missed, who is falling short, and fill in rows by hand.',
        subcommands: [
            { name: '/guildduel low', desc: 'Members falling short on guild activity: Guild Duel crests well under the weekly guild median in 3+ of the last 8 weeks, or any week with activeness under 500. Calls out anyone who earned crests but never attacked, and adds a damage note under each flagged member (share of crests spent against the guild mean hit, with an adjustable floor). Only you see the reply.' },
            { name: '/guildduel missing', desc: 'Lists active members with no Guild Duel row for the current Battle Report week. Only you see the reply.' },
            { name: '/guildduel recap date:', desc: 'Posts a numbers-only recap of one finished Guild Duel week: damage dealt, hits and average hit, and how many hits went unspent (no names). Date is any day in the duel week; leave it empty for the latest finished one. Weeks before Oct 19, 2026 have no data, and the current duel is available next week. Defaults to Manage Server only. The reply is public.' },
            { name: '/guildduel add name: crests: rank:', desc: 'Add or correct one member\'s row for the current week. Name autocompletes, rank is optional (an existing rank is kept). Defaults to Manage Server only. Only you see the reply.' },
        ],
    },
    clashfronts: {
        description: 'Clashfronts sign-up tracking · who has signed up, who still needs to, and a nudge for the rest. Reads the most recent Clashfronts scan.',
        subcommands: [
            { name: '/clashfronts signedup', desc: 'Lists members who signed up, marking who has been selected (✅) and who has not yet (🚫). Only you see the reply.' },
            { name: '/clashfronts notsigned', desc: 'Lists active members who have not signed up. Members on AFK are left out. Only you see the reply.' },
            { name: '/clashfronts remind', desc: 'Posts a reminder in the Clashfronts reminder channel pinging every member who has not signed up. Members not linked to Discord are listed separately, since they cannot be pinged. Posts the reminder publicly in the reminder channel; you get a private confirmation.' },
        ],
    },
    member: {
        description: 'Look up a single guild member.',
        subcommands: [
            { name: '/member name:',  desc: 'Shows current stats and up to 8 weeks of snapshot history. Name autocompletes. The reply is public.' },
            { name: '/member user:',  desc: 'Look up by @mention if the user is linked to an in-game name. The reply is public.' },
        ],
    },
    invasion: {
        description: 'Alert the Homestead role that a homestead is being invaded (posts an embed in the Homestead channel).',
        subcommands: [
            { name: '/invasion',       desc: 'Alert for your own Homestead and ping the Homestead role. Posts the alert publicly in the Homestead channel; you get a private confirmation.' },
            { name: '/invasion name:', desc: "Alert for a specific in-game member's Homestead. Name autocompletes. Posts the alert publicly in the Homestead channel; you get a private confirmation." },
            { name: '/invasion user:', desc: "Alert for a linked Discord user's Homestead. Posts the alert publicly in the Homestead channel; you get a private confirmation." },
        ],
    },
    link: {
        description: 'Link a Discord account to an in-game name.',
        subcommands: [
            { name: '/link ingame_name:',                desc: 'Link yourself. Warns if a link already exists on either side. Only you see the reply.' },
            { name: '/link ingame_name: user:',          desc: 'Link a different Discord user. Only you see the reply.', perm: 'admin' },
            { name: '/link ingame_name: confirm:True',   desc: 'Overwrite an existing conflicting link after reviewing the warning. Only you see the reply.' },
        ],
    },
    scan: {
        description: 'Trigger a live guild member scan. Requires BlueStacks and the game to be open.',
        perm: 'scanUser',
        subcommands: [
            { name: '/scan', desc: 'Optional Guild Duel Damage mode (admin Scan Modes tab, off by default) also reads boss damage for every member on Saturday and Sunday UTC. Navigates to the guild member list, scrapes all data, and saves a snapshot. Afterwards posts an inactivity alert for active members who have been offline too long (AFK-exempt members excluded, departed members excluded). The reply is public.' },
        ],
    },
    anniversary: {
        description: 'Guild anniversary tools (1mo / 3mo / 6mo / yearly milestones from first_seen).',
        subcommands: [
            { name: '/anniversary list count:', desc: 'Show the next N upcoming anniversaries (default 5, max 20). Only you see the reply.' },
            { name: '/anniversary upcoming days:', desc: 'Show all anniversaries in the next N days (default 30, max 365). Only you see the reply.' },
        ],
    },
    remindme: {
        description: 'Set a personal reminder. The bot will DM you (or mention you in this channel if DMs are off) when the time arrives.',
        subcommands: [
            { name: '/remindme set time: message:', desc: 'Set a reminder. Duration format: `2h`, `1d12h`, `45m` (min 1h · max 90d). Only you see the reply.' },
            { name: '/remindme list',               desc: 'List your pending reminders with IDs and time remaining. Only you see the reply.' },
            { name: '/remindme cancel id:',         desc: 'Cancel a pending reminder by its ID. Only you see the reply.' },
        ],
    },
    rename: {
        description: 'Rename a guild member in the database.',
        subcommands: [
            { name: '/rename old_name: new_name:', desc: 'Updates the member record, logs the change to history, and adds a name correction so future scans map correctly. Only you see the reply.' },
        ],
    },
    note: {
        description: 'Guild leader notes on members.',
        subcommands: [
            { name: '/note add name: text:', desc: 'Add a note to a member. Only you see the reply.' },
            { name: '/note view name:',      desc: 'View all notes for a member, with IDs and timestamps. Only you see the reply.' },
            { name: '/note delete id:',      desc: 'Delete a specific note by its ID. Only you see the reply.' },
        ],
    },
    pearlbazaar: {
        description: 'Drill-in scan of Pearl Bazaar prices across SA ranks 1-100.',
        subcommands: [
            { name: '/pearlbazaar floor:', desc: 'Posts today\'s price + remaining cap for sellers at or above floor (default 800) who still have stock. No guild filter, run manually a few times a quarter. The reply is public.' },
        ],
    },
    titles: {
        description: 'Find the easter-eggs forum post(s) explaining how to get a title.',
        subcommands: [
            { name: '/titles titlename:', desc: 'Look up a title and get jump links to every post that explains how to earn it. Only you see the reply.' },
        ],
    },
    review: {
        description: 'Review members the scanner flagged as new or unrecognized (pending).',
        perm: 'scanUser',
        subcommands: [
            { name: '/review list',                          desc: 'List pending members awaiting review, with power and warband. Only you see the reply.' },
            { name: '/review approve name:',                 desc: 'Confirm a pending member is real and correctly named. Only you see the reply.' },
            { name: '/review merge pending_name: into_name:', desc: 'Merge a pending duplicate into an existing member. Only you see the reply.' },
            { name: '/review remove name:',                  desc: 'Mark a member who left the guild as inactive (drops from /guild views). Only you see the reply.' },
            { name: '/review return name:',                  desc: 'Reactivate a member previously removed or gone inactive. Only you see the reply.' },
        ],
    },
    afk: {
        description: 'Mark members as AFK to exempt them from inactivity alerts.',
        subcommands: [
            { name: '/afk set name: reason: return_date:', desc: 'Mark a member AFK. Reason and return date optional. Date format: YYYY-MM-DD. The reply is public.' },
            { name: '/afk clear name:',                    desc: 'Remove AFK status from a member. The reply is public.' },
            { name: '/afk list',                           desc: 'Show all currently AFK members. Only you see the reply.' },
        ],
    },
    season: {
        description: 'Manage ally seasons and their server lists. Seasons can be prepared before going active.',
        subcommands: [
            { name: '/season add name:',                    desc: 'Create a new season (inactive by default). Only you see the reply.' },
            { name: '/season activate season:',             desc: 'Mark a season as active. Only you see the reply.' },
            { name: '/season inactivate season:',           desc: 'Mark a season as inactive. Only you see the reply.' },
            { name: '/season allyadd season: server:',      desc: 'Add an ally server number to a season. Only you see the reply.' },
            { name: '/season allyremove season: server:',   desc: 'Remove an ally server number from a season. Only you see the reply.' },
            { name: '/season allylist season:',             desc: 'List ally servers for a season (omit season for active). Only you see the reply.' },
        ],
    },
    recruitment: {
        description: 'Track guild recruitment prospects with stats, status, interest level, and auto follow-up reminders.',
        subcommands: [
            { name: '/recruitment add name: power: contacted: server: ...', desc: 'Add a prospect. Status defaults to scouting. Optional: dr/sup_arena/lab/dual ranks, interest, response, status. Schedules a 2-day follow-up reminder. Only you see the reply.' },
            { name: '/recruitment list',                    desc: 'View prospects (defaults to scouting + invited). Filters: status, interest, server, date ±14 days. Max 20 shown. The reply is public.' },
            { name: '/recruitment update name: ...',        desc: 'Update any field: status (scouting/invited/joined/declined), interest, response, power, server, contacted, ranks. Only you see the reply.' },
            { name: '/recruitment remove name:',            desc: 'Remove a prospect (also cancels any pending follow-up reminder). Only you see the reply.' },
        ],
    },
    wishlist: {
        description: 'Guild feature wishlist. Anyone can submit; use Discord permissions to restrict add/remove.',
        subcommands: [
            { name: '/wishlist add item: priority:', desc: 'Submit a new wishlist item with high / medium / low priority. Only you see the reply.' },
            { name: '/wishlist list',                desc: 'View all wishlist items sorted by priority then date. The reply is public.' },
            { name: '/wishlist remove id:',          desc: 'Remove a wishlist item by its ID. Only you see the reply.' },
        ],
    },
    newsletter: {
        description: 'Guild newsletter tools. Generate Claude-drafted issues using notes and live DB context.',
        subcommands: [
            { name: '/newsletter note add text: category:',  desc: 'Log a note or event for the next newsletter (category: event / member / season / other). Only you see the reply.' },
            { name: '/newsletter note list',                  desc: 'Show all notes logged since the last newsletter. Only you see the reply.' },
            { name: '/newsletter note remove id:',            desc: 'Delete a note by ID. Only you see the reply.' },
            { name: '/newsletter generate',                   desc: 'Generate a draft newsletter. Returns a .txt file with a material summary (new members, departures, anniversaries, notes) followed by a Claude-written draft. Does not sign off -- Kit edits before posting. Only you see the reply.' },
            { name: '/newsletter seed',                       desc: 'Import past newsletters from the newsletter channel into the DB. Re-runnable -- safe to run after each new issue is posted. Only you see the reply.' },
        ],
    },
    roster: {
        description: 'Manage guild membership roles (RKF RiffRaff · RKR Frop).',
        subcommands: [
            { name: '/roster add guild: user:',         desc: 'Add a member to a guild, by granting the correct guild level roles. It also removes the Who Dis? role if present and sends a welcome message. The reply is public.' },
            { name: '/roster remove guild: user:',      desc: 'Remove a member from a guild, by removing the correct guild level roles. The reply is public.' },
            { name: '/roster transfer user: to_warband:', desc: 'Request moving a member to a different warband (autocomplete). If the initiator leads only one side, the OTHER side\'s warband leader (or their guild\'s override role, e.g. Riff/Raff) must approve via buttons posted in the-not-so-round-table and DMed to them -- executes immediately only if the initiator leads both warbands or holds an override role. Roles update on approval; guild.db catches up on the next scan. The reply is public.' },
        ],
    },
};

function visibleCommands(interaction) {
    return Object.keys(COMMANDS).filter(k => {
        const perm = getPerm(COMMANDS[k].perm);
        return perm.check(interaction);
    });
}

function permTag(permName) {
    if (!permName || permName === 'everyone') return '';
    return `\n*Requires: ${getPerm(permName).label}*`;
}

module.exports = {
    COMMANDS,
    async autocomplete(interaction) {
        const focused = interaction.options.getFocused().toLowerCase();
        const visible = visibleCommands(interaction);
        const filtered = visible.filter(k => k.includes(focused));
        await interaction.respond(filtered.map(k => ({ name: k, value: k })));
    },

    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('List all commands or get details on a specific one')
        .addStringOption(opt =>
            opt.setName('command')
                .setDescription('Command to get details on')
                .setRequired(false)
                .setAutocomplete(true)
        ),

    async execute(interaction) {
        if (!(await enforcePermissions(interaction, 'help', null))) return;
        const cmd = interaction.options.getString('command');

        if (cmd) {
            const info = COMMANDS[cmd];
            if (!info) {
                return interaction.reply({ content: `Unknown command \`/${cmd}\`.`, flags: MessageFlags.Ephemeral });
            }
            // Block detail view for restricted commands the user can't run
            const cmdPerm = getPerm(info.perm);
            if (!cmdPerm.check(interaction)) {
                return interaction.reply({
                    content: `You don't have access to \`/${cmd}\` · requires **${cmdPerm.label}**.`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            const headerPerm = info.perm && info.perm !== 'everyone'
                ? `**Requires: ${cmdPerm.label}**\n\n${info.description}`
                : info.description;

            const embed = new EmbedBuilder()
                .setTitle(`📖 /${cmd}`)
                .setColor(pickColor())
                .setDescription(headerPerm)
                .addFields(info.subcommands.map(s => ({
                    name: s.name,
                    value: s.desc + permTag(s.perm),
                })));
            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        // Top-level list · only commands the caller can run
        const visible = visibleCommands(interaction);
        const summaries = {
            birthday: 'Register · list · remove birthdays',
            guild: 'power · top · inactive · activeness · growth · nogrowth · status · newcomers · chart · warbands · unlinked',
            member: 'Look up a member by name or @mention',
            invasion: 'Ping Homestead to repel an invasion',
            link: 'Link your Discord to your in-game name',
            anniversary: 'list · upcoming',
            remindme: 'Set · list · cancel personal reminders',
            ping: 'Latency check with a quip',
            glory: 'Clash of Glory vote · confirm · count',
            guildduel: 'low · missing · recap · add Guild Duel rows by hand',
            clashfronts: 'signedup · notsigned · remind',
            scan: 'Trigger a guild scan',
            rename: 'Rename a member in the database',
            note: 'Add · view · delete notes on members',
            pearlbazaar: 'Pearl Bazaar price scan',
            titles: 'Look up a title, get links to the posts explaining it',
            review: 'list · approve · merge · remove · return',
            afk: 'Set · clear · list AFK status',
            season: 'add · activate · inactivate · allyadd · allyremove · allylist',
            recruitment: 'add · list · update · remove prospects',
            wishlist: 'add · list · remove wishlist items',
            newsletter: 'note add/list/remove · generate · seed',
            roster: 'add · remove · transfer guild members',
        };

        const fields = visible.map(k => {
            const perm = COMMANDS[k].perm;
            const tag = (perm && perm !== 'everyone') ? ` · *${getPerm(perm).label}*` : '';
            return { name: `/${k}`, value: (summaries[k] || '') + tag };
        });
        fields.push({ name: '/help', value: 'You\'re looking at it. Add `command:name` for details.' });

        const embed = new EmbedBuilder()
            .setTitle('📖 Meerbot Commands')
            .setColor(pickColor())
            .setDescription('Use `/help command:name` for details and subcommands.')
            .addFields(fields);

        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
};
