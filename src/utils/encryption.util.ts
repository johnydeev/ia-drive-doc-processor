import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const PREFIX = "enc:";

function getKey(): Buffer {
  const raw =
    process.env.GOOGLE_CREDENTIALS_ENCRYPTION_KEY ??
    process.env.SESSION_SECRET;
  if (!raw || raw.trim().length === 0) {
    throw new Error(
      "GOOGLE_CREDENTIALS_ENCRYPTION_KEY or SESSION_SECRET is required to encrypt/decrypt Google credentials"
    );
  }

  return createHash("sha256").update(raw, "utf8").digest();
}

export function encrypt(text: string): string {
  if (!text) {
    return text;
  }

  if (text.startsWith(PREFIX)) {
    return text;
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

export function decrypt(text: string): string {
  if (!text || !text.startsWith(PREFIX)) {
    return text;
  }

  const payload = text.slice(PREFIX.length);
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Invalid encrypted value format");
  }

  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");

  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);

  return decrypted.toString("utf8");
}
