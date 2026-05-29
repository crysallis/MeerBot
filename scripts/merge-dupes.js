'use strict';
// One-shot cleanup: collapse OCR phantom duplicate members into one canonical row.
// Each group lists the correct canonical name plus the OCR variant names that are the
// same person. Existing variant rows are merged onto a single keeper (renamed to the
// canonical spelling), their data repointed, and an alias saved for future scans.
// Safe to re-run: variants already merged/absent are skipped.

const db = require('../utils/db');
const { mergeMembers } = db;

const GROUPS = [
    { canonical: 'Matikhv',       names: ['Matikhv', 'Matikny'] },
    { canonical: "XIII'th",       names: ["XIII'th", 'U y'] },
    { canonical: 'Mullikai 「ψ」', names: ['Mullikai 「」', 'Mullikai「』'] },
];

const byName = db.prepare('SELECT id, ingame_name, discord_id FROM members WHERE ingame_name = ?');
const aliasStmt = db.prepare("INSERT OR REPLACE INTO name_corrections (ocr_name, correct_name, source) VALUES (?, ?, 'merge')");

let mergeCount = 0, renameCount = 0;
for (const { canonical, names } of GROUPS) {
    const rows = names.map(n => byName.get(n)).filter(Boolean);
    if (rows.length === 0) { console.log(`· skip (none found): ${canonical}`); continue; }

    // Keeper: prefer the row already named canonically, else a linked row, else the first.
    let keeper = rows.find(r => r.ingame_name === canonical)
              || rows.find(r => r.discord_id)
              || rows[0];

    // Rename keeper to the correct canonical spelling if needed.
    if (keeper.ingame_name !== canonical) {
        const old = keeper.ingame_name;
        db.prepare('UPDATE members SET ingame_name = ?, pending = 0 WHERE id = ?').run(canonical, keeper.id);
        db.prepare('INSERT INTO member_name_history (member_id, old_name, new_name, changed_at) VALUES (?, ?, ?, ?)')
            .run(keeper.id, old, canonical, new Date().toISOString());
        aliasStmt.run(old.toLowerCase(), canonical);
        keeper.ingame_name = canonical;
        console.log(`✎ renamed '${old}' -> '${canonical}' (member #${keeper.id})`);
        renameCount++;
    }

    // Merge every other existing row into the keeper.
    for (const r of rows) {
        if (r.id === keeper.id) continue;
        mergeMembers(keeper.id, r.id);
        console.log(`✓ merged '${r.ingame_name}' -> '${canonical}' (member #${keeper.id})`);
        mergeCount++;
    }
    db.prepare('UPDATE members SET pending = 0 WHERE id = ?').run(keeper.id);
}

const total = db.prepare('SELECT COUNT(*) AS n FROM members').get().n;
console.log(`\nDone. ${renameCount} rename(s), ${mergeCount} merge(s). members table now has ${total} rows.`);
