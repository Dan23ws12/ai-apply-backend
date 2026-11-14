/** Zod schemas for sign-out, password reset / change, and per-site job-site logins. */
import { z } from "zod";
import { Password } from "./index.js";

export const PasswordResetRequestBody = z.object({ email: z.email().toLowerCase() });

export const PasswordResetConfirmBody = z.object({
  token: z.string().min(20).max(200),
  newPassword: Password,
});

export const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: Password,
});

/** Job sites a login can be saved for. Accepts "linkedin" or "LINKEDIN". */
export const SiteParams = z.object({
  site: z
    .string()
    .toLowerCase()
    .pipe(z.enum(["linkedin", "glassdoor", "indeed"])),
});

export const SiteLoginBody = z.object({ email: z.email(), password: z.string().min(1).max(256) });
/** Change part of a saved login; a missing field keeps its saved value. */
export const SiteLoginPatchBody = z
  .object({ email: z.email().optional(), password: z.string().min(1).max(256).optional() })
  .refine((v) => v.email !== undefined || v.password !== undefined, "Send email and/or password");
