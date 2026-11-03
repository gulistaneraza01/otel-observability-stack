import { logger } from "../utils/logger";
import type { NextFunction, Request, Response } from "express";

const isDev = process.env.NODE_ENV !== "production";

interface HttpErrorLike {
  status?: number;
  statusCode?: number;
}

const pickStatus = (err: unknown): number => {
  const e = err as HttpErrorLike;
  if (typeof e?.status === "number") return e.status;
  if (typeof e?.statusCode === "number") return e.statusCode;
  return 500;
};

export const notFoundHandler = (req: Request, res: Response) => {
  res.status(404).json({ error: `not found: ${req.originalUrl}`, status: "error", code: 404 });
};

export const globalErrorHandler = (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  const code = pickStatus(err);
  const isServer = code >= 500;
  const message =
    !isServer && err instanceof Error && err.message
      ? err.message
      : "internal server error";

  logger.error({
    err,
    request: { method: req.method, url: req.originalUrl },
    code,
  });

  res.status(code).json({
    error: message,
    status: "error",
    code,
    ...(isDev && isServer && err instanceof Error ? { stack: err.stack } : {}),
  });
};

export type { NextFunction, Request, Response };
