"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionManager = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
let Database = null;
let _loadError = null;
try {
    Database = require("better-sqlite3");
}
catch {
    const dataDir = process.env.CLAUDE_PLUGIN_DATA;
    let loadErr;
    if (dataDir) {
        try {
            Database = require(path_1.default.join(dataDir, "node_modules", "better-sqlite3"));
        }
        catch (e) {
            loadErr = e;
        }
    }
    if (!Database) {
        const pluginDir = __dirname.replace(/[\\/]scripts$/, "");
        const isAbiMismatch = loadErr && /NODE_MODULE_VERSION|was compiled against/.test(loadErr.message);
        const hint = isAbiMismatch
            ? "ABI mismatch — rebuild with: cd \"" + dataDir + "\" && npm rebuild better-sqlite3"
            : "Run \"npm install\" in the plugin data directory.";
        _loadError = `[ClaudeGates] ❌ better-sqlite3 failed to load. ${hint}\n`
            + `  Plugin path: ${pluginDir}\n`
            + `  Data dir: ${dataDir || "(CLAUDE_PLUGIN_DATA not set)"}\n`
            + (loadErr ? `  Error: ${loadErr.message}\n` : "");
    }
}
class SessionManager {
    static getSessionDir(sessionId) {
        const shortId = sessionId.replace(/-/g, "").slice(0, 8);
        return path_1.default.join(process.cwd(), ".sessions", shortId).replace(/\\/g, "/");
    }
    static agentRunningMarker(sessionDir, scope) {
        return path_1.default.join(sessionDir, `.running-${scope}`).replace(/\\/g, "/");
    }
    static gateDisabledMarker() {
        return path_1.default.join(process.cwd(), ".sessions", ".gate-disabled").replace(/\\/g, "/");
    }
    static isGateDisabled() {
        try {
            return fs_1.default.existsSync(SessionManager.gateDisabledMarker());
        }
        catch {
            return false;
        }
    }
    static setGateDisabled(disabled) {
        const marker = SessionManager.gateDisabledMarker();
        if (disabled) {
            fs_1.default.mkdirSync(path_1.default.dirname(marker), { recursive: true, });
            fs_1.default.writeFileSync(marker, "", "utf-8");
        }
        else {
            try {
                fs_1.default.unlinkSync(marker);
            }
            catch {
            }
        }
    }
    static openDatabase(sessionDir) {
        if (!Database) {
            if (_loadError) {
                process.stderr.write(_loadError);
            }
            throw new Error("better-sqlite3 not available");
        }
        if (!fs_1.default.existsSync(sessionDir)) {
            fs_1.default.mkdirSync(sessionDir, { recursive: true, });
        }
        const dbPath = path_1.default.join(sessionDir, "session.db");
        const db = new Database(dbPath);
        db.pragma("journal_mode = WAL");
        db.pragma("busy_timeout = 5000");
        return db;
    }
}
exports.SessionManager = SessionManager;
//# sourceMappingURL=SessionManager.js.map