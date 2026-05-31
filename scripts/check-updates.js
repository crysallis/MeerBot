'use strict';
// Weekly dependency check for MeerBot. READ-ONLY — changes nothing.
// Run:  npm run check-updates
//
// Reports packages with newer versions available and any known security
// advisories. Review the output, then update deliberately:
//   npm update                 → in-range (safe) bumps, refreshes package-lock
//   npm install <pkg>@latest   → a single major bump (read its changelog first)
// After updating: restart the bot (pm2 restart meerbot --update-env) and watch
// `pm2 logs meerbot`. Rebuild native modules after a Node change:
//   npm rebuild better-sqlite3

const { execSync } = require('child_process');

function run(label, cmd) {
    console.log(`\n=== ${label} ===`);
    try {
        execSync(cmd, { stdio: 'inherit' });
    } catch {
        // npm outdated / npm audit exit non-zero when they find things — expected.
    }
}

run('Outdated packages  (Current / Wanted / Latest)', 'npm outdated');
run('Security audit', 'npm audit');

console.log('\nDone (nothing was changed).');
console.log('· Wanted = safe in-range bump · Latest = may be a breaking major.');
console.log('· discord.js 14→15 is a manual migration, not a routine update.');
