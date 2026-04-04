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

  public static getOrCreateTrace(langfuse: any, enabled: boolean, db: any, scope: string, sessionId: string,): any
  {
    if (!enabled)
    {
      return NOOP;
    }
    try
    {
      const repo = new PipelineRepository(db,);
      let traceId = repo.getTraceId(scope,);
      if (traceId === null && !repo.getPipelineState(scope,))
      {
        return NOOP;
      }

      if (!traceId)
      {
        traceId = crypto.randomUUID();
        repo.setTraceId(scope, traceId,);
      }

      return langfuse.trace({
        id: traceId,
        name: `pipeline:${scope}`,
        sessionId: sessionId,
        metadata: { scope, },
      },);
    }
    catch
    {
      return NOOP;
    }
  }

  public static flush(langfuse: any, enabled: boolean,): void
  {
    if (!enabled)
    {
      return;
    }
    try
    {
      langfuse.shutdownAsync().catch(() =>
      {},);
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
