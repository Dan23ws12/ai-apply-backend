import { Router } from "express";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { notFound } from "../lib/errors.js";
import { body, params, validate } from "../middleware/validate.js";
import { CredentialsBody, ProfileBody, UpdateUserBody, UserSettingsBody } from "../schemas/index.js";
import { SiteLoginBody, SiteLoginPatchBody, SiteParams } from "../schemas/account.js";
import { connectedSites, getUserCredentials, saveUserCredentials } from "../services/credentials.service.js";
import { getUserSettings, updateUserSettings } from "../services/settings.service.js";

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

// ── App settings (job search: jobs per search, pages per API call) ──
usersRouter.get("/me/settings", async (req, res) => {
  res.json({ settings: await getUserSettings(req.user!.id) });
});

/** Partial update: send only the settings you want to change. */
usersRouter.patch("/me/settings", validate({ body: UserSettingsBody }), async (req, res) => {
  res.json({ settings: await updateUserSettings(req.user!.id, body(req, UserSettingsBody)) });
});

// ── Job-site credentials (encrypted, write-only) ──
// Passwords are encrypted with CREDENTIALS_ENCRYPTION_KEY and never returned.

/**
 * Sites with a saved login, as { linkedin: { email, hasPassword }, ... }.
 * Only connected sites are listed, so the keys are the connected sites.
 */
usersRouter.get("/me/credentials", async (req, res) => {
  res.json(connectedSites(await getUserCredentials(req.user!.id)));
});

/** Add or replace logins for several sites at once; sites not in the body are kept. */
usersRouter.put("/me/credentials", validate({ body: CredentialsBody }), async (req, res) => {
  const merged = { ...(await getUserCredentials(req.user!.id)), ...body(req, CredentialsBody) };
  await saveUserCredentials(req.user!.id, merged);
  res.json(connectedSites(merged));
});

/** Remove every saved login. */
usersRouter.delete("/me/credentials", async (req, res) => {
  await prisma.user.update({ where: { id: req.user!.id }, data: { credentials: Prisma.DbNull } });
  res.status(204).end();
});

/** Add or replace one site's login: PUT /api/users/me/credentials/linkedin { email, password }. */
usersRouter.put("/me/credentials/:site", validate({ params: SiteParams, body: SiteLoginBody }), async (req, res) => {
  const { site } = params(req, SiteParams);
  const creds = { ...(await getUserCredentials(req.user!.id)), [site]: body(req, SiteLoginBody) };
  await saveUserCredentials(req.user!.id, creds);
  res.json(connectedSites(creds));
});

/** Change one site's email and/or password; a field left out keeps its saved value. */
usersRouter.patch("/me/credentials/:site", validate({ params: SiteParams, body: SiteLoginPatchBody }), async (req, res) => {
  const { site } = params(req, SiteParams);
  const creds = await getUserCredentials(req.user!.id);
  const current = creds[site];
  if (!current) throw notFound(`Saved login for ${site}`);
  const patch = body(req, SiteLoginPatchBody);
  creds[site] = { email: patch.email ?? current.email, password: patch.password ?? current.password };
  await saveUserCredentials(req.user!.id, creds);
  res.json(connectedSites(creds));
});

/** Remove one site's login; the other sites are kept. */
usersRouter.delete("/me/credentials/:site", validate({ params: SiteParams }), async (req, res) => {
  const { site } = params(req, SiteParams);
  const creds = await getUserCredentials(req.user!.id);
  if (!creds[site]) throw notFound(`Saved login for ${site}`);
  delete creds[site];
  await saveUserCredentials(req.user!.id, creds);
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
