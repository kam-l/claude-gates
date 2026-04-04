/**
 * MCP server for claude-gates — structured tool calls for gate verdicts.
 *
 * Tools:
 *   gate_verdict — submit PASS/REVISE/FAIL verdict for a pipeline or plan-gate scope
 *   gate_status  — read-only pipeline state query
 *
 * Transport: stdio. Entry point: node scripts/mcp-server.js
 */

import { McpServer, } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport, } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, } from "fs";
import { join, } from "path";
import { z, } from "zod";
import { GateRepository, } from "./GateRepository";
import { PipelineRepository, } from "./PipelineRepository";
import { SessionManager, } from "./SessionManager";

const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json",), "utf8",),);

const server = new McpServer({
  name: "claude-gates",
  version: pkg.version,
},);

// ── gate_verdict ────────────────────────────────────────────────────

server.tool(
  "gate_verdict",
  {
    session_id: z.string().describe("Session UUID",),
    scope: z.string().describe("Pipeline scope or 'verify-plan' for plan-gate",),
    verdict: z.enum(["PASS", "REVISE", "FAIL",],).describe("Verdict: PASS, REVISE, or FAIL",),
    reason: z.string().describe("Human-readable reason for the verdict",),
  },
  async ({ session_id, scope, verdict, reason, },) =>
  {
    try
    {
      const sessionDir = SessionManager.getSessionDir(session_id,);

      // Plan-gate scope — writes to agents table where plan-gate.ts reads gater verdicts
      if (scope === "verify-plan")
      {
        const db = GateRepository.createDb(sessionDir,);
        try
        {
          const gateRepo = new GateRepository(db,);
          gateRepo.setVerdict("gater-review", "gater", verdict, 0,);
          return {
            content: [{ type: "text" as const, text: `Plan-gate verdict recorded: ${verdict}. Reason: ${reason}`, },],
          };
        }
        finally
        {
          db.close();
        }
      }

      // Pipeline scope — record verdict only (hook process drives engine.step)
      const db = SessionManager.openDatabase(sessionDir,);
      PipelineRepository.initSchema(db,);
      try
      {
        const repo = new PipelineRepository(db,);
        const activeStep = repo.getActiveStep(scope,);
        if (!activeStep)
        {
          return {
            content: [{ type: "text" as const, text: `Error: no active step found for scope="${scope}". Is the pipeline running?`, },],
            isError: true,
          };
        }

        const agent = activeStep.agent || activeStep.source_agent;
        repo.setVerdict(scope, agent, verdict, activeStep.round,);

        return {
          content: [{
            type: "text" as const,
            text:
              `Verdict ${verdict} recorded for scope="${scope}" step ${activeStep.step_index} (${activeStep.step_type}). Reason: ${reason}`,
          },],
        };
      }
      finally
      {
        db.close();
      }
    }
    catch (err)
    {
      const errMsg = err instanceof Error ? err.message : String(err,);
      process.stderr.write(`[ClaudeGates MCP] gate_verdict error: ${errMsg}\n`,);
      return {
        content: [{ type: "text" as const, text: `Error: ${errMsg}`, },],
        isError: true,
      };
    }
  },
);

// ── gate_status ─────────────────────────────────────────────────────

server.tool(
  "gate_status",
  {
    session_id: z.string().describe("Session UUID",),
    scope: z.string().optional().describe("Pipeline scope (omit for all active pipelines)",),
  },
  async ({ session_id, scope, },) =>
  {
    try
    {
      const sessionDir = SessionManager.getSessionDir(session_id,);
      const db = SessionManager.openDatabase(sessionDir,);
      PipelineRepository.initSchema(db,);
      try
      {
        const repo = new PipelineRepository(db,);
        if (scope)
        {
          const state = repo.getPipelineState(scope,);
          if (!state)
          {
            return {
              content: [{ type: "text" as const, text: `No pipeline found for scope="${scope}".`, },],
              isError: true,
            };
          }
          const steps = repo.getSteps(scope,);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ state, steps, }, null, 2,),
            },],
          };
        }

        // All active pipelines
        const pipelines = repo.getActivePipelines();
        if (pipelines.length === 0)
        {
          return {
            content: [{ type: "text" as const, text: "No active pipelines.", },],
          };
        }
        const result = pipelines.map((p,) => ({
          scope: p.scope,
          status: p.status,
          current_step: p.current_step,
          total_steps: p.total_steps,
        }));
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(result, null, 2,),
          },],
        };
      }
      finally
      {
        db.close();
      }
    }
    catch (err)
    {
      const errMsg = err instanceof Error ? err.message : String(err,);
      process.stderr.write(`[ClaudeGates MCP] gate_status error: ${errMsg}\n`,);
      return {
        content: [{ type: "text" as const, text: `Error: ${errMsg}`, },],
        isError: true,
      };
    }
  },
);

// ── Start server ────────────────────────────────────────────────────

async function main(): Promise<void>
{
  const transport = new StdioServerTransport();
  await server.connect(transport,);
}

main().catch((err,) =>
{
  process.stderr.write(`[ClaudeGates MCP] Fatal: ${err}\n`,);
  process.exit(1,);
},);
