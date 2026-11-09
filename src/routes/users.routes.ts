import { Router } from "express";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { encryptJson } from "../lib/crypto.js";
import { body, validate } from "../middleware/validate.js";
import { CredentialsBody, ProfileBody, UpdateUserBody } from "../schemas/index.js";
import { getUserCredentials } from "../services/credentials.service.js";

export const usersRouter = Router();

usersRouter.patch("/me", validate({ body: UpdateUserBody }), async (req, res) => {
  const user = await prisma.user.update({
    where: { id: req.user!.id },
    data: body(req, UpdateUserBody),
    select: { id: true, firstName: true, lastName: true, email: true, updatedAt: true },
  });
  res.json({ user });
});

// ── Profile used to fill application forms ──
usersRouter.get("/me/profile", async (req, res) => {
  const profile = await prisma.userProfile.upsert({
    where: { userId: req.user!.id },
    create: { userId: req.user!.id },
    update: {},
  });
  res.json({ profile });
});

usersRouter.put("/me/profile", validate({ body: ProfileBody }), async (req, res) => {
  const data = body(req, ProfileBody);
  const { extraAnswers, ...rest } = data;
  const json = extraAnswers === null ? Prisma.DbNull : extraAnswers;
  const profile = await prisma.userProfile.upsert({
    where: { userId: req.user!.id },
    create: { userId: req.user!.id, ...rest, extraAnswers: json },
    update: { ...rest, extraAnswers: json },
  });
  res.json({ profile });
});

// ── Job-site credentials (encrypted, write-only) ──
usersRouter.put("/me/credentials", validate({ body: CredentialsBody }), async (req, res) => {
  const incoming = body(req, CredentialsBody);
  const current = await getUserCredentials(req.user!.id);
  const merged = { ...current, ...incoming };
  await prisma.user.update({
    where: { id: req.user!.id },
    data: { credentials: encryptJson(merged) as object },
  });
  res.json({ savedSites: Object.keys(merged) });
});

/** Returns which sites have saved logins, never the passwords themselves. */
usersRouter.get("/me/credentials", async (req, res) => {
  const creds = await getUserCredentials(req.user!.id);
  res.json({
    sites: Object.fromEntries(
      Object.entries(creds).map(([site, c]) => [site, { email: c?.email ?? null, hasPassword: !!c?.password }]),
    ),
  });
});

usersRouter.delete("/me/credentials", async (req, res) => {
  await prisma.user.update({ where: { id: req.user!.id }, data: { credentials: Prisma.DbNull } });
  res.status(204).end();
});

/**
 * Deletes your account. Your profile, saved searches, saved answers and blacklist rows
 * are deleted with it. Your jobs are kept with userId set to null (application history).
 */
usersRouter.delete("/me", async (req, res) => {
  await prisma.user.delete({ where: { id: req.user!.id } });
  res.status(204).end();
});
