import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { nanoid } from "nanoid";

const cookieName = "live_room_session";
const gateCookieName = "live_room_gate";
const passwordHashVersion = "scrypt-v1";

export function normalizeAccessCode(code) {
  return String(code || "").trim().toUpperCase();
}

export function hashAccessCode(code) {
  return createHash("sha256").update(normalizeAccessCode(code), "utf8").digest("hex");
}

export function hashInvite(invite) {
  return createHash("sha256").update(invite, "utf8").digest("hex");
}

export function verifyAccessCode(code, allowedHashes) {
  const digests = [hashAccessCode(code), hashInvite(String(code || ""))].map((hash) => Buffer.from(hash, "hex"));
  return allowedHashes.some((hash) => {
    const candidate = Buffer.from(hash, "hex");
    return digests.some((digest) => candidate.length === digest.length && timingSafeEqual(candidate, digest));
  });
}

export function verifyInvite(invite, allowedHashes) {
  return verifyAccessCode(invite, allowedHashes);
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const derived = scryptSync(String(password), salt, 64).toString("base64url");
  return `${passwordHashVersion}$${salt}$${derived}`;
}

export function verifyPassword(password, storedHash) {
  const [version, salt, expected] = String(storedHash || "").split("$");
  if (version !== passwordHashVersion || !salt || !expected) return false;
  const derived = scryptSync(String(password), salt, 64);
  const candidate = Buffer.from(derived.toString("base64url"));
  const known = Buffer.from(expected);
  return candidate.length === known.length && timingSafeEqual(candidate, known);
}

export function signSessionId(sessionId, secret) {
  return createHmac("sha256", secret).update(sessionId).digest("base64url");
}

export function encodeSessionCookie(sessionId, secret) {
  return `${sessionId}.${signSessionId(sessionId, secret)}`;
}

export function decodeSessionCookie(value, secret) {
  if (!value) return null;
  const [sessionId, signature] = value.split(".");
  if (!sessionId || !signature) return null;
  const expected = signSessionId(sessionId, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return sessionId;
}

export function newSessionId() {
  return nanoid(32);
}

export { cookieName, gateCookieName };
