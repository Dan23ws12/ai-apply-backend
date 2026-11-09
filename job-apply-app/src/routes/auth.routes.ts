import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import { HttpError } from "../lib/errors.js";
import { requireAuth, signToken } from "../middleware/auth.js";
import { body, validate } from "../middleware/validate.js";
import { LoginBody, RegisterBody } from "../schemas/index.js";
import { audit } from "../services/audit.service.js";

export const authRouter = Router();

const publicUser = { id: true, firstName: true, lastName: true, email: true, createdAt: true, updatedAt: true } as const;

authRouter.post("/register", validate({ body: RegisterBody }), async (req, res) => {
  const data = body(req, RegisterBody);
  const existing = await prisma.user.findUnique({ where: { email: data.email } });
  if (existing) throw new HttpError(409, "An account with this email already exists");

  const user = await prisma.user.create({
    data: {
      firstName: data.firstName,
      lastName: data.lastName,
      email: data.email,
      passwordHash: await bcrypt.hash(data.password, 12),
      profile: { create: {} },
    },
    select: publicUser,
  });
  audit({ type: "AUTH", userId: user.id, requestId: req.requestId, message: "register" });
  res.status(201).json({ user, token: signToken(user) });
});

authRouter.post("/login", validate({ body: LoginBody }), async (req, res) => {
  const { email, password } = body(req, LoginBody);
  const user = await prisma.user.findUnique({ where: { email } });
  const ok = user ? await bcrypt.compare(password, user.passwordHash) : false;

  audit({
    type: "AUTH",
    userId: user?.id,
    requestId: req.requestId,
    message: ok ? "login success" : "login failed",
    metadata: { email },
  });
  if (!user || !ok) throw new HttpError(401, "Email or password is incorrect");

  res.json({
    user: { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email },
    token: signToken(user),
  });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: publicUser });
  res.json({ user });
});
