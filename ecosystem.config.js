module.exports = {
    apps: [
        {
            name: 'meerbot',
            script: 'index.js',
            cwd: __dirname,
            env_file: '.env',
            watch: false,
            restart_delay: 3000,
        },
        {
            name: 'meerbot-admin',
            script: 'admin/server.js',
            cwd: __dirname,
            env_file: '.env',
            watch: false,
        },
        {
            name: 'meerbot-stats',
            script: 'stats/server.js',
            cwd: __dirname,
            env_file: '.env',
            watch: false,
        },
        // Test bot: separate Discord application + test server, isolated DB
        // (guild.test.db). Bot process only -- admin/stats aren't worth testing
        // in isolation, they don't touch live Discord state if something breaks.
        // Runs from its own git worktree checkout (DiscordBotAfkJ-test) with its
        // own .env (NOT env_file -- PM2's env_file did not reliably inject vars,
        // confirmed via `pm2 env`, see project memory), so index.js's plain
        // `require('dotenv').config()` resolves the test .env automatically by cwd.
        // Not started by default: pm2 start ecosystem.config.js --only meerbot-test
        {
            name: 'meerbot-test',
            script: 'index.js',
            cwd: 'C:\\vscode\\DiscordBotAfkJ-test',
            watch: false,
            restart_delay: 3000,
        },
    ],
};
