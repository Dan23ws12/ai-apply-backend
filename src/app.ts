import express from "express";
import cors from "cors";
import helmet from "helmet";
import { env } from "./config/env.js";
import { prisma } from "./lib/prisma.js";
import { requireAuth } from "./middleware/auth.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { requestContext } from "./middleware/requestContext.js";
import { authRouter } from "./routes/auth.routes.js";
import { companiesRouter } from "./routes/companies.routes.js";
import { criteriaRouter } from "./routes/criteria.routes.js";
import { jobsRouter } from "./routes/jobs.routes.js";
import { answersRouter, auditRouter } from "./routes/misc.routes.js";
import { usersRouter } from "./routes/users.routes.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS.split(",").map((o) => o.trim()) }));
  app.use(express.json({ limit: "1mb" }));
  app.use(requestContext);

  app.get("/health", async (_req, res) => {
    const db = await prisma.$queryRaw`SELECT 1`.then(() => "ok").catch(() => "down");
    const ai = await fetch(new URL("/health", env.PYTHON_SERVICE_URL), { signal: AbortSignal.timeout(3000) })
      .then((r) => (r.ok ? "ok" : "down"))
      .catch(() => "down");
    res.status(db === "ok" ? 200 : 503).json({ api: "ok", db, ai });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/users", requireAuth, usersRouter);
  app.use("/api/search-criteria", requireAuth, criteriaRouter);
  app.use("/api/companies", requireAuth, companiesRouter);
  app.use("/api/jobs", requireAuth, jobsRouter);
  app.use("/api/answers", requireAuth, answersRouter);
  app.use("/api/audit-logs", requireAuth, auditRouter);

  app.use((_req, res) => res.status(404).json({ error: "Route not found" }));
  app.use(errorHandler);
  return app;
}
