import type { HoshiaPost } from "./types";

const appBase = import.meta.env.BASE_URL || "/";

export function appPath(path: string) {
  const base = appBase.endsWith("/") ? appBase : `${appBase}/`;
  return `${base}${path.replace(/^\/+/, "")}`;
}

export async function fetchHoshiaPosts() {
  const payload = await fetch(appPath("api/hoshia/posts")).then((res) => (res.ok ? res.json() : null));
  return Array.isArray(payload?.posts) ? payload.posts as HoshiaPost[] : [];
}

export function wsPath(path: string) {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}${appPath(path)}`;
}
