import type { Context } from "hono";

export function err(c: Context, status: number, message: string) {
  return c.json({ error: message }, status as 400);
}

export async function readJson<T>(c: Context): Promise<T | null> {
  try {
    const body = await c.req.json<T>();
    return body;
  } catch {
    return null;
  }
}

export interface Page {
  page: number;
  pageSize: number;
  offset: number;
}

export function paging(c: Context, defaultSize = 25, maxSize = 200): Page {
  const p = Math.max(1, Number(c.req.query("page") || 1) || 1);
  const raw = Number(c.req.query("pageSize") || defaultSize) || defaultSize;
  const size = Math.min(maxSize, Math.max(1, raw));
  return { page: p, pageSize: size, offset: (p - 1) * size };
}

export function q(c: Context, key: string): string {
  return (c.req.query(key) || "").trim();
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export function monthStart(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export function clampDate(v: string | undefined, fallback: string = today()): string {
  if (!v) return fallback;
  const s = v.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : fallback;
}

export function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

export function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v).trim();
}

export function pad(n: number, width = 5): string {
  return String(n).padStart(width, "0");
}

export function newToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
