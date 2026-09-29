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
  next();
}

export async function rateLimit(request: Request, _response: Response, next: NextFunction) {
  try {
    if (request.path === "/health") return next();
    const ip = request.ip || request.socket.remoteAddress || "unknown";
    const minute = new Date();
    minute.setSeconds(0, 0);
    const bucket = `${ip}:${minute.toISOString()}`;
    const result = await db.query<{ request_count: number }>(
      `INSERT INTO rate_limit_buckets (bucket, window_started_at, request_count) VALUES ($1,$2,1)
       ON CONFLICT (bucket) DO UPDATE SET request_count = rate_limit_buckets.request_count + 1, updated_at = now()
       RETURNING request_count`,
      [bucket, minute],
    );
    if (result.rows[0].request_count > 120)
      throw new ApiError(429, "rate_limited", "Too many requests. Try again in a minute.");
    next();
  } catch (error) {
    next(error);
  }
}
