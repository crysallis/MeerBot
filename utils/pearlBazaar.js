function buildPearlBazaarRows(dbRows, nameByIngameId, priceFloor = 0) {
    return dbRows
        .filter(row => row.selling_cap_remaining !== 0 && row.price >= priceFloor)
        .map(row => ({
            rank: row.rank,
            label: nameByIngameId.get(row.ingame_id) || String(row.ingame_id),
            price: row.price,
            sellingCapRemaining: row.selling_cap_remaining,
        }))
        .sort((a, b) => a.rank - b.rank);
}

module.exports = { buildPearlBazaarRows };
