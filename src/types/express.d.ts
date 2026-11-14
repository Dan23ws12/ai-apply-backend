import "express";

declare global {
  namespace Express {
    interface Request {
      /** Set by middleware/requestContext.ts */
      requestId: string;
      /** Set by middleware/auth.ts */
      user?: { id: string; email: string };
      /** The sign-in session of the request's token. Set by middleware/auth.ts */
      sessionId?: string;
      /** Zod-parsed body / query / params, set by middleware/validate.ts */
      valid: { body?: unknown; query?: unknown; params?: unknown };
    }
  }
}

export {};
