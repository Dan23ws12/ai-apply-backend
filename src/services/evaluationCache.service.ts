import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import type { EvaluationKind } from "../generated/prisma/enums.js";

/**
 * Cache for the AI fraud and match ratings, shared by every user and every re-run.
 *
 * - FRAUD depends only on the posting, so the key is the posting fields plus the fraud rules.
 * - MATCH depends on the posting, the preferred resume track, and the base resumes / skills
 *   files the Python service reads. Those files are fingerprinted (path + size + modified
 *   time), so editing a resume or a skill file makes old match results stop matching.
 * - EVALUATION_CACHE_VERSION throws everything away (e.g. after changing the AI model).
 *
 * Two jobs with the same key evaluated at the same time share one AI call.
 */

const ROOT = () => path.resolve(env.REFERENCES_ROOT);

/** What each kind of rating depends on, besides the posting. */
const SOURCES: Record<EvaluationKind, { files: string[]; dirs: { dir: string; match: RegExp; depth?: number }[] }> = {
  FRAUD: {
    files: [".agents/skills/job-post-evaluation/SKILL.md", "python-service/app/fraud.py", "shared-references/company-name-parts.json"],
    dirs: [],
  },
  MATCH: {
    files: [".agents/skills/job-post-evaluation/SKILL.md", "python-service/app/match.py", "python-service/app/references.py"],
    dirs: [
      { dir: "resumes/base resumes", match: /\.docx$/i },
      { dir: "shared-references", match: /\.md$/i },
      { dir: ".agents/skills", match: /SKILL\.md$/i, depth: 1 },
    ],
  },
};

const FINGERPRINT_TTL_MS = 30_000;
const fingerprints = new Map<EvaluationKind, { value: string; at: number }>();

async function listFiles(dir: string, match: RegExp, depth = 0): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) out.push(...(await listFiles(full, match, depth - 1)));
    else if (e.isFile() && match.test(e.name)) out.push(full);
  }
  return out;
}

/** Changes whenever a file the rating depends on is added, removed or edited. */
export async function rulesFingerprint(kind: EvaluationKind): Promise<string> {
  const hit = fingerprints.get(kind);
  if (hit && Date.now() - hit.at < FINGERPRINT_TTL_MS) return hit.value;

  const root = ROOT();
  const src = SOURCES[kind];
  const files = [
    ...src.files.map((f) => path.join(root, f)),
    ...(await Promise.all(src.dirs.map((d) => listFiles(path.join(root, d.dir), d.match, d.depth)))).flat(),
  ];
  const parts = await Promise.all(
    [...new Set(files)].sort().map(async (f) => {
      const s = await stat(f).catch(() => null);
      return `${path.relative(root, f)}:${s ? `${s.size}:${Math.trunc(s.mtimeMs)}` : "missing"}`;
    }),
  );
  const value = sha256(parts.join("\n"));
  fingerprints.set(kind, { value, at: Date.now() });
  return value;
}

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

/** JSON with sorted keys and trimmed strings, so the same input always gives the same key. */
function stableJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value.trim().replace(/\s+/g, " "));
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function evaluationCacheKey(kind: EvaluationKind, input: unknown): Promise<string> {
  return sha256(`${kind}|${env.EVALUATION_CACHE_VERSION}|${await rulesFingerprint(kind)}|${stableJson(input)}`);
}

const inFlight = new Map<string, Promise<unknown>>();

/**
 * Returns the cached result for (kind, input) when there is a fresh one, otherwise runs
 * `compute`, stores the result and returns it. `refresh` skips the lookup but still stores.
 */
export async function cachedEvaluation<S extends z.ZodType>(
  kind: EvaluationKind,
  input: unknown,
  schema: S,
  compute: () => Promise<z.infer<S>>,
  opts: { refresh?: boolean } = {},
): Promise<{ result: z.infer<S>; cached: boolean }> {
  const cacheKey = await evaluationCacheKey(kind, input);

  if (!opts.refresh) {
    const row = await prisma.evaluationCache.findUnique({ where: { kind_cacheKey: { kind, cacheKey } } });
    if (row && row.expiresAt > new Date()) {
      const parsed = schema.safeParse(row.result);
      if (parsed.success) {
        void prisma.evaluationCache
          .update({ where: { id: row.id }, data: { hitCount: { increment: 1 } } })
          .catch(() => undefined);
        logger.debug({ kind, cacheKey }, "Evaluation cache hit");
        return { result: parsed.data, cached: true };
      }
      // Shape changed since it was stored: fall through and recompute.
    }
  }

  const flightKey = `${kind}:${cacheKey}`;
  const pending = inFlight.get(flightKey) as Promise<z.infer<S>> | undefined;
  if (pending) return { result: await pending, cached: true };

  const run = (async () => {
    const result = await compute();
    const days = kind === "FRAUD" ? env.FRAUD_CACHE_TTL_DAYS : env.MATCH_CACHE_TTL_DAYS;
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    await prisma.evaluationCache
      .upsert({
        where: { kind_cacheKey: { kind, cacheKey } },
        create: { kind, cacheKey, result: result as object, expiresAt },
        update: { result: result as object, expiresAt, hitCount: 0 },
      })
      .catch((err) => logger.warn({ err, kind }, "Could not store evaluation in cache"));
    return result;
  })();
  inFlight.set(flightKey, run);
  try {
    return { result: await run, cached: false };
  } finally {
    inFlight.delete(flightKey);
  }
}

/** Deletes expired cache rows. Safe to call any time (e.g. from a daily job). */
export async function purgeExpiredCaches() {
  const now = new Date();
  const [evaluations, searches] = await Promise.all([
    prisma.evaluationCache.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.searchCache.deleteMany({ where: { expiresAt: { lt: now } } }),
  ]);
  return { evaluations: evaluations.count, searches: searches.count };
}
