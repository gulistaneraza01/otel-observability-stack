import { sql } from "bun";
import type { Request, Response } from "express";
import { getBackgroundState } from "../utils/backgroundWorker";
import { HttpError } from "../utils/httpError";
import { logger } from "../utils/logger";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const parseNumber = (
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
) => {
  const parsed = Number(raw);
  const value = Number.isFinite(parsed) && raw != null && raw !== "" ? parsed : fallback;
  return clamp(value, min, max);
};

export const getHelloWorld = async (_req: Request, res: Response) => {
  await delay(10);
  res.status(200).json({ message: "Hello World", status: "success" });
};

const leakedBuffers: ArrayBuffer[] = [];
let leakedBytes = 0;
const LEAK_CAP_BYTES = 500 * 1024 * 1024;

export const getSlow = async (req: Request, res: Response) => {
  const ms = parseNumber(req.query.ms, 1000, 0, 10_000);
  await delay(ms);
  res.status(200).json({ endpoint: "slow", delayedMs: ms, status: "success" });
};

export const getLatency = async (req: Request, res: Response) => {
  const errorRate = parseNumber(req.query.errorRate, 0.1, 0, 1);
  const tailRate = parseNumber(req.query.tailRate, 0.05, 0, 1);
  const maxMs = parseNumber(req.query.maxMs, 800, 10, 2000);

  await delay(Math.random() * 40);

  const roll = Math.random();
  if (roll < errorRate) {
    throw new HttpError(503, `latency profile: simulated error (roll=${roll.toFixed(3)})`);
  }
  if (roll < errorRate + tailRate) {
    await delay(Math.random() * maxMs);
  }

  res.status(200).json({
    endpoint: "latency",
    hint: "mix of fast requests + error burst + long tail -> p50/p95/p99 shape",
    status: "success",
  });
};

export const getError = (req: Request, res: Response) => {
  const code = parseNumber(req.query.code, 500, 400, 503);
  throw new HttpError(code, `simulated error with status ${code}`);
};

export const getRandomError = (req: Request, res: Response) => {
  const rate = parseNumber(req.query.rate, 0.3, 0, 1);
  if (Math.random() < rate) {
    throw new HttpError(500, `random error fired (rate=${rate})`);
  }
  res.status(200).json({ endpoint: "random-error", rate, status: "success" });
};

export const getCpu = (req: Request, res: Response) => {
  const ms = parseNumber(req.query.ms, 100, 0, 1000);
  const start = Date.now();
  let iterations = 0;
  const end = start + ms;
  let x = 1;
  while (Date.now() < end) {
    for (let i = 0; i < 1000; i++) {
      x += Math.sqrt(x);
      iterations++;
    }
  }
  res.status(200).json({
    endpoint: "cpu",
    blockedMs: Date.now() - start,
    iterations,
    status: "success",
  });
};

export const getMemory = (req: Request, res: Response) => {
  const mb = parseNumber(req.query.mb, 25, 1, 64);
  const leave = req.query.leave === "true";
  const bytes = mb * 1024 * 1024;

  if (leave && leakedBytes + bytes <= LEAK_CAP_BYTES) {
    leakedBuffers.push(new ArrayBuffer(bytes));
    leakedBytes += bytes;
  }

  const usage = process.memoryUsage();
  res.status(200).json({
    endpoint: "memory",
    allocatedMb: mb,
    leakedMb: Math.round(leakedBytes / 1024 / 1024),
    leakCapMb: Math.round(LEAK_CAP_BYTES / 1024 / 1024),
    parsed: {
      rssMb: Math.round(usage.rss / 1024 / 1024),
      heapUsedMb: Math.round(usage.heapUsed / 1024 / 1024),
    },
  });
};

export const getStatus = (_req: Request, res: Response) => {
  const usage = process.memoryUsage();
  res.status(200).json({
    endpoint: "status",
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    leakedMb: Math.round(leakedBytes / 1024 / 1024),
    rssMb: Math.round(usage.rss / 1024 / 1024),
    heapUsedMb: Math.round(usage.heapUsed / 1024 / 1024),
  });
};

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

export const getLogs = (req: Request, res: Response) => {
  const level = ((req.query.level as string) ?? "info").toLowerCase() as LogLevel;
  if (!LOG_LEVELS.includes(level)) {
    throw new HttpError(400, `level must be one of ${LOG_LEVELS.join(", ")}`);
  }
  const message = (req.query.message as string) ?? `test log at level ${level}`;
  logger[level](message);
  res.status(200).json({ endpoint: "logs", level, message, status: "success" });
};

export const getMultiHop = async (req: Request, res: Response) => {
  const depth = parseNumber(req.query.depth, 2, 0, 5);
  const workMs = parseNumber(req.query.workMs, 10, 0, 500);

  await delay(workMs);
  logger.info(
    { event: "multi-hop", depth },
    `multi-hop call at depth ${depth}`,
  );

  if (depth <= 0) {
    res.status(200).json({ endpoint: "multi-hop", depth, child: null, status: "success" });
    return;
  }

  const base =
    process.env.SELF_URL ??
    `${req.protocol}://${req.get("host") ?? `localhost:${port()}`}`;
  const target = `${base}/api/v1/test/multi-hop?depth=${depth - 1}&workMs=${workMs}`;

  const headers = new Headers();
  const propagated = ["traceparent", "tracestate", "baggage", "x-request-id"];
  for (const name of propagated) {
    const value = req.get(name);
    if (value) headers.set(name, value);
  }

  let child: unknown;
  try {
    const response = await fetch(target, { headers });
    if (!response.ok) {
      throw new HttpError(502, `hop to ${target} returned HTTP ${response.status}`);
    }
    child = await response.json();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, (error as Error).message ?? "downstream hop failed");
  }

  res.status(200).json({
    endpoint: "multi-hop",
    depth,
    child,
    status: "success",
  });
};

const port = () => String(process.env.PORT ?? 3000);

export const getDb = async (req: Request, res: Response) => {
  const ms = parseNumber(req.query.ms, 0, 0, 2000);
  const seconds = Math.round((ms / 1000) * 1000) / 1000;

  try {
    const start = Date.now();
    const rows =
      await sql`select current_database() as db, pg_sleep(${seconds}::float8) as slept`;
    const queryMs = Date.now() - start;

    logger.info(
      { event: "db.query", requestedSlowMs: ms, queryMs },
      "db query executed",
    );
    res.status(200).json({
      endpoint: "db",
      requestedSlowMs: ms,
      queryMs,
      database: rows[0]?.db,
      status: "success",
    });
  } catch (error) {
    throw new HttpError(503,
      `database unavailable: ${(error as Error).message ?? "unknown error"}`);
  }
};

export const getBackground = (_req: Request, res: Response) => {
  res.status(200).json({
    endpoint: "background",
    backgroundState: getBackgroundState(),
  });
};
