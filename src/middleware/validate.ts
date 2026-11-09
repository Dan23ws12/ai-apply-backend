import type { Request, RequestHandler } from "express";
import { z } from "zod";
import { HttpError } from "../lib/errors.js";

interface Schemas {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
}

/**
 * Validates req.body / req.query / req.params with Zod.
 * Parsed values go to req.valid (Express 5 makes req.query read-only).
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    for (const part of ["body", "query", "params"] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (!result.success) {
        return next(
          new HttpError(400, `Invalid request ${part}`, z.flattenError(result.error).fieldErrors),
        );
      }
      req.valid[part] = result.data;
    }
    next();
  };
}

/** Typed accessors for values validated by validate(). */
export const body = <S extends z.ZodType>(req: Request, _schema: S) => req.valid.body as z.infer<S>;
export const query = <S extends z.ZodType>(req: Request, _schema: S) => req.valid.query as z.infer<S>;
export const params = <S extends z.ZodType>(req: Request, _schema: S) => req.valid.params as z.infer<S>;
