"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionManager = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
let Database;
try {
    Database = require("better-sqlite3");
}
catch {
    const dataDir = process.env.CLAUDE_PLUGIN_DATA;
    let loadError;
    if (dataDir) {
        try {
            Database = require(path_1.default.join(dataDir, "node_modules", "better-sqlite3"));
        }
        catch (e) {
            loadError = e;
        }
    }
    if (!Database) {
        const pluginDir = __dirname.replace(/[\\/]scripts$/, "");
        const isAbiMismatch = loadError && /NODE_MODULE_VERSION|was compiled against/.test(loadError.message);
        const hint = isAbiMismatch
            ? "ABI mismatch — rebuild with: cd \"" + dataDir + "\" && npm rebuild better-sqlite3"
            : "Run \"npm install\" in the plugin data directory.";
        process.stderr.write(`[ClaudeGates] ❌ better-sqlite3 failed to load. ${hint}\n`
            + `  Plugin path: ${pluginDir}\n`
            + `  Data dir: ${dataDir || "(CLAUDE_PLUGIN_DATA not set)"}\n`
            + (loadError ? `  Error: ${loadError.message}\n` : ""));
        throw new Error("better-sqlite3 not found");
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
    static openDatabase(sessionDir) {
        if (!fs_1.default.existsSync(sessionDir)) {
            fs_1.default.mkdirSync(sessionDir, { recursive: true, });
        }
        const dbPath = path_1.default.join(sessionDir, "session.db");
        const db = new Database(dbPath);
        db.pragma("journal_mode = WAL");
        return db;
    }
}
exports.SessionManager = SessionManager;
//# sourceMappingURL=SessionManager.js.map