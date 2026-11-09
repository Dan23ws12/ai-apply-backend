import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../config/env.js";
import { HttpError } from "../lib/errors.js";

const TokenPayload = z.object({ sub: z.string(), email: z.email() });

export function signToken(user: { id: string; email: string }): string {
  return jwt.sign({ email: user.email }, env.JWT_SECRET, {
    subject: user.id,
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
}

/** Requires "Authorization: Bearer <token>". The token payload is checked with Zod. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.header("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return next(new HttpError(401, "Missing bearer token"));

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET);
    const payload = TokenPayload.parse(decoded);
    req.user = { id: payload.sub, email: payload.email };
    next();
  } catch {
    next(new HttpError(401, "Invalid or expired token"));
  }
};
