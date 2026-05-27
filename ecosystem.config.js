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
    ],
};
