import type { NextFunction, Request, RequestHandler, Response } from "express";

type AsyncRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => void | Promise<unknown>;

/**
 * Wraps an async controller so any thrown/rejected error is forwarded to
 * Express error middleware via next(err), removing the need for try/catch.
 */
export const asyncHandler =
  (fn: AsyncRequestHandler): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);
