import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../config/env.js";
import { HttpError } from "../lib/errors.js";
import { activeSession } from "../services/session.service.js";

/** sid = the sign-in session the token belongs to (see services/session.service.ts). */
const TokenPayload = z.object({ sub: z.string(), email: z.email(), sid: z.uuid() });

/**
 * Requires "Authorization: Bearer <token>". The token must be valid AND its session still
 * active: tokens of signed-out sessions, changed passwords and deleted accounts stop working
 * straight away. Tokens issued before sessions existed have no sid and are rejected.
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.header("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return next(new HttpError(401, "Missing bearer token"));

  let payload: z.infer<typeof TokenPayload>;
  try {
    payload = TokenPayload.parse(jwt.verify(token, env.JWT_SECRET));
  } catch {
    return next(new HttpError(401, "Invalid or expired token. Please sign in again."));
  }
  activeSession(payload.sid, payload.sub)
    .then((session) => {
      if (!session) return next(new HttpError(401, "Your session has ended. Please sign in again."));
      req.user = { id: payload.sub, email: payload.email };
      req.sessionId = session.id;
      next();
    })
    .catch(next);
};
