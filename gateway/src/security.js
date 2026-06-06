import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { nanoid } from "nanoid";

const cookieName = "live_room_session";

export function hashInvite(invite) {
  return createHash("sha256").update(invite, "utf8").digest("hex");
}

export function verifyInvite(invite, allowedHashes) {
  const digest = Buffer.from(hashInvite(invite), "hex");
  return allowedHashes.some((hash) => {
    const candidate = Buffer.from(hash, "hex");
    return candidate.length === digest.length && timingSafeEqual(candidate, digest);
  });
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

export { cookieName };

