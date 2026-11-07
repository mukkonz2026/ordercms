import type { User } from "../shared/types";
import { newToken } from "./helpers";

const ITERATIONS = 100000;
const SESSION_DAYS = 7;

export async function hashPassword(password: string, saltHex?: string): Promise<{ hash: string; salt: string }> {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey("raw", enc(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations: ITERATIONS, hash: "SHA-256" },
    key,
    256,
  );
  return { hash: bytesToHex(new Uint8Array(bits)), salt: bytesToHex(salt) };
}

export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  const { hash: candidate } = await hashPassword(password, salt);
  return timingSafeEqual(candidate, hash);
}

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createSession(db: D1Database, userId: number): Promise<{ token: string; expires: Date }> {
  const token = newToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  await db
    .prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(token, userId, expires.toISOString())
    .run();
  return { token, expires };
}

export async function getSessionUser(db: D1Database, token: string | undefined): Promise<User | null> {
  if (!token) return null;
  const row = await db
    .prepare(
      `SELECT u.id, u.username, u.full_name, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ?`,
    )
    .bind(token, new Date().toISOString())
    .first<{ id: number; username: string; full_name: string }>();
  if (!row) return null;
  return { id: row.id, username: row.username, full_name: row.full_name };
}

export async function destroySession(db: D1Database, token: string | undefined) {
  if (!token) return;
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(token).run();
}

export async function purgeExpiredSessions(db: D1Database) {
  await db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(new Date().toISOString()).run();
}

export const SESSION_COOKIE = "mukkonz_session";
