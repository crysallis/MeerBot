module.exports = {

    // Global sliding-window rate limit applied to all slash commands
    rateLimit: {
        windowMs:    60_000, // duration of the window
        maxCommands: 20,     // max commands allowed within the window
    },

    // Scheduled auto-messages
    scheduledMessages: {
        lateWarningMinutes: 30,  // add a late footer after this many minutes past scheduled time
        // per-message maxLateMinutes is set on each message entry in utils/scheduledMessages.js
    },

    // /ping latency tier breakpoints (upper bound, exclusive)
    ping: {
        tiers: {
            godlike: 50,   // < 50 ms
            great:   150,  // < 150 ms
            good:    300,  // < 300 ms
            meh:     500,  // < 500 ms
            bad:     800,  // < 800 ms
            // >= 800 ms → terrible
        },
    },

};
