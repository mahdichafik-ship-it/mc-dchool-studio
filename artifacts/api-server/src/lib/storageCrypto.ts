import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

type Envelope = {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
};

function encryptionKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters to protect storage credentials");
  }
  return createHash("sha256").update(`mc-school-studio:storage:v1:${secret}`).digest();
}

export function encryptStorageValue(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  const envelope: Envelope = {
    version: 1,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
  return JSON.stringify(envelope);
}

export function decryptStorageValue<T>(encrypted: string): T {
  const envelope = JSON.parse(encrypted) as Envelope;
  if (envelope.version !== 1) throw new Error("Unsupported storage credential version");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(envelope.iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}