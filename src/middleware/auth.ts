import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../config/env.js";
import { HttpError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";

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

  let payload: z.infer<typeof TokenPayload>;
  try {
    payload = TokenPayload.parse(jwt.verify(token, env.JWT_SECRET));
  } catch {
    return next(new HttpError(401, "Invalid or expired token"));
  }
  // Tokens of deleted accounts must stop working straight away.
  prisma.user
    .findUnique({ where: { id: payload.sub }, select: { id: true } })
    .then((user) => {
      if (!user) return next(new HttpError(401, "Account no longer exists"));
      req.user = { id: payload.sub, email: payload.email };
      next();
    })
    .catch(next);
};
