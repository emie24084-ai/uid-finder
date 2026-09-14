// uid-finder.js - Core Baileys logic (same setup as index.js)
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const chalk = require("chalk");
const {
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    fetchLatestBaileysVersion,
    makeWASocket,
    isJidBroadcast
} = require("@whiskeysockets/baileys");

const CYAN_SEPARATOR = chalk.cyan('═'.repeat(70));

function logInfo(m)    { console.log(CYAN_SEPARATOR); console.log(chalk.cyan('ℹ'), chalk.white(m)); console.log(CYAN_SEPARATOR); }
function logSuccess(m) { console.log(CYAN_SEPARATOR); console.log(chalk.green('✓'), chalk.greenBright(m)); console.log(CYAN_SEPARATOR); }
function logError(m)   { console.log(CYAN_SEPARATOR); console.log(chalk.red('✖'), chalk.redBright(m)); console.log(CYAN_SEPARATOR); }
function logWarning(m) { console.log(CYAN_SEPARATOR); console.log(chalk.yellow('⚠'), chalk.yellowBright(m)); console.log(CYAN_SEPARATOR); }

function formatDate(dateInput) {
    const date = new Date(dateInput);
    const day = date.getDate();
    const monthNames = ["January","February","March","April","May","June",
        "July","August","September","October","November","December"];
    return `${day} ${monthNames[date.getMonth()]} ${date.getFullYear()}`;
}

class UidFinderSession {
    constructor(sessionId, phoneNumber) {
        this.sessionId = sessionId;
        this.phoneNumber = phoneNumber;
        this.authPath = path.join("temp", sessionId);
        this.client = null;
        this.isConnected = false;
        this.pairingCode = null;
        this.groups = [];        // full groups with members
        this.lastFetched = null;
        this.createdAt = new Date().toISOString();
        this.error = null;
        this.autoRefreshInterval = null;
        this.stopped = false;
    }
}

const sessions = new Map();

// ================= PHONE NUMBER RESOLVER =================
// Converts a JID (e.g. 923001234567@s.whatsapp.net) to clean phone number
function jidToPhone(jid) {
    if (!jid) return null;
    const user = jid.split('@')[0].split(':')[0];
    if (/^\d+$/.test(user)) return user;
    return null;
}

// ================= CREATE SESSION =================
async function createSession(phoneNumber, sessionId = null) {
    const id = sessionId || ('uid_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10));

    if (!fs.existsSync("temp")) fs.mkdirSync("temp", { recursive: true });

    const session = new UidFinderSession(id, phoneNumber);
    if (!fs.existsSync(session.authPath)) fs.mkdirSync(session.authPath, { recursive: true });

    sessions.set(id, session);
    logInfo(`Starting UID Finder session: ${id} for ${phoneNumber}`);

    const { state, saveCreds } = await useMultiFileAuthState(session.authPath);
    const { version } = await fetchLatestBaileysVersion();

    const waClient = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
        },
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        generateHighQualityLinkPreview: true,
        shouldIgnoreJid: jid => isJidBroadcast(jid),
        getMessage: async key => { return {} },
        markOnlineOnConnect: false,
        retryRequestDelayMs: 3000,
        maxRetries: 1000000000,
        connectTimeoutMs: 60000
    });

    session.client = waClient;
    waClient.ev.on("creds.update", saveCreds);

    if (!waClient.authState.creds.registered) {
        await delay(1500);
        try {
            const cleanNumber = phoneNumber.replace(/[^0-9]/g, "");
            const code = await waClient.requestPairingCode(cleanNumber);
            session.pairingCode = code;
            logSuccess(`PAIRING CODE for ${cleanNumber}: ${code}`);
        } catch (err) {
            session.error = "Failed to request pairing code: " + err.message;
            logError(session.error);
        }
    }

    waClient.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "open") {
            session.isConnected = true;
            session.error = null;
            logSuccess(`✅ Connected: ${phoneNumber} (${id})`);
            await delay(3000);
            await fetchGroups(session);
        }
        else if (connection === "close") {
            session.isConnected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            logWarning(`Session ${id} closed. Status: ${statusCode}`);
            if (statusCode === 401) {
                session.error = "Logged out from WhatsApp.";
                return;
            }
            if (!session.stopped) {
                await delay(5000);
                try { await reconnectSession(id); } catch (e) {}
            }
        }
        else if (connection === "connecting") {
            logInfo(`Session ${id} connecting...`);
        }
    });

    return session;
}

async function reconnectSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session || session.stopped) return;

    try { if (session.client) session.client.end(); } catch (e) {}

    const { state, saveCreds } = await useMultiFileAuthState(session.authPath);
    const { version } = await fetchLatestBaileysVersion();

    const waClient = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
        },
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        generateHighQualityLinkPreview: true,
        shouldIgnoreJid: jid => isJidBroadcast(jid),
        getMessage: async key => { return {} },
        markOnlineOnConnect: false,
        retryRequestDelayMs: 3000,
        maxRetries: 1000000000,
        connectTimeoutMs: 60000
    });

    session.client = waClient;
    waClient.ev.on("creds.update", saveCreds);

    waClient.ev.on("connection.update", async (update) => {
        const { connection } = update;
        if (connection === "open") {
            session.isConnected = true;
            logSuccess(`✅ Reconnected: ${session.phoneNumber}`);
            await delay(2000);
            await fetchGroups(session);
        } else if (connection === "close") {
            session.isConnected = false;
            if (!session.stopped) {
                await delay(5000);
                reconnectSession(sessionId);
            }
        }
    });
}

