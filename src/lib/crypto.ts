import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

/**
 * AES-256-GCM encryption for job-site credentials stored in users.credentials.
 * The stored value is { v, iv, tag, data } so the key can be rotated later (v = version).
 */
export interface EncryptedEnvelope {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

const key = Buffer.from(env.CREDENTIALS_ENCRYPTION_KEY, "base64");

export function encryptJson(value: unknown): EncryptedEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

export function decryptJson<T>(envelope: EncryptedEnvelope): T {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString("utf8")) as T;
}

export function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "iv" in value &&
    "tag" in value &&
    "data" in value
  );
}

/** Stable hash used to cache answers to application questions. */
export function hashQuestion(question: string): string {
  const normalised = question.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return createHash("sha256").update(normalised).digest("hex");
}
