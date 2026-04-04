"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FrontmatterParser = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const Enums_1 = require("./types/Enums");
class FrontmatterParser {
    static extractFrontmatter(mdContent) {
        const match = mdContent.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
        return match ? match[1] : null;
    }
    static parseVerification(mdContent) {
        const fm = FrontmatterParser.extractFrontmatter(mdContent);
        if (!fm) {
            return null;
        }
        const blockMatch = fm.match(/^verification:\s*\r?\n((?:\s+-\s*.*\r?\n?)+)/m);
        if (!blockMatch) {
            return null;
        }
        const steps = [];
        for (const line of blockMatch[1].split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("-")) {
                continue;
            }
            const arrMatch = trimmed.match(/^-\s*\[(.+)\]\s*$/);
            if (!arrMatch) {
                continue;
            }
            const inner = arrMatch[1].trim();
            const step = FrontmatterParser.parseStepArray(inner);
            if (step) {
                steps.push(step);
            }
        }
        return steps.length > 0 ? steps : null;
    }
    static parseConditions(mdContent) {
        const fm = FrontmatterParser.extractFrontmatter(mdContent);
        if (!fm) {
            return null;
        }
        const cMatch = fm.match(/^conditions:\s*\|\s*\r?\n((?:[ ]{2,}.*\r?\n?)+)/m);
        if (cMatch) {
            return cMatch[1]
                .split(/\r?\n/)
                .map((line) => line.replace(/^ {2}/, ""))
                .join("\n")
                .trim();
        }
        return null;
    }
    static requiresScope(mdContent) {
        const fm = FrontmatterParser.extractFrontmatter(mdContent);
        if (!fm) {
            return false;
        }
        if (/^verification:\s*\r?\n\s+-/m.test(fm)) {
            return true;
        }
        if (/^conditions\s*:/m.test(fm)) {
            return true;
        }
        return false;
    }
    static findAgentMd(agentType, projectRoot, home) {
        if (projectRoot) {
            const projectPath = path_1.default.join(projectRoot, ".claude", "agents", `${agentType}.md`);
            if (fs_1.default.existsSync(projectPath)) {
                return projectPath;
            }
        }
        if (home) {
            const globalPath = path_1.default.join(home, ".claude", "agents", `${agentType}.md`);
            if (fs_1.default.existsSync(globalPath)) {
                return globalPath;
            }
        }
        return null;
    }
    // ── Private helpers ────────────────────────────────────────────────
    static parseStepArray(inner) {
        const semanticMatch = inner.match(/^["'](.+)["']$/);
        if (semanticMatch) {
            return { type: Enums_1.StepType.Check, prompt: semanticMatch[1], };
        }
        const parts = FrontmatterParser.splitCSV(inner);
        if (parts.length === 0) {
            return null;
        }
        const first = parts[0];
        if (first.startsWith("/")) {
            return { type: Enums_1.StepType.Transform, agent: first.slice(1), maxRounds: 1, };
        }
        const rawAgent = FrontmatterParser.unquote(first);
        if (!rawAgent) {
            return null;
        }
        const isTransform = rawAgent.endsWith("!");
        const agentName = rawAgent.replace(/[!?]$/, "");
        if (!agentName || !/^[A-Za-z0-9_-]+$/.test(agentName)) {
            return null;
        }
        if (isTransform && parts.length <= 2) {
            const maxRounds = parts.length >= 2 ? parseInt(parts[1], 10) : 1;
            return { type: Enums_1.StepType.Transform, agent: agentName, maxRounds: isNaN(maxRounds) ? 1 : maxRounds, };
        }
        const maxRounds = parts.length >= 2 ? parseInt(parts[1], 10) : 3;
        if (isNaN(maxRounds)) {
            return null;
        }
        if (parts.length >= 3) {
            const rawFixer = FrontmatterParser.unquote(parts[2]);
            const fixer = rawFixer ? rawFixer.replace(/[!?]$/, "") : null;
            if (fixer && /^[A-Za-z0-9_-]+$/.test(fixer)) {
                return { type: Enums_1.StepType.VerifyWithFixer, agent: agentName, maxRounds, fixer, };
            }
        }
        return { type: Enums_1.StepType.Verify, agent: agentName, maxRounds, };
    }
    static splitCSV(str) {
        const parts = [];
        let current = "";
        let inQuote = false;
        let quoteChar = "";
        for (let i = 0; i < str.length; i++) {
            const ch = str[i];
            if (inQuote) {
                if (ch === quoteChar) {
                    inQuote = false;
                }
                else {
                    current += ch;
                }
            }
            else if (ch === "\"" || ch === "'") {
                inQuote = true;
                quoteChar = ch;
            }
            else if (ch === ",") {
                parts.push(current.trim());
                current = "";
            }
            else {
                current += ch;
            }
        }
        if (current.trim()) {
            parts.push(current.trim());
        }
        return parts;
    }
    static unquote(s) {
        if (!s) {
            return s;
        }
        const t = s.trim();
        if ((t.startsWith("\"") && t.endsWith("\"")) || (t.startsWith("'") && t.endsWith("'"))) {
            return t.slice(1, -1);
        }
        return t;
    }
}
exports.FrontmatterParser = FrontmatterParser;
//# sourceMappingURL=FrontmatterParser.js.map