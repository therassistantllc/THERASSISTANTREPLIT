import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";

function getKey(): Buffer {
  const raw = process.env.TELEHEALTH_TOKEN_ENC_KEY ?? null;
  if (!raw) {
    throw new Error(
      "TELEHEALTH_TOKEN_ENC_KEY is not configured. " +
        "Set TELEHEALTH_TOKEN_ENC_KEY (a long random string, e.g. `openssl rand -base64 48`) to encrypt telehealth OAuth tokens at rest.",
    );
  }
  if (raw.length < 24) {
    throw new Error("TELEHEALTH_TOKEN_ENC_KEY must be at least 24 characters of entropy.");
  }
  return createHash("sha256").update(raw).digest();
}

function isTokenEncryptionConfigured(): boolean {
  const raw = process.env.TELEHEALTH_TOKEN_ENC_KEY;
  return typeof raw === "string" && raw.length >= 24;
}
export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptToken(payload: string): string {
  const [version, ivB64, tagB64, ctB64] = payload.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !ctB64) {
    throw new Error("Invalid encrypted token payload");
  }
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const decipher = createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}
