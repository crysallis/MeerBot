const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { getPerm } = require('../utils/permissions');
const { pickColor } = require('../utils/colors');

const COMMANDS = {
    birthday: {
        description: 'Register and celebrate guild member birthdays.',
        subcommands: [
            { name: '/birthday register month: day:', desc: 'Register your birthday. Day is validated against the month (Feb 29 is allowed for leap-day births).' },
            { name: '/birthday list',                       desc: 'List all registered birthdays, sorted by month/day. Shows in-game name if linked.' },
            { name: '/birthday remove',                     desc: 'Remove your registered birthday.' },
        ],
    },
    guild: {
        description: 'Guild member statistics · all use the most recent snapshot.',
        subcommands: [
            { name: '/guild power',        desc: 'All members ranked by combat power (highest first)' },
            { name: '/guild top number:',  desc: 'Top N members by combat power (default 10, max 50)' },
            { name: '/guild inactive',     desc: 'All members ranked by last active (longest offline first)' },
            { name: '/guild activeness',   desc: 'All members ranked by activeness score (lowest first)' },
            { name: '/guild growth',       desc: 'Top 5 members by power increase vs previous snapshot' },
            { name: '/guild nogrowth',     desc: 'Members with zero power growth vs previous snapshot' },
            { name: '/guild status',       desc: 'Guild summary: member count, total power, active counts, last scan time' },
            { name: '/guild newcomers',    desc: 'Members who were not in the previous snapshot' },
            { name: '/guild chart number:', desc: 'Power growth line chart for current members over the last 10 scans. Optional N to limit to top N by power.' },
            { name: '/guild warbands',     desc: 'All warbands with member counts, total power, and average activeness.' },
            { name: '/guild unlinked',     desc: 'Active members not yet linked to a Discord account.' },
        ],
    },
    ping: {
        description: 'Health check with a fun latency tier comment.',
        subcommands: [
            { name: '/ping', desc: 'Replies with Pong and the measured message latency in ms.' },
        ],
    },
    member: {
        description: 'Look up a single guild member.',
        subcommands: [
            { name: '/member name:',  desc: 'Shows current stats and up to 8 weeks of snapshot history. Name autocompletes.' },
            { name: '/member user:',  desc: 'Look up by @mention if the user is linked to an in-game name.' },
        ],
    },
    link: {
        description: 'Link a Discord account to an in-game name.',
        subcommands: [
            { name: '/link ingame_name:',                desc: 'Link yourself. Warns if a link already exists on either side.' },
            { name: '/link ingame_name: user:',          desc: 'Link a different Discord user.', perm: 'admin' },
            { name: '/link ingame_name: confirm:True',   desc: 'Overwrite an existing conflicting link after reviewing the warning.' },
        ],
    },
    scan: {
        description: 'Trigger a live guild member scan. Requires BlueStacks and the game to be open.',
        perm: 'scanUser',
        subcommands: [
            { name: '/scan', desc: 'Navigates to the guild member list, scrapes all data, and saves a snapshot. Afterwards posts an inactivity alert for active members who have been offline too long (AFK-exempt members excluded, departed members excluded).' },
        ],
    },
    anniversary: {
        description: 'Guild anniversary tools (1mo / 3mo / 6mo / yearly milestones from first_seen).',
        subcommands: [
            { name: '/anniversary list count:', desc: 'Show the next N upcoming anniversaries (default 5, max 20). Ephemeral.' },
            { name: '/anniversary upcoming days:', desc: 'Show all anniversaries in the next N days (default 30, max 365). Ephemeral.' },
        ],
    },
    remindme: {
        description: 'Set a personal reminder. The bot will DM you (or mention you in this channel if DMs are off) when the time arrives.',
        subcommands: [
            { name: '/remindme set time: message:', desc: 'Set a reminder. Duration format: `2h`, `1d12h`, `45m` (min 1h · max 90d).' },
            { name: '/remindme list',               desc: 'List your pending reminders with IDs and time remaining.' },
            { name: '/remindme cancel id:',         desc: 'Cancel a pending reminder by its ID.' },
        ],
    },
    schedule: {
        description: 'View all scheduled system jobs (daily reset, AFK expiry, birthday check, scan reminder, weekly summary, anniversary check) with last/next run times.',
        subcommands: [
            { name: '/schedule', desc: 'Ephemeral embed showing all system jobs, when they last ran, and when they next fire.' },
        ],
    },
    rename: {
        description: 'Rename a guild member in the database.',
        subcommands: [
            { name: '/rename old_name: new_name:', desc: 'Updates the member record, logs the change to history, and adds a name correction so future scans map correctly.' },
        ],
    },
    note: {
        description: 'Guild leader notes on members.',
        subcommands: [
            { name: '/note add name: text:', desc: 'Add a note to a member.' },
            { name: '/note view name:',      desc: 'View all notes for a member, with IDs and timestamps.' },
            { name: '/note delete id:',      desc: 'Delete a specific note by its ID.' },
        ],
    },
    review: {
        description: 'Review members the scanner flagged as new or unrecognized (pending).',
        perm: 'scanUser',
        subcommands: [
            { name: '/review list',                          desc: 'List pending members awaiting review, with power and warband.' },
            { name: '/review approve name:',                 desc: 'Confirm a pending member is real and correctly named.' },
            { name: '/review merge pending_name: into_name:', desc: 'Merge a pending duplicate into an existing member.' },
            { name: '/review remove name:',                  desc: 'Mark a member who left the guild as inactive (drops from /guild views).' },
            { name: '/review return name:',                  desc: 'Reactivate a member previously removed or gone inactive.' },
        ],
    },
    afk: {
        description: 'Mark members as AFK to exempt them from inactivity alerts.',
        subcommands: [
            { name: '/afk set name: reason: return_date:', desc: 'Mark a member AFK. Reason and return date optional. Date format: YYYY-MM-DD.' },
            { name: '/afk clear name:',                    desc: 'Remove AFK status from a member.' },
            { name: '/afk list',                           desc: 'Show all currently AFK members.' },
        ],
    },
    season: {
        description: 'Manage ally seasons and their server lists. Seasons can be prepared before going active.',
        subcommands: [
            { name: '/season add name:',                    desc: 'Create a new season (inactive by default).' },
            { name: '/season activate season:',             desc: 'Mark a season as active.' },
            { name: '/season inactivate season:',           desc: 'Mark a season as inactive.' },
            { name: '/season allyadd season: server:',      desc: 'Add an ally server number to a season.' },
            { name: '/season allyremove season: server:',   desc: 'Remove an ally server number from a season.' },
            { name: '/season allylist season:',             desc: 'List ally servers for a season (omit season for active).' },
        ],
    },
    recruitment: {
        description: 'Track guild recruitment prospects with stats, status, interest level, and auto follow-up reminders.',
        subcommands: [
            { name: '/recruitment add name: power: contacted: server: ...', desc: 'Add a prospect. Status defaults to scouting. Optional: dr/sup_arena/lab/dual ranks, interest, response, status. Schedules a 2-day follow-up reminder.' },
            { name: '/recruitment list',                    desc: 'View prospects (defaults to scouting + invited). Filters: status, interest, server, date ±14 days. Max 20 shown.' },
            { name: '/recruitment update name: ...',        desc: 'Update any field: status (scouting/invited/joined/declined), interest, response, power, server, contacted, ranks.' },
            { name: '/recruitment remove name:',            desc: 'Remove a prospect (also cancels any pending follow-up reminder).' },
        ],
    },
    wishlist: {
        description: 'Guild feature wishlist. Anyone can submit; use Discord permissions to restrict add/remove.',
        subcommands: [
            { name: '/wishlist add item: priority:', desc: 'Submit a new wishlist item with high / medium / low priority.' },
            { name: '/wishlist list',                desc: 'View all wishlist items sorted by priority then date.' },
            { name: '/wishlist remove id:',          desc: 'Remove a wishlist item by its ID.' },
        ],
    },
    newsletter: {
        description: 'Guild newsletter tools. Generate Claude-drafted issues using notes and live DB context.',
        subcommands: [
            { name: '/newsletter note add text: category:',  desc: 'Log a note or event for the next newsletter (category: event / member / season / other).' },
            { name: '/newsletter note list',                  desc: 'Show all notes logged since the last newsletter.' },
            { name: '/newsletter note remove id:',            desc: 'Delete a note by ID.' },
            { name: '/newsletter generate',                   desc: 'Generate a draft newsletter. Returns a .txt file with a material summary (new members, departures, anniversaries, notes) followed by a Claude-written draft. Does not sign off -- Kit edits before posting.' },
            { name: '/newsletter seed',                       desc: 'Import past newsletters from the newsletter channel into the DB. Re-runnable -- safe to run after each new issue is posted.' },
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
            link: 'Link your Discord to your in-game name',
            anniversary: 'list · upcoming',
            remindme: 'Set · list · cancel personal reminders',
            ping: 'Latency check with a quip',
            scan: 'Trigger a guild scan',
            schedule: 'View scheduled system jobs and last/next runs',
            rename: 'Rename a member in the database',
            note: 'Add · view · delete notes on members',
            review: 'list · approve · merge · remove · return',
            afk: 'Set · clear · list AFK status',
            season: 'add · activate · inactivate · allyadd · allyremove · allylist',
            recruitment: 'add · list · update · remove prospects',
            wishlist: 'add · list · remove wishlist items',
            newsletter: 'note add/list/remove · generate · seed',
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
