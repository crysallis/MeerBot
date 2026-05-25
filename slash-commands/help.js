const { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');

const ADMIN_COMMANDS = new Set(['rename', 'note', 'afk']);
const SCAN_AUTHORIZED = process.env.SCAN_AUTHORIZED_USER;

const COMMANDS = {
    birthday: {
        description: 'Register and celebrate guild member birthdays.',
        subcommands: [
            { name: '/birthday register month: day: year:', desc: 'Register your birthday. Year is optional. Day is validated against the month.' },
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
            { name: '/link ingame_name:',       desc: 'Link yourself. Name autocompletes from latest snapshot.' },
            { name: '/link ingame_name: user:', desc: '(Admin) Link a different Discord user.' },
        ],
    },
    scan: {
        description: 'Trigger a live guild member scan. Requires BlueStacks and the game to be open.',
        subcommands: [
            { name: '/scan', desc: 'Navigates to the guild member list, scrapes all data, and saves a snapshot. Authorized user only.' },
        ],
    },
    rename: {
        description: 'Rename a guild member in the database (admin only).',
        subcommands: [
            { name: '/rename old_name: new_name:', desc: 'Updates the member record, logs the change to history, and adds a name correction so future scans map correctly.' },
        ],
    },
    note: {
        description: 'Guild leader notes on members (admin only).',
        subcommands: [
            { name: '/note add name: text:', desc: 'Add a note to a member. Only visible to admins.' },
            { name: '/note view name:',      desc: 'View all notes for a member, with IDs and timestamps.' },
            { name: '/note delete id:',      desc: 'Delete a specific note by its ID.' },
        ],
    },
    afk: {
        description: 'Mark members as AFK to exempt them from inactivity alerts (admin only).',
        subcommands: [
            { name: '/afk set name: reason: return_date:', desc: 'Mark a member AFK. Reason and return date optional. Date format: YYYY-MM-DD.' },
            { name: '/afk clear name:',                    desc: 'Remove AFK status from a member.' },
            { name: '/afk list',                           desc: 'Show all currently AFK members.' },
        ],
    },
};

function isAdmin(interaction) {
    return interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

function visibleCommands(interaction) {
    const admin = isAdmin(interaction);
    const isScanUser = interaction.user.id === SCAN_AUTHORIZED;
    return Object.keys(COMMANDS).filter(k => {
        if (ADMIN_COMMANDS.has(k)) return admin;
        if (k === 'scan') return isScanUser || admin;
        return true;
    });
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
        const admin = isAdmin(interaction);
        const isScanUser = interaction.user.id === SCAN_AUTHORIZED;

        if (cmd) {
            if (ADMIN_COMMANDS.has(cmd) && !admin) {
                return interaction.reply({ content: `You don't have access to \`/${cmd}\`.`, flags: MessageFlags.Ephemeral });
            }
            if (cmd === 'scan' && !isScanUser && !admin) {
                return interaction.reply({ content: `You don't have access to \`/scan\`.`, flags: MessageFlags.Ephemeral });
            }
            const info = COMMANDS[cmd];
            if (!info) {
                return interaction.reply({ content: `Unknown command \`/${cmd}\`.`, flags: MessageFlags.Ephemeral });
            }
            const embed = new EmbedBuilder()
                .setTitle(`📖 /${cmd}`)
                .setColor(0x9b59b6)
                .setDescription(info.description)
                .addFields(info.subcommands.map(s => ({ name: s.name, value: s.desc })));
            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        const fields = [
            { name: '/birthday', value: 'Register · list · remove birthdays' },
            { name: '/guild',    value: 'power · top · inactive · activeness · growth · nogrowth · status · newcomers' },
            { name: '/member',   value: 'Look up a member by name or @mention' },
            { name: '/link',     value: 'Link your Discord to your in-game name' },
        ];

        if (isScanUser || admin) {
            fields.push({ name: '/scan', value: 'Trigger a guild scan (authorized user only)' });
        }
        if (admin) {
            fields.push(
                { name: '/rename', value: 'Rename a member in the database' },
                { name: '/note',   value: 'Add · view · delete notes on members' },
                { name: '/afk',    value: 'Set · clear · list AFK status' },
            );
        }

        fields.push({ name: '/help', value: 'You\'re looking at it. Add `command:name` for details.' });

        const embed = new EmbedBuilder()
            .setTitle('📖 Meerbot Commands')
            .setColor(0x9b59b6)
            .setDescription('Use `/help command:name` for details and subcommands.')
            .addFields(fields);

        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
};
