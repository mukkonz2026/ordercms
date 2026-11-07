import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import type { AppEnv } from "../types";
import { createSession, destroySession, hashPassword, verifyPassword, SESSION_COOKIE } from "../session";
import { loginLimited, recordLoginAttempt, requireAuth } from "../middleware";
import { err, readJson, str } from "../helpers";

const app = new Hono<AppEnv>();

const ALLOWED_SETTINGS = [
  "business_name",
  "business_address",
  "business_phone",
  "business_email",
  "business_gstin",
  "invoice_prefix",
  "order_prefix",
];

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

app.post("/login", async (c) => {
  const ip = clientIp(c);
  if (await loginLimited(c.env.LIMITS, ip)) {
    return err(c, 429, "Too many login attempts. Try again later.");
  }
  const body = await readJson<{ username?: string; password?: string }>(c);
  if (!body || !str(body.username) || !str(body.password)) return err(c, 400, "Username and password are required");

  const user = await c.env.DB.prepare("SELECT id, username, password_hash, salt, full_name FROM users WHERE username = ?")
    .bind(str(body.username).toLowerCase())
    .first<{ id: number; username: string; password_hash: string; salt: string; full_name: string }>();

  const ok = user ? await verifyPassword(str(body.password), user.password_hash, user.salt) : false;
  if (!user || !ok) {
    await recordLoginAttempt(c.env.LIMITS, ip, true);
    return err(c, 401, "Invalid username or password");
  }
  await recordLoginAttempt(c.env.LIMITS, ip, false);

  const { token, expires } = await createSession(c.env.DB, user.id);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:",
    path: "/",
    expires,
  });
  return c.json({ user: { id: user.id, username: user.username, full_name: user.full_name } });
});

app.post("/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  await destroySession(c.env.DB, token);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.body(null, 204);
});

app.get("/me", requireAuth, (c) => c.json({ user: c.get("user") }));

app.post("/password", requireAuth, async (c) => {
  const body = await readJson<{ current_password?: string; new_password?: string }>(c);
  if (!body || !str(body.current_password) || !str(body.new_password)) {
    return err(c, 400, "Current and new password are required");
  }
  if (str(body.new_password).length < 8) return err(c, 400, "New password must be at least 8 characters");

  const user = await c.env.DB.prepare("SELECT id, password_hash, salt FROM users WHERE id = ?")
    .bind(c.get("user").id)
    .first<{ id: number; password_hash: string; salt: string }>();
  if (!user) return err(c, 404, "User not found");
  if (!(await verifyPassword(str(body.current_password), user.password_hash, user.salt))) {
    return err(c, 401, "Current password is incorrect");
  }
  const { hash, salt } = await hashPassword(str(body.new_password));
  await c.env.DB.prepare("UPDATE users SET password_hash = ?, salt = ?, updated_at = ? WHERE id = ?")
    .bind(hash, salt, new Date().toISOString(), user.id)
    .run();
  await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id).run();
  const { token, expires } = await createSession(c.env.DB, user.id);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:",
    path: "/",
    expires,
  });
  return c.json({ ok: true });
});

app.get("/settings", async (c) => {
  const rows = await c.env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const out: Record<string, string> = {};
  for (const r of rows.results) out[r.key] = r.value;
  return c.json(out);
});

app.put("/settings", requireAuth, async (c) => {
  const body = await readJson<Record<string, string>>(c);
  if (!body) return err(c, 400, "Invalid payload");
  const now = new Date().toISOString();
  const stmt = c.env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  );
  const batch = [];
  for (const key of ALLOWED_SETTINGS) {
    if (key in body) batch.push(stmt.bind(key, str(body[key]), now));
  }
  if (batch.length === 0) return err(c, 400, "No valid settings provided");
  await c.env.DB.batch(batch);
  const rows = await c.env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const out: Record<string, string> = {};
  for (const r of rows.results) out[r.key] = r.value;
  return c.json(out);
});

export default app;
