import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { db } from "./db/index.js";
import { ApiError } from "./http.js";

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

export function requestContext(request: Request, response: Response, next: NextFunction) {
  request.requestId =
    request.header("x-request-id")?.match(/^[0-9a-f-]{36}$/i)?.[0] ?? randomUUID();
  response.setHeader("X-Request-Id", request.requestId);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
  const startedAt = performance.now();
  response.once("finish", () => {
    if (request.path === "/health") return;
    const auth = (request as Request & { auth?: { userId?: string; method?: string } }).auth;
    console.log(
      JSON.stringify({
        event: "http.request",
        requestId: request.requestId,
        method: request.method,
        route: request.route?.path ?? request.path,
        status: response.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        actor: auth?.method ?? (auth?.userId ? "session" : "anonymous"),
      }),
    );
  });
  next();
}

// Requests per client IP per minute. Sign-in and the routes that call the chain RPC get their
// own, smaller budgets so they cannot be used to exhaust the general one or the RPC provider.
const budgets = [
  { name: "mobile_pair", limit: 10, matches: (path: string) => path === "/v1/mobile/pair" },
  { name: "auth", limit: 20, matches: (path: string) => path.startsWith("/v1/auth/") },
  {
    name: "chain",
    limit: 20,
    matches: (path: string) => /^\/v1\/jobs\/[^/]+\/(fund|funding-quote)$/.test(path),
  },
  { name: "general", limit: 120, matches: () => true },
];

// Buckets older than this can no longer affect a decision.
const BUCKET_RETENTION = "5 minutes";
let lastPruned = 0;

export async function pruneRateLimitBuckets() {
  const pruned = await db.query(
    `DELETE FROM rate_limit_buckets WHERE window_started_at < now() - interval '${BUCKET_RETENTION}'`,
  );
  return pruned.rowCount ?? 0;
}

export async function rateLimit(request: Request, response: Response, next: NextFunction) {
  try {
    if (request.path === "/health") return next();
    if (Date.now() - lastPruned > 60_000) {
      lastPruned = Date.now();
      void pruneRateLimitBuckets().catch((error) =>
        console.error("Could not prune rate limit buckets:", error),
      );
    }
    const budget = budgets.find((candidate) => candidate.matches(request.path))!;
    const ip = request.ip || request.socket.remoteAddress || "unknown";
    const minute = new Date();
    minute.setSeconds(0, 0);
    const bucket = `${budget.name}:${ip}:${minute.toISOString()}`;
    const result = await db.query<{ request_count: number }>(
      `INSERT INTO rate_limit_buckets (bucket, window_started_at, request_count) VALUES ($1,$2,1)
       ON CONFLICT (bucket) DO UPDATE SET request_count = rate_limit_buckets.request_count + 1, updated_at = now()
       RETURNING request_count`,
      [bucket, minute],
    );
    if (result.rows[0].request_count > budget.limit) {
      response.setHeader("Retry-After", String(60 - new Date().getSeconds()));
      throw new ApiError(429, "rate_limited", "Too many requests. Try again in a minute.");
    }
    next();
  } catch (error) {
    next(error);
  }
}

// TRUST_PROXY tells Express which proxies may set X-Forwarded-For: a hop count, true/false, or a
// comma-separated list of addresses, CIDR ranges, or the names loopback/linklocal/uniquelocal.
// Only the proxy in front of the service should be trusted, and the service should accept traffic
// only from it; otherwise clients can choose their own rate limit bucket.
export function parseTrustProxy(value: string): boolean | number | string[] {
  const trimmed = value.trim();
  if (trimmed === "true" || trimmed === "false") return trimmed === "true";
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
