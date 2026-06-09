require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits } = require('discord.js');

const GUILD_ID = process.env.GUILD_ID;
const TOKEN = process.env.DISCORD_TOKEN;

const SKIP_ROLES = new Set(['Dyno', 'Meerbot', 'Interaction Bot', 'IFTTT', 'Server Booster', '@everyone']);

// Human-readable permission label groups for compact display
const PERM_GROUPS = {
    ViewChannel: 'View',
    SendMessages: 'Send',
    ReadMessageHistory: 'History',
    AddReactions: 'React',
    AttachFiles: 'Attach',
    EmbedLinks: 'Embed',
    UseExternalEmojis: 'ExtEmoji',
    UseExternalStickers: 'ExtSticker',
    CreatePublicThreads: 'PubThread',
    CreatePrivateThreads: 'PrivThread',
    SendMessagesInThreads: 'ThreadMsg',
    ManageMessages: 'ManageMsg',
    ManageThreads: 'ManageThread',
    PinMessages: 'Pin',
    MentionEveryone: 'MentionAll',
    UseApplicationCommands: 'SlashCmds',
    RequestToSpeak: 'ReqSpeak',
    SendPolls: 'Polls',
    MuteMembers: 'Mute',
    DeafenMembers: 'Deafen',
    MoveMembers: 'Move',
    ManageEvents: 'ManageEvents',
    CreateEvents: 'CreateEvents',
    ManageChannels: 'ManageCh',
    ManageRoles: 'ManageRoles',
    Stream: 'Stream',
    Connect: 'Connect',
    Speak: 'Speak',
    UseVAD: 'VAD',
    PrioritySpeaker: 'PrioritySpeak',
    UseEmbeddedActivities: 'Activities',
    UseSoundboard: 'Soundboard',
    UseExternalSounds: 'ExtSounds',
    SendVoiceMessages: 'VoiceMsg',
    BypassSlowmode: 'BypassSlow',
    CreateInstantInvite: 'Invite',
};

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async () => {
    const guild = await client.guilds.fetch(GUILD_ID);
    const channels = await guild.channels.fetch();
    const roles = await guild.roles.fetch();

    const roleMap = new Map(roles.map(r => [r.id, r.name]));
    const everyoneId = guild.id;

    function viewableRoles(overwrites) {
        const everyoneOw = overwrites.get(everyoneId);
        const everyoneAllows = everyoneOw?.allow.has(PermissionFlagsBits.ViewChannel) ?? false;
        const everyoneDenies = everyoneOw?.deny.has(PermissionFlagsBits.ViewChannel) ?? false;
        if (everyoneAllows) return ['everyone'];
        const allowed = [];
        for (const [id, ow] of overwrites) {
            if (id === everyoneId) continue;
            if (ow.type !== 0) continue;
            const name = roleMap.get(id);
            if (!name || SKIP_ROLES.has(name)) continue;
            if (ow.allow.has(PermissionFlagsBits.ViewChannel)) allowed.push(name);
        }
        if (!everyoneDenies && allowed.length === 0) return ['everyone (no restriction)'];
        return allowed.length ? allowed : ['(none)'];
    }

    function rolePermDetails(overwrites) {
        const everyoneOw = overwrites.get(everyoneId);
        const results = [];

        // @everyone baseline
        if (everyoneOw) {
            const allows = everyoneOw.allow.toArray().map(p => PERM_GROUPS[p] ?? p).filter(Boolean);
            const denies = everyoneOw.deny.toArray().map(p => PERM_GROUPS[p] ?? p).filter(Boolean);
            results.push({ role: '@everyone', allows, denies });
        }

        for (const [id, ow] of overwrites) {
            if (id === everyoneId) continue;
            if (ow.type !== 0) continue;
            const name = roleMap.get(id);
            if (!name || SKIP_ROLES.has(name)) continue;
            const allows = ow.allow.toArray().map(p => PERM_GROUPS[p] ?? p).filter(Boolean);
            const denies = ow.deny.toArray().map(p => PERM_GROUPS[p] ?? p).filter(Boolean);
            results.push({ role: name, allows, denies });
        }
        return results;
    }

    const categories = new Map();
    const childChannels = [];
    for (const [, ch] of channels) {
        if (!ch) continue;
        if (ch.type === ChannelType.GuildCategory) {
            categories.set(ch.id, { ch, children: [] });
        } else {
            childChannels.push(ch);
        }
    }
    for (const ch of childChannels) {
        if (ch.parentId && categories.has(ch.parentId)) {
            categories.get(ch.parentId).children.push(ch);
        }
    }
    const sortedCats = [...categories.values()].sort((a, b) => a.ch.position - b.ch.position);

    // ── Markdown output ─────────────────────────────────────────────────────
    const lines = [];
    lines.push('# Discord Permission Map');
    lines.push(`_Generated ${new Date().toISOString()}_\n`);

    for (const { ch: cat, children } of sortedCats) {
        const catRoles = viewableRoles(cat.permissionOverwrites.cache);
        lines.push(`## ${cat.name}`);
        lines.push(`**Access:** ${catRoles.join(', ')}\n`);

        // Per-role permission details at category level
        const details = rolePermDetails(cat.permissionOverwrites.cache);
        if (details.length) {
            lines.push('**Role permissions:**');
            lines.push('| Role | Allow | Deny |');
            lines.push('|---|---|---|');
            for (const { role, allows, denies } of details) {
                lines.push(`| ${role} | ${allows.join(', ') || '--'} | ${denies.join(', ') || '--'} |`);
            }
            lines.push('');
        }

        if (children.length) {
            lines.push('**Channels:**');
            lines.push('| Channel | Synced | Access | Custom perms |');
            lines.push('|---|---|---|---|');
            for (const ch of children.sort((a, b) => a.position - b.position)) {
                const synced = ch.permissionsLocked ?? false;
                const chRoles = synced ? catRoles : viewableRoles(ch.permissionOverwrites.cache);
                const chDetails = !synced ? rolePermDetails(ch.permissionOverwrites.cache)
                    .filter(d => d.role !== '@everyone')
                    .map(d => `${d.role}: +[${d.allows.join(' ')}] -[${d.denies.join(' ')}]`)
                    .join('; ') : '';
                lines.push(`| ${ch.name} | ${synced ? 'yes' : 'no'} | ${chRoles.join(', ')} | ${chDetails || '--'} |`);
            }
        }
        lines.push('');
    }

    // Role summary
    lines.push('---\n# Role Access Summary\n');
    lines.push('| Role | Categories |');
    lines.push('|---|---|');
    const roleToCats = new Map();
    for (const { ch: cat } of sortedCats) {
        for (const r of viewableRoles(cat.permissionOverwrites.cache)) {
            if (r.startsWith('everyone')) continue;
            if (!roleToCats.has(r)) roleToCats.set(r, []);
            roleToCats.get(r).push(cat.name);
        }
    }
    const roleOrder = roles.filter(r => !SKIP_ROLES.has(r.name) && !r.managed)
        .sort((a, b) => b.position - a.position).map(r => r.name);
    for (const name of roleOrder) {
        const cats = roleToCats.get(name) ?? [];
        if (!cats.length) continue;
        lines.push(`| ${name} | ${cats.join(' · ')} |`);
    }

    const mdOut = lines.join('\n');
    const mdPath = path.join(__dirname, '..', 'data', 'permission-map.md');
    fs.writeFileSync(mdPath, mdOut);
    console.log(`Wrote ${mdPath}`);

    // ── Mermaid diagram ──────────────────────────────────────────────────────
    const mermaid = [];
    mermaid.push('flowchart LR');

    const sanitise = s => s.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'role';

    // Category nodes -- use stable positional IDs (C0, C1...) to avoid emoji stripping issues
    const catAccess = new Map();
    sortedCats.forEach(({ ch: cat }, i) => {
        const cid = `C${i}`;
        const viewers = viewableRoles(cat.permissionOverwrites.cache);
        catAccess.set(cat.id, { cid, name: cat.name, viewers });

        if (viewers[0] === '(none)') {
            mermaid.push(`  ${cid}["${cat.name}"]:::archived`);
        } else if (viewers[0]?.startsWith('everyone')) {
            mermaid.push(`  ${cid}["${cat.name}"]:::public`);
        } else {
            mermaid.push(`  ${cid}["${cat.name}"]:::restricted`);
        }
    });

    mermaid.push('');

    // Role nodes + edges
    const drawnRoles = new Set();
    for (const { ch: cat } of sortedCats) {
        const { cid, viewers } = catAccess.get(cat.id);
        if (viewers[0]?.startsWith('everyone') || viewers[0] === '(none)') continue;
        for (const roleName of viewers) {
            const rid = sanitise(roleName);
            if (!drawnRoles.has(rid)) {
                // Classify role tier
                const isLeader = ['Riff','Raff','Queen of the Frogs','Penguin Admiral',
                    'Kingdom Emperor','Sobaquitos Leader','Kingdom-Emperor',
                    'Penguin-Admiral','Sobaquitos-Leader'].includes(roleName);
                const tier = isLeader ? ':::leader' : ':::member';
                mermaid.push(`  ${rid}(["👤 ${roleName}"])${tier}`);
                drawnRoles.add(rid);
            }
            mermaid.push(`  ${rid} --> ${cid}`);
        }
    }

    mermaid.push('');
    mermaid.push('  classDef public fill:#2d6a2d,color:#fff,stroke:#1a3d1a');
    mermaid.push('  classDef restricted fill:#1a3a5c,color:#fff,stroke:#0d1f33');
    mermaid.push('  classDef archived fill:#444,color:#aaa,stroke:#222');
    mermaid.push('  classDef member fill:#1a4a7a,color:#fff,stroke:#0d2640');
    mermaid.push('  classDef leader fill:#7a3a1a,color:#fff,stroke:#3d1d0d');

    const mermaidOut = mermaid.join('\n');
    const mermaidPath = path.join(__dirname, '..', 'data', 'permission-map.mermaid');
    fs.writeFileSync(mermaidPath, mermaidOut);
    console.log(`Wrote ${mermaidPath}`);
    console.log('\n--- MERMAID ---\n' + mermaidOut);

    client.destroy();
    process.exit(0);
});

client.login(TOKEN);
