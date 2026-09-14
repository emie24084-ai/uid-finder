// server.js
const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const chalk = require("chalk");
const {
    sessions,
    createSession,
    fetchGroups,
    fetchGroupDetails,
    startAutoRefresh,
    stopAutoRefresh,
    stopSession,
    formatDate
} = require("./uid-finder");

const app = express();
const PORT = process.env.PORT || 30119;

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const AUTH = {
    username: process.env.UF_USER || "admin",
    password: process.env.UF_PASS || "admin123"
};

function requireAuth(req, res, next) {
    if (req.cookies.uf_auth === "ok") return next();
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Unauthorized" });
    return res.redirect("/login.html");
}

// ============== AUTH ==============
app.post("/api/login", (req, res) => {
    const { username, password } = req.body;
    if (username === AUTH.username && password === AUTH.password) {
        res.cookie("uf_auth", "ok", { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
        return res.json({ success: true });
    }
    res.json({ success: false, error: "Invalid credentials" });
});

app.get("/api/logout", (req, res) => {
    res.clearCookie("uf_auth");
    res.json({ success: true });
});

// ============== SESSIONS ==============
app.get("/api/sessions", requireAuth, (req, res) => {
    const list = Array.from(sessions.values()).map(s => ({
        sessionId: s.sessionId,
        phoneNumber: s.phoneNumber,
        isConnected: s.isConnected,
        pairingCode: s.pairingCode,
        groupsCount: s.groups.length,
        lastFetched: s.lastFetched,
        lastFetchedFormatted: s.lastFetched ? formatDate(s.lastFetched) : null,
        createdAt: s.createdAt,
        error: s.error,
        autoRefresh: !!s.autoRefreshInterval
    }));
    res.json(list);
});

app.post("/api/sessions/create", requireAuth, async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        if (!phoneNumber) return res.json({ success: false, error: "Phone number required" });
        const clean = phoneNumber.replace(/[^0-9]/g, "");
        if (clean.length < 10) return res.json({ success: false, error: "Invalid phone number" });

        const session = await createSession(clean);
        res.json({
            success: true,
            sessionId: session.sessionId,
            pairingCode: session.pairingCode,
            phoneNumber: session.phoneNumber
        });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// List groups (without members — lightweight)
app.get("/api/sessions/:id", requireAuth, (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.json({ error: "Session not found" });

    res.json({
        sessionId: s.sessionId,
        phoneNumber: s.phoneNumber,
        isConnected: s.isConnected,
        pairingCode: s.pairingCode,
        groups: s.groups.map(g => ({
            index: g.index,
            groupId: g.groupId,
            fullJid: g.fullJid,
            subject: g.subject,
            participantsCount: g.participantsCount,
            creation: g.creation
        })),
        groupsCount: s.groups.length,
        lastFetched: s.lastFetched,
        lastFetchedFormatted: s.lastFetched ? formatDate(s.lastFetched) : null,
        createdAt: s.createdAt,
        error: s.error,
        autoRefresh: !!s.autoRefreshInterval
    });
});

// Group details with full member profiles
app.get("/api/sessions/:id/group/:groupId", requireAuth, async (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.json({ error: "Session not found" });
    if (!s.isConnected) return res.json({ error: "Not connected" });

    const groupJid = decodeURIComponent(req.params.groupId);
    const fullJid = groupJid.includes('@g.us') ? groupJid : (groupJid + '@g.us');

    // Fresh fetch from WhatsApp
    const details = await fetchGroupDetails(s, fullJid);

    if (details) {
        // Update cache
        const idx = s.groups.findIndex(g => g.fullJid === fullJid);
        if (idx >= 0) s.groups[idx] = { ...s.groups[idx], ...details };
        return res.json({ success: true, group: details });
    }

    // Fallback to cache
    const cached = s.groups.find(g => g.fullJid === fullJid);
    if (cached) return res.json({ success: true, group: cached, cached: true });

    res.json({ success: false, error: "Group not found" });
});

app.post("/api/sessions/:id/refresh", requireAuth, async (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.json({ success: false, error: "Session not found" });
    if (!s.isConnected) return res.json({ success: false, error: "Not connected yet" });
    const groups = await fetchGroups(s);
    res.json({ success: true, groupsCount: groups.length });
});

app.post("/api/sessions/:id/auto-refresh", requireAuth, (req, res) => {
    const { enabled, intervalMinutes } = req.body;
    if (enabled) {
        const ok = startAutoRefresh(req.params.id, intervalMinutes || 5);
        return res.json({ success: ok });
    }
    res.json({ success: stopAutoRefresh(req.params.id) });
});

app.post("/api/sessions/:id/stop", requireAuth, (req, res) => {
    const { deleteAuth } = req.body;
    res.json({ success: stopSession(req.params.id, !!deleteAuth) });
});

// ============== DOWNLOADS ==============
app.get("/api/sessions/:id/download.json", requireAuth, (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).send("Not found");
    const output = {
        fetchedFor: s.phoneNumber,
        fetchedAt: s.lastFetched,
        fetchedAtFormatted: s.lastFetched ? formatDate(s.lastFetched) : null,
        totalGroups: s.groups.length,
        groups: s.groups
    };
    res.setHeader("Content-Disposition", `attachment; filename="groups_${s.phoneNumber}.json"`);
    res.setHeader("Content-Type", "application/json");
    res.send(JSON.stringify(output, null, 2));
});

app.get("/api/sessions/:id/download.txt", requireAuth, (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).send("Not found");
    res.setHeader("Content-Disposition", `attachment; filename="group_uids_${s.phoneNumber}.txt"`);
    res.setHeader("Content-Type", "text/plain");
    res.send(s.groups.map(g => `${g.groupId}  |  ${g.subject}`).join("\n"));
});

// CSV — members of a specific group
app.get("/api/sessions/:id/group/:groupId/members.csv", requireAuth, async (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).send("Not found");

    const groupJid = decodeURIComponent(req.params.groupId);
    const fullJid = groupJid.includes('@g.us') ? groupJid : (groupJid + '@g.us');

    let group = s.groups.find(g => g.fullJid === fullJid);
    if (!group) group = await fetchGroupDetails(s, fullJid);
    if (!group) return res.status(404).send("Group not found");

    const rows = [
        ["#", "Phone", "JID", "Role", "Profile Picture"]
    ];
    group.members.forEach((m, i) => {
        const role = m.isSuperAdmin ? "Super Admin" : m.isAdmin ? "Admin" : "Member";
        rows.push([i + 1, m.displayPhone, m.jid, role, m.profilePic || ""]);
    });

    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");

    res.setHeader("Content-Disposition", `attachment; filename="${group.subject}_members.csv"`);
    res.setHeader("Content-Type", "text/csv");
    res.send(csv);
});

// ============== ROUTES ==============
app.get("/", requireAuth, (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/login.html", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));

app.listen(PORT, () => {
    console.log(chalk.cyan("═".repeat(70)));
    console.log(chalk.green("✓"), chalk.greenBright(`Group UID Finder running on port ${PORT}`));
    console.log(chalk.cyan("ℹ"), chalk.white(`Login: ${AUTH.username} / ${AUTH.password}`));
    console.log(chalk.cyan("═".repeat(70)));
});

process.on('uncaughtException', (e) => console.log(chalk.red('✖ UNCAUGHT: ' + e.message)));
process.on('unhandledRejection', (r) => console.log(chalk.red('✖ UNHANDLED: ' + r)));