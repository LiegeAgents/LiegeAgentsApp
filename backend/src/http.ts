import type { NextFunction, Request, Response } from "express";
import { DatabaseError } from "pg";
import { BaseError as ChainError } from "viem";
import { ZodError } from "zod";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const asyncRoute =
  (handler: (request: Request, response: Response) => Promise<unknown>) =>
  (request: Request, response: Response, next: NextFunction) =>
    handler(request, response).catch(next);

// Constraint failures reach Postgres only when a request conflicts with stored data.
const databaseErrors: Record<string, [number, string, string]> = {
  "23505": [409, "conflict", "This conflicts with an existing record."],
  "23503": [422, "invalid_reference", "The request refers to a record that does not exist."],
  "23514": [422, "constraint_violation", "The request violates a data constraint."],
  "22003": [422, "value_out_of_range", "A value in the request is out of range."],
  "22P02": [400, "invalid_request", "The request contains a malformed value."],
};

// Body parser errors carry an HTTP status and a type.
const bodyErrors: Record<string, [number, string, string]> = {
  "entity.parse.failed": [400, "invalid_json", "The request body is not valid JSON."],
  "entity.too.large": [413, "payload_too_large", "The request body is too large."],
};

function describe(error: unknown): {
  status: number;
  code: string;
  message: string;
  fields?: object[];
} {
  if (error instanceof ApiError)
    return { status: error.status, code: error.code, message: error.message };
  if (error instanceof ZodError)
    return {
      status: 400,
      code: "invalid_request",
      message: error.issues[0]?.message ?? "The request is invalid.",
      fields: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    };
  if (error instanceof DatabaseError && error.code && databaseErrors[error.code]) {
    const [status, code, message] = databaseErrors[error.code];
    return { status, code, message };
  }
  const bodyError = (error as { type?: string } | null)?.type;
  if (bodyError && bodyErrors[bodyError]) {
    const [status, code, message] = bodyErrors[bodyError];
    return { status, code, message };
  }
  if (error instanceof ChainError)
    return {
      status: 502,
      code: "chain_unavailable",
      message: "The blockchain RPC could not complete the request. Try again shortly.",
    };
  return { status: 500, code: "internal_error", message: "An unexpected error occurred." };
}

// Every error response has this one shape: { error: { code, message, requestId, fields? } }.
export function errorHandler(
  error: unknown,
  request: Request,
  response: Response,
  _next: NextFunction,
) {
  const { status, ...details } = describe(error);
  if (status >= 500) console.error(error);
  return response.status(status).json({ error: { ...details, requestId: request.requestId } });
}
