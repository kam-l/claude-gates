import crypto from "crypto";
import fs from "fs";
import path from "path";
import { PipelineRepository, } from "./PipelineRepository";

const NOOP: any = new Proxy(Object.create(null,), {
  get(_target: any, prop: string | symbol,)
  {
    if (typeof prop === "symbol")
    {
      return undefined;
    }
    return (...args: any[]) => (args.length === 0 ? null : NOOP);
  },
},);

export interface ITracingContext
{
  langfuse: any;
  enabled: boolean;
}

export class Tracing
{
  public static init(): ITracingContext
  {
    if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY)
    {
      return { langfuse: NOOP, enabled: false, };
    }
    try
    {
      const { Langfuse, } = require("langfuse",);
      const langfuse = new Langfuse({
        publicKey: process.env.LANGFUSE_PUBLIC_KEY,
        secretKey: process.env.LANGFUSE_SECRET_KEY,
        baseUrl: process.env.LANGFUSE_BASE_URL || undefined,
        flushAt: 1,
        flushInterval: 0,
      },);
      return { langfuse, enabled: true, };
    }
    catch
    {
      return { langfuse: NOOP, enabled: false, };
    }
  }

  /**
   * Session-level trace. Deterministic ID from sessionId — all scopes in one session share the same trace.
   * Still writes trace_id to pipeline_state for PipelineBlock.ts compatibility.
   */
  public static getOrCreateTrace(langfuse: any, enabled: boolean, db: any, scope: string, sessionId: string,): any
  {
    if (!enabled)
    {
      return NOOP;
    }
    try
    {
      const traceId = Tracing.sessionTraceId(sessionId,);

      // Write to pipeline_state so PipelineBlock.ts can read it (backward compat)
      const repo = new PipelineRepository(db,);
      if (repo.getPipelineState(scope,))
      {
        repo.setTraceId(scope, traceId,);
      }
      else
      {
        return NOOP;
      }

      return langfuse.trace({
        id: traceId,
        name: `session`,
        sessionId: sessionId,
      },);
    }
    catch
    {
      return NOOP;
    }
  }

  /**
   * Deterministic trace ID from sessionId — no DB lookup needed.
   */
  public static sessionTraceId(sessionId: string,): string
  {
    return crypto.createHash("sha256",).update(sessionId,).digest("hex",).slice(0, 32,);
  }

  /**
   * Scope-level span under the session trace. All handler spans nest under this.
   */
  public static scopeSpan(trace: any, scope: string,): any
  {
    return trace.span({ name: `scope:${scope}`, },);
  }

  /**
   * Categorical score for a verdict event.
   */
  public static score(trace: any, enabled: boolean, name: string, value: string, comment?: string,): void
  {
    if (!enabled)
    {
      return;
    }
    try
    {
      trace.score({
        name,
        value,
        dataType: "CATEGORICAL",
        comment: comment || undefined,
      },);
    }
    catch
    {
    }
  }

  public static async flush(langfuse: any, enabled: boolean,): Promise<void>
  {
    if (!enabled)
    {
      return;
    }
    try
    {
      await langfuse.shutdownAsync();
    }
    catch
    {
    }
  }

  public static trace(sessionDir: string, op: string, scope: string | null, detail?: Record<string, any>,): void
  {
    try
    {
      const entry = JSON.stringify({ ts: new Date().toISOString(), op, scope, ...detail, },);
      fs.appendFileSync(path.join(sessionDir, "audit.jsonl",), entry + "\n", "utf-8",);
    }
    catch
    {
    }
  }

  public static readonly NOOP = NOOP;
}
