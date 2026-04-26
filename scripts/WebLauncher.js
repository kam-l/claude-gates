#!/usr/bin/env node
"use strict";
/**
 * Pipeline Web UI — SessionStart launcher.
 *
 * Idempotent: probes /health before spawning. Writes PID file.
 * Always exits 0 (fail-open).
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const http_1 = __importDefault(require("http"));
const path_1 = __importDefault(require("path"));
const SESSIONS_DIR = path_1.default.join(process.cwd(), ".sessions");
const PID_FILE = path_1.default.join(SESSIONS_DIR, ".webui.pid");
const PORT = parseInt(process.env.CLAUDE_GATES_PORT || "64735", 10);
const SCRIPT = path_1.default.join(__dirname, "WebServer.js");
function healthCheck() {
    return new Promise((resolve) => {
        const req = http_1.default.get(`http://127.0.0.1:${PORT}/health`, (res) => {
            let body = "";
            res.on("data", (chunk) => {
                body += chunk;
            });
            res.on("end", () => {
                try {
                    const data = JSON.parse(body);
                    resolve(data.app === "claude-gates");
                }
                catch {
                    resolve(false);
                }
            });
        });
        req.on("error", () => resolve(false));
        req.setTimeout(1000, () => {
            req.destroy();
            resolve(false);
        });
    });
}
function cleanStalePid() {
    try {
        const pid = parseInt(fs_1.default.readFileSync(PID_FILE, "utf-8").trim(), 10);
        if (pid) {
            try {
                process.kill(pid, 0); // test if alive
                return; // process is alive, leave it
            }
            catch {
                // process is dead, remove stale PID file
            }
        }
        fs_1.default.unlinkSync(PID_FILE);
    }
    catch {
        // no PID file
    }
}
async function main() {
    // Already running?
    const alive = await healthCheck();
    if (alive) {
        process.exit(0);
    }
    // Clean stale PID
    cleanStalePid();
    // Ensure sessions dir exists
    fs_1.default.mkdirSync(SESSIONS_DIR, { recursive: true, });
    // Spawn detached server
    const child = (0, child_process_1.spawn)(process.execPath, [SCRIPT,], {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore",
        env: { ...process.env, CLAUDE_GATES_PORT: String(PORT), },
    });
    child.unref();
    if (child.pid) {
        fs_1.default.writeFileSync(PID_FILE, String(child.pid), "utf-8");
    }
    process.exit(0);
}
main().catch(() => process.exit(0));
//# sourceMappingURL=WebLauncher.js.map