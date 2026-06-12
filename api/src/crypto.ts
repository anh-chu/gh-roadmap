// At-rest encryption for stored user GitHub tokens — AES-256-GCM keyed by TOKEN_ENC_KEY.
// The key may be hex (64 chars) or base64; it must decode to exactly 32 bytes.
// Ciphertext format: iv:tag:ciphertext (hex parts).
import crypto from "node:crypto";

const RAW_KEY = (process.env.TOKEN_ENC_KEY ?? "").trim();

export function tokenEncKeySet(): boolean {
  return RAW_KEY.length > 0;
}

// Decode the key, or null when unset/undecodable/wrong-length. Validated at boot only when
// GitHub OAuth is enabled — a malformed value must not break the zero-friction localhost path.
function decodeKey(): Buffer | null {
  if (!RAW_KEY) return null;
  if (/^[0-9a-fA-F]{64}$/.test(RAW_KEY)) return Buffer.from(RAW_KEY, "hex");
  try {
    const b = Buffer.from(RAW_KEY, "base64");
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

function key(): Buffer {
  const k = decodeKey();
  if (!k) throw new Error("TOKEN_ENC_KEY missing or invalid (must decode to 32 bytes)");
  return k;
}

export function encryptToken(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decryptToken(stored: string): string {
  const [ivHex, tagHex, encHex] = stored.split(":");
  if (!ivHex || !tagHex || !encHex) throw new Error("malformed encrypted token");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(encHex, "hex")), decipher.final()]).toString("utf8");
}

// Boot self-test: key decodes to 32 bytes and a round-trip works. Throws on failure.
export function assertTokenEncKeyValid(): void {
  if (!decodeKey()) {
    throw new Error("TOKEN_ENC_KEY must be 32 bytes, hex (64 chars) or base64 encoded");
  }
  const probe = "token-enc-self-test";
  if (decryptToken(encryptToken(probe)) !== probe) {
    throw new Error("TOKEN_ENC_KEY self-test failed (encrypt→decrypt mismatch)");
  }
}
