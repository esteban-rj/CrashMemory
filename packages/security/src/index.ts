import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 5;
const SCRYPT_KEY_LENGTH = 32;
const REDACTED = "[REDACTED]";
const SECRET_KEYS = new Set([
  "authorization",
  "cookie",
  "password",
  "passwordhash",
  "refreshtoken",
  "accesstoken",
  "clientsecret",
  "token",
  "csrftoken",
  "ciphertext",
]);

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      SCRYPT_KEY_LENGTH,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

export function normalizeEmail(email: string): string {
  const normalized = email.normalize("NFKC").trim().toLowerCase();
  if (
    normalized.length < 3 ||
    normalized.length > 320 ||
    !normalized.includes("@")
  ) {
    throw new Error("Invalid email address");
  }
  return normalized;
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 256) {
    throw new Error("Password must contain between 12 and 256 characters");
  }
  const salt = randomBytes(16);
  const digest = await scryptAsync(password, salt);
  return [
    "scrypt",
    "v1",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    digest.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  if (password.length === 0 || password.length > 256) return false;
  const [algorithm, version, n, r, p, saltText, digestText] =
    encoded.split("$");
  if (
    algorithm !== "scrypt" ||
    version !== "v1" ||
    Number(n) !== SCRYPT_N ||
    Number(r) !== SCRYPT_R ||
    Number(p) !== SCRYPT_P ||
    !saltText ||
    !digestText
  ) {
    return false;
  }
  const expected = Buffer.from(digestText, "base64url");
  const actual = await scryptAsync(
    password,
    Buffer.from(saltText, "base64url"),
  );
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function safeTokenEqual(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashOpaqueToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface EncryptedSecret {
  keyVersion: string;
  iv: string;
  ciphertext: string;
  authTag: string;
}

export class CredentialCipher {
  readonly #activeVersion: string;
  readonly #keys: ReadonlyMap<string, Buffer>;

  constructor(activeVersion: string, keys: ReadonlyMap<string, Buffer>) {
    const active = keys.get(activeVersion);
    if (!active || active.length !== 32) {
      throw new Error("Active credential encryption key must contain 32 bytes");
    }
    for (const key of keys.values()) {
      if (key.length !== 32)
        throw new Error("Credential encryption keys must contain 32 bytes");
    }
    this.#activeVersion = activeVersion;
    this.#keys = keys;
  }

  static fromEnvironment(
    encodedKeyring: string | undefined,
    activeVersion: string | undefined,
  ): CredentialCipher {
    if (!encodedKeyring || !activeVersion) {
      throw new Error("Credential encryption keyring is not configured");
    }
    const parsed = JSON.parse(encodedKeyring) as Record<string, unknown>;
    const keys = new Map<string, Buffer>();
    for (const [version, encoded] of Object.entries(parsed)) {
      if (typeof encoded !== "string")
        throw new Error("Invalid credential keyring");
      keys.set(version, Buffer.from(encoded, "base64"));
    }
    return new CredentialCipher(activeVersion, keys);
  }

  encrypt(secret: string, context: string): EncryptedSecret {
    const key = this.#keys.get(this.#activeVersion);
    if (!key)
      throw new Error("Active credential encryption key is unavailable");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(secret, "utf8"),
      cipher.final(),
    ]);
    return {
      keyVersion: this.#activeVersion,
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    };
  }

  decrypt(secret: EncryptedSecret, context: string): string {
    const key = this.#keys.get(secret.keyVersion);
    if (!key)
      throw new Error("Credential encryption key version is unavailable");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(secret.iv, "base64"),
    );
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(Buffer.from(secret.authTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(secret.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }
}

export interface OAuthState {
  userId: string;
  sessionId: string;
  provider: "gmail";
  redirectPath: string;
  nonce: string;
  expiresAt: number;
}

export class OAuthStateSigner {
  readonly #secret: Buffer;

  constructor(secret: Buffer) {
    if (secret.length < 32)
      throw new Error("OAuth state secret must contain at least 32 bytes");
    this.#secret = secret;
  }

  issue(input: OAuthState): string {
    if (!isSafeLocalPath(input.redirectPath) || input.nonce.length < 32) {
      throw new Error("OAuth redirect must be a local absolute path");
    }
    const payload = Buffer.from(JSON.stringify(input), "utf8").toString(
      "base64url",
    );
    const signature = createHmac("sha256", this.#secret)
      .update(payload)
      .digest("base64url");
    return `${payload}.${signature}`;
  }

  verify(value: string, now = Date.now()): OAuthState {
    const [payload, signature, extra] = value.split(".");
    if (!payload || !signature || extra) throw new Error("Invalid OAuth state");
    const expected = createHmac("sha256", this.#secret)
      .update(payload)
      .digest();
    const actual = Buffer.from(signature, "base64url");
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      throw new Error("Invalid OAuth state");
    }
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as OAuthState;
    if (
      parsed.provider !== "gmail" ||
      typeof parsed.userId !== "string" ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.nonce !== "string" ||
      typeof parsed.expiresAt !== "number" ||
      typeof parsed.redirectPath !== "string" ||
      !isSafeLocalPath(parsed.redirectPath) ||
      parsed.expiresAt <= now
    ) {
      throw new Error("Invalid or expired OAuth state");
    }
    return parsed;
  }
}

function isSafeLocalPath(value: string): boolean {
  const hasControlCharacter = [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    hasControlCharacter
  ) {
    return false;
  }
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith("//") || decoded.includes("\\")) return false;
    return (
      new URL(value, "https://crashmemory.invalid").origin ===
      "https://crashmemory.invalid"
    );
  } catch {
    return false;
  }
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SECRET_KEYS.has(key.replaceAll(/[-_]/g, "").toLowerCase())
          ? REDACTED
          : redactSecrets(child),
      ]),
    );
  }
  return value;
}

export const FASTIFY_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.body.password",
  "req.body.accessToken",
  "req.body.refreshToken",
  "res.headers.set-cookie",
] as const;

interface LogRequestLike {
  id?: unknown;
  method?: unknown;
  url?: unknown;
}

interface LogErrorLike {
  name?: unknown;
  code?: unknown;
}

export function safeRequestSerializer(
  request: unknown,
): Record<string, string> {
  const input =
    request && typeof request === "object" ? (request as LogRequestLike) : {};
  const rawUrl = typeof input.url === "string" ? input.url : "/";
  return {
    id: typeof input.id === "string" ? input.id : "unknown",
    method: typeof input.method === "string" ? input.method : "UNKNOWN",
    path: rawUrl.split("?", 1)[0] || "/",
  };
}

export function safeErrorSerializer(error: unknown): Record<string, string> {
  const input =
    error && typeof error === "object" ? (error as LogErrorLike) : {};
  const type =
    typeof input.name === "string" && /^[A-Za-z]+Error$/.test(input.name)
      ? input.name
      : "Error";
  const code =
    typeof input.code === "string" && /^[A-Z0-9_]{2,20}$/.test(input.code)
      ? input.code
      : "INTERNAL_ERROR";
  return { type, code };
}