// ================= FETCH GROUPS WITH FULL MEMBER PROFILES =================
async function fetchGroups(session) {
    if (!session.client || !session.isConnected) return [];

    try {
        logInfo(`Fetching groups for ${session.phoneNumber}...`);

        // 1. Fetch all groups
        const groups = await session.client.groupFetchAllParticipating();

        // 2. Collect all participant JIDs for bulk profile lookup
        const allJids = new Set();
        Object.values(groups).forEach(g => {
            (g.participants || []).forEach(p => allJids.add(p.id));
        });

        // 3. Bulk-fetch profile pictures (best-effort; errors ignored per-jid)
        const profilePicMap = new Map();
        await Promise.all(
            Array.from(allJids).map(async (jid) => {
                try {
                    const url = await session.client.profilePictureUrl(jid, 'image');
                    if (url) profilePicMap.set(jid, url);
                } catch (e) {
                    // ignore — user may not have a public pic
                }
            })
        );

        // 4. Build full group list with members
        const groupsList = Object.keys(groups).map((groupId, index) => {
            const group = groups[groupId];
            const participants = group.participants || [];

            const members = participants.map(p => {
                const phone = jidToPhone(p.id);
                const isLid = !phone;   // LID-based (new WhatsApp privacy format)
                return {
                    jid: p.id,
                    phone: phone,
                    displayPhone: phone ? ('+' + phone) : 'Hidden (LID)',
                    isLid: isLid,
                    admin: p.admin || null,        // 'superadmin' | 'admin' | null
                    isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
                    isSuperAdmin: p.admin === 'superadmin',
                    profilePic: profilePicMap.get(p.id) || null
                };
            });

            // Sort: superadmins first, then admins, then members
            members.sort((a, b) => {
                const rank = m => m.isSuperAdmin ? 0 : m.isAdmin ? 1 : 2;
                return rank(a) - rank(b);
            });

            return {
                index: index + 1,
                groupId: groupId.replace('@g.us', ''),
                fullJid: groupId,
                subject: group.subject || 'Unnamed Group',
                participantsCount: participants.length,
                creation: group.creation ? formatDate(group.creation * 1000) : null,
                owner: group.owner ? jidToPhone(group.owner) : null,
                desc: group.desc || null,
                members: members
            };
        });

        // Sort groups alphabetically
        groupsList.sort((a, b) => a.subject.localeCompare(b.subject));
        groupsList.forEach((g, i) => g.index = i + 1);

        session.groups = groupsList;
        session.lastFetched = new Date().toISOString();
        logSuccess(`Fetched ${groupsList.length} groups (${allJids.size} unique members)`);
        return groupsList;

    } catch (error) {
        session.error = "Error fetching groups: " + error.message;
        logError(session.error);
        return [];
    }
}

// ================= FETCH SINGLE GROUP DETAILS (fresh) =================
async function fetchGroupDetails(session, groupJid) {
    if (!session.client || !session.isConnected) return null;

    try {
        const metadata = await session.client.groupMetadata(groupJid);
        const participants = metadata.participants || [];

        const profilePicMap = new Map();
        await Promise.all(
            participants.map(async (p) => {
                try {
                    const url = await session.client.profilePictureUrl(p.id, 'image');
                    if (url) profilePicMap.set(p.id, url);
                } catch (e) {}
            })
        );

        const members = participants.map(p => {
            const phone = jidToPhone(p.id);
            return {
                jid: p.id,
                phone: phone,
                displayPhone: phone ? ('+' + phone) : 'Hidden (LID)',
                isLid: !phone,
                admin: p.admin || null,
                isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
                isSuperAdmin: p.admin === 'superadmin',
                profilePic: profilePicMap.get(p.id) || null
            };
        });

        members.sort((a, b) => {
            const rank = m => m.isSuperAdmin ? 0 : m.isAdmin ? 1 : 2;
            return rank(a) - rank(b);
        });

        return {
            groupId: groupJid.replace('@g.us', ''),
            fullJid: groupJid,
            subject: metadata.subject || 'Unnamed Group',
            participantsCount: participants.length,
            creation: metadata.creation ? formatDate(metadata.creation * 1000) : null,
            owner: metadata.owner ? jidToPhone(metadata.owner) : null,
            desc: metadata.desc || null,
            members: members
        };

    } catch (error) {
        logError(`Failed to fetch details for ${groupJid}: ${error.message}`);
        return null;
    }
}

// ================= AUTO REFRESH =================
function startAutoRefresh(sessionId, intervalMinutes = 5) {
    const session = sessions.get(sessionId);
    if (!session) return false;
    stopAutoRefresh(sessionId);
    session.autoRefreshInterval = setInterval(async () => {
        if (session.isConnected && !session.stopped) await fetchGroups(session);
    }, intervalMinutes * 60 * 1000);
    logSuccess(`Auto-refresh started for ${sessionId} (${intervalMinutes} min)`);
    return true;
}

function stopAutoRefresh(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return false;
    if (session.autoRefreshInterval) {
        clearInterval(session.autoRefreshInterval);
        session.autoRefreshInterval = null;
    }
    return true;
}

// ================= STOP SESSION =================
function stopSession(sessionId, deleteAuth = false) {
    const session = sessions.get(sessionId);
    if (!session) return false;
    session.stopped = true;
    stopAutoRefresh(sessionId);
    try { if (session.client) session.client.end(); } catch (e) {}
    if (deleteAuth && fs.existsSync(session.authPath)) {
        try { fs.rmSync(session.authPath, { recursive: true, force: true }); } catch (e) {}
    }
    sessions.delete(sessionId);
    logSuccess(`Session stopped: ${sessionId}`);
    return true;
}

// ================= EXPORTS =================
module.exports = {
    sessions,
    createSession,
    reconnectSession,
    fetchGroups,
    fetchGroupDetails,
    startAutoRefresh,
    stopAutoRefresh,
    stopSession,
    formatDate
};