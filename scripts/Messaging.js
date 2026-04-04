"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Messaging = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const PREFIX = "[ClaudeGates]";
const NOTIFICATION_FILE = ".pipeline-notifications";
class Messaging {
    static fmt(emoji, text) {
        return `${PREFIX} ${emoji} ${text}`;
    }
    static block(emoji, text) {
        const msg = Messaging.fmt(emoji, text);
        process.stdout.write(JSON.stringify({ decision: "block", reason: msg, }));
    }
    static info(emoji, text) {
        const msg = Messaging.fmt(emoji, text);
        process.stdout.write(JSON.stringify({ systemMessage: msg, }));
    }
    static notify(sessionDir, emoji, text) {
        const msg = Messaging.fmt(emoji, text);
        const filePath = path_1.default.join(sessionDir, NOTIFICATION_FILE);
        try {
            fs_1.default.appendFileSync(filePath, msg + "\n", "utf-8");
        }
        catch {
        }
    }
    static drainNotifications(sessionDir) {
        const filePath = path_1.default.join(sessionDir, NOTIFICATION_FILE);
        try {
            if (!fs_1.default.existsSync(filePath)) {
                return null;
            }
            const content = fs_1.default.readFileSync(filePath, "utf-8").trim();
            fs_1.default.unlinkSync(filePath);
            return content || null;
        }
        catch {
            return null;
        }
    }
    static log(emoji, text) {
        process.stderr.write(Messaging.fmt(emoji, text) + "\n");
    }
    static NOTIFICATION_FILE = NOTIFICATION_FILE;
}
exports.Messaging = Messaging;
//# sourceMappingURL=Messaging.js.map