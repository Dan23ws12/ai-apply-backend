import { prisma } from "../lib/prisma.js";
import { decryptJson, isEncryptedEnvelope } from "../lib/crypto.js";

export interface SiteLogin {
  email: string;
  password: string;
}
export interface UserCredentials {
  linkedin?: SiteLogin;
  glassdoor?: SiteLogin;
}

/** Decrypts users.credentials. Returns {} when nothing is saved. */
export async function getUserCredentials(userId: string): Promise<UserCredentials> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { credentials: true } });
  if (!user.credentials || !isEncryptedEnvelope(user.credentials)) return {};
  return decryptJson<UserCredentials>(user.credentials);
}
