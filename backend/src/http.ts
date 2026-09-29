import type { NextFunction, Request, Response } from "express";
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

export function errorHandler(
  error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction,
) {
  if (error instanceof ApiError)
    return response
      .status(error.status)
      .json({ error: { code: error.code, message: error.message } });
  if (error instanceof ZodError)
    return response.status(400).json({
      error: {
        code: "invalid_request",
        message: error.issues[0]?.message ?? "The request is invalid.",
        fields: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
  console.error(error);
  return response
    .status(500)
    .json({ error: { code: "internal_error", message: "An unexpected error occurred." } });
}
