import { prisma } from "../lib/prisma.js";
import { Prisma } from "../generated/prisma/client.js";
import { decryptJson, encryptJson, isEncryptedEnvelope } from "../lib/crypto.js";

export interface SiteLogin {
  email: string;
  password: string;
}
export type CredentialSite = "linkedin" | "glassdoor" | "indeed";
export type UserCredentials = Partial<Record<CredentialSite, SiteLogin>>;

/** Decrypts users.credentials. Returns {} when nothing is saved. */
export async function getUserCredentials(userId: string): Promise<UserCredentials> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { credentials: true } });
  if (!user.credentials || !isEncryptedEnvelope(user.credentials)) return {};
  return decryptJson<UserCredentials>(user.credentials);
}

/** Saves the logins encrypted; an empty object clears the column. */
export async function saveUserCredentials(userId: string, creds: UserCredentials): Promise<void> {
  const clean = Object.fromEntries(Object.entries(creds).filter(([, v]) => v)) as UserCredentials;
  await prisma.user.update({
    where: { id: userId },
    data: { credentials: Object.keys(clean).length ? (encryptJson(clean) as object) : Prisma.DbNull },
  });
}

/** Which sites have a saved login (never the password). */
export function connectedSites(creds: UserCredentials) {
  return Object.fromEntries(
    Object.entries(creds)
      .filter(([, c]) => c)
      .map(([site, c]) => [site, { email: c!.email, hasPassword: !!c!.password }]),
  );
}
