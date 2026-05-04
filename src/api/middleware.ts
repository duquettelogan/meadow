import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { formatZodError } from './validation';

/**
 * Validation middleware factory. Replaces req.body with the parsed,
 * stripped, and typed data on success. Returns 400 on validation failure.
 */
export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json(formatZodError(err));
        return;
      }
      next(err);
    }
  };
}

/**
 * Final error handler. Sanitizes errors so we never leak stack traces or
 * internal database codes to clients.
 */
export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  // Log full detail server-side, return scrubbed response.
  console.error(`[${req.method} ${req.path}]`, err?.message || err);
  if (err?.stack) console.error(err.stack);

  if (res.headersSent) {
    return;
  }
  res.status(500).json({ error: 'internal server error' });
}

/**
 * Minimal request logger. Logs method, path, status, and duration.
 * No bodies, no headers, no PII.
 */
export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    // Skip noise from health checks.
    if (req.path === '/health') return;
    console.log(
      `${req.method} ${req.path} ${res.statusCode} ${ms}ms`
    );
  });
  next();
}
