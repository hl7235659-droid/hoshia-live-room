import type { Session } from "./types";

const introStorageKey = "hoshia:lastRegisteredUsername";
const autoLoginStorageKey = "hoshia:autoLogin:v1";

export function normalizeAuthName(value: string | undefined) {
  return String(value || "").trim().toLowerCase();
}

export function rememberRegisteredUsername(username: string) {
  try {
    window.sessionStorage.setItem(introStorageKey, normalizeAuthName(username));
  } catch {
    // Session storage is only a UI hint. Login remains functional without it.
  }
}

export function shouldPlayAwakeningForUser(user: Session) {
  try {
    const remembered = window.sessionStorage.getItem(introStorageKey);
    const username = normalizeAuthName(user.username || user.nickname);
    if (!remembered || remembered !== username) return false;
    window.sessionStorage.removeItem(introStorageKey);
    return true;
  } catch {
    return false;
  }
}

export type AutoLoginRecord = {
  enabled: boolean;
  username: string;
  password: string;
};

export function loadAutoLoginRecord(): AutoLoginRecord | null {
  try {
    const raw = window.localStorage.getItem(autoLoginStorageKey);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<AutoLoginRecord>;
    if (!value?.enabled || typeof value.username !== "string" || typeof value.password !== "string") return null;
    return {
      enabled: true,
      username: value.username,
      password: value.password
    };
  } catch {
    return null;
  }
}

export function saveAutoLoginRecord(username: string, password: string) {
  try {
    window.localStorage.setItem(autoLoginStorageKey, JSON.stringify({
      enabled: true,
      username,
      password
    } satisfies AutoLoginRecord));
  } catch {
    // Auto login is optional. Login still succeeds when local storage is unavailable.
  }
}

export function clearAutoLoginRecord() {
  try {
    window.localStorage.removeItem(autoLoginStorageKey);
  } catch {
    // Ignore unavailable local storage.
  }
}
