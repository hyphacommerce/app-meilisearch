// Secrets at rest (the app's tokens, its signing secret, the merchant's Meilisearch key)
// are sealed with AES-256-GCM under the app's own key, `APP_ENCRYPTION_KEY` (64 hex
// characters, `openssl rand -hex 32`). The context (the store and the field) is the
// additional data, so a sealed value can't be moved to another row or column.

const VERSION = "v1";

export class Vault {
  readonly #key: Promise<CryptoKey>;

  /** `hexKey`: 32 bytes as 64 hex characters. */
  constructor(hexKey: string) {
    const bytes = parseHexKey(hexKey);
    this.#key = crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
  }

  async seal(plaintext: string, context: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: utf8(context) },
      await this.#key,
      utf8(plaintext),
    );
    return `${VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(sealed))}`;
  }

  /** The plaintext; throws when the value wasn't sealed with this key and context. */
  async open(sealed: string, context: string): Promise<string> {
    const [version, ivPart, dataPart] = sealed.split(".");
    if (version !== VERSION || !ivPart || !dataPart) throw new Error("not a sealed value");
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(ivPart), additionalData: utf8(context) },
      await this.#key,
      fromBase64Url(dataPart),
    );
    return new TextDecoder().decode(plain);
  }
}

export function parseHexKey(hexKey: string): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-fA-F]{64}$/.test(hexKey))
    throw new Error("APP_ENCRYPTION_KEY must be 64 hex characters (openssl rand -hex 32)");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(hexKey.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(text))));
}
