import fs from "fs";
import path from "path";
import { StepType, } from "./types/Enums";
import type { VerificationStep, } from "./types/Interfaces";

export class FrontmatterParser
{
  public static extractFrontmatter(mdContent: string,): string | null
  {
    const match = mdContent.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/,);
    return match ? match[1] : null;
  }

  public static parseVerification(mdContent: string,): VerificationStep[] | null
  {
    const fm = FrontmatterParser.extractFrontmatter(mdContent,);
    if (!fm)
    {
      return null;
    }

    const blockMatch = fm.match(/^verification:\s*\r?\n((?:\s+-\s*.*\r?\n?)+)/m,);
    if (!blockMatch)
    {
      return null;
    }

    const steps: VerificationStep[] = [];
    for (const line of blockMatch[1].split(/\r?\n/,))
    {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("-",))
      {
        continue;
      }

      const arrMatch = trimmed.match(/^-\s*\[(.+)\]\s*$/,);
      if (!arrMatch)
      {
        continue;
      }

      const inner = arrMatch[1].trim();
      const step = FrontmatterParser.parseStepArray(inner,);
      if (step)
      {
        steps.push(step,);
      }
    }

    return steps.length > 0 ? steps : null;
  }

  public static parseConditions(mdContent: string,): string | null
  {
    const fm = FrontmatterParser.extractFrontmatter(mdContent,);
    if (!fm)
    {
      return null;
    }
    const cMatch = fm.match(/^conditions:\s*\|\s*\r?\n((?:[ ]{2,}.*\r?\n?)+)/m,);
    if (cMatch)
    {
      return cMatch[1]
        .split(/\r?\n/,)
        .map((line: string,) => line.replace(/^ {2}/, "",))
        .join("\n",)
        .trim();
    }
    return null;
  }

  public static requiresScope(mdContent: string,): boolean
  {
    const fm = FrontmatterParser.extractFrontmatter(mdContent,);
    if (!fm)
    {
      return false;
    }
    if (/^verification:\s*\r?\n\s+-/m.test(fm,))
    {
      return true;
    }
    if (/^conditions\s*:/m.test(fm,))
    {
      return true;
    }
    return false;
  }

  public static findAgentMd(agentType: string, projectRoot: string | null, home: string | null,): string | null
  {
    if (projectRoot)
    {
      const projectPath = path.join(projectRoot, ".claude", "agents", `${agentType}.md`,);
      if (fs.existsSync(projectPath,))
      {
        return projectPath;
      }
    }
    if (home)
    {
      const globalPath = path.join(home, ".claude", "agents", `${agentType}.md`,);
      if (fs.existsSync(globalPath,))
      {
        return globalPath;
      }
    }
    return null;
  }

  // ── Private helpers ────────────────────────────────────────────────

  private static parseStepArray(inner: string,): VerificationStep | null
  {
    const semanticMatch = inner.match(/^["'](.+)["']$/,);
    if (semanticMatch)
    {
      return { type: StepType.Check, prompt: semanticMatch[1], };
    }

    const parts = FrontmatterParser.splitCSV(inner,);
    if (parts.length === 0)
    {
      return null;
    }

    const first = parts[0];

    if (first.startsWith("/",))
    {
      return { type: StepType.Transform, agent: first.slice(1,), maxRounds: 1, };
    }

    const rawAgent = FrontmatterParser.unquote(first,);
    if (!rawAgent)
    {
      return null;
    }

    const isTransform = rawAgent.endsWith("!",);
    const agentName = rawAgent.replace(/[!?]$/, "",);
    if (!agentName || !/^[A-Za-z0-9_-]+$/.test(agentName,))
    {
      return null;
    }

    if (isTransform && parts.length <= 2)
    {
      const maxRounds = parts.length >= 2 ? parseInt(parts[1], 10,) : 1;
      return { type: StepType.Transform, agent: agentName, maxRounds: isNaN(maxRounds,) ? 1 : maxRounds, };
    }

    const maxRounds = parts.length >= 2 ? parseInt(parts[1], 10,) : 3;
    if (isNaN(maxRounds,))
    {
      return null;
    }

    if (parts.length >= 3)
    {
      const rawFixer = FrontmatterParser.unquote(parts[2],);
      const fixer = rawFixer ? rawFixer.replace(/[!?]$/, "",) : null;
      if (fixer && /^[A-Za-z0-9_-]+$/.test(fixer,))
      {
        return { type: StepType.VerifyWithFixer, agent: agentName, maxRounds, fixer, };
      }
    }

    return { type: StepType.Verify, agent: agentName, maxRounds, };
  }

  private static splitCSV(str: string,): string[]
  {
    const parts: string[] = [];
    let current = "";
    let inQuote = false;
    let quoteChar = "";

    for (let i = 0; i < str.length; i++)
    {
      const ch = str[i];
      if (inQuote)
      {
        if (ch === quoteChar)
        {
          inQuote = false;
        }
        else
        {
          current += ch;
        }
      }
      else if (ch === "\"" || ch === "'")
      {
        inQuote = true;
        quoteChar = ch;
      }
      else if (ch === ",")
      {
        parts.push(current.trim(),);
        current = "";
      }
      else
      {
        current += ch;
      }
    }
    if (current.trim())
    {
      parts.push(current.trim(),);
    }
    return parts;
  }

  private static unquote(s: string,): string
  {
    if (!s)
    {
      return s;
    }
    const t = s.trim();
    if ((t.startsWith("\"",) && t.endsWith("\"",)) || (t.startsWith("'",) && t.endsWith("'",)))
    {
      return t.slice(1, -1,);
    }
    return t;
  }
}
