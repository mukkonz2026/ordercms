import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "./types";
import { getSessionUser, SESSION_COOKIE } from "./session";

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  const user = await getSessionUser(c.env.DB, token);
  if (!user) return c.json({ error: "Not authenticated" }, 401);
  c.set("user", user);
  await next();
});

const MUTATIONS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const sameOrigin = createMiddleware<AppEnv>(async (c, next) => {
  if (!MUTATIONS.has(c.req.method)) return next();
  const origin = c.req.header("origin");
  if (origin) {
    let ok = false;
    try {
      ok = new URL(origin).host === new URL(c.req.url).host;
    } catch {
      ok = false;
    }
    if (!ok) return c.json({ error: "Cross-origin request rejected" }, 403);
  }
  await next();
});

const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;

export async function loginLimited(kv: KVNamespace, ip: string): Promise<boolean> {
  const key = `login:${ip || "unknown"}`;
  const raw = await kv.get(key);
  const data = raw ? (JSON.parse(raw) as { count: number; exp: number }) : { count: 0, exp: Date.now() + WINDOW_MS };
  if (Date.now() > data.exp) return false;
  return data.count >= MAX_ATTEMPTS;
}

export async function recordLoginAttempt(kv: KVNamespace, ip: string, failed: boolean): Promise<void> {
  const key = `login:${ip || "unknown"}`;
  const raw = await kv.get(key);
  const data = raw ? (JSON.parse(raw) as { count: number; exp: number }) : { count: 0, exp: Date.now() + WINDOW_MS };
  if (Date.now() > data.exp) {
    data.count = 0;
    data.exp = Date.now() + WINDOW_MS;
  }
  if (failed) data.count += 1;
  await kv.put(key, JSON.stringify(data), { expirationTtl: Math.max(60, Math.ceil((data.exp - Date.now()) / 1000)) });
}
