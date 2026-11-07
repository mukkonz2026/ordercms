import { Hono } from "hono";
import type { AppEnv } from "../types";
import { err, paging, q, readJson, str, num, clampDate } from "../helpers";
import type { Payment, Paged } from "../../shared/types";
import { recomputePaymentStatus } from "./orders";

const app = new Hono<AppEnv>();

const TYPES = ["payment", "refund", "cod_collection", "adjustment"];
const METHODS = ["cash", "upi", "bank", "card", "cheque", "razorpay", "other"];

app.get("/", async (c) => {
  const { page, pageSize, offset } = paging(c);
  const type = q(c, "type");
  const method = q(c, "method");
  const orderId = q(c, "order_id");
  const from = q(c, "from");
  const to = q(c, "to");

  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (type) {
    clauses.push("p.type = ?");
    params.push(type);
  }
  if (method) {
    clauses.push("p.method = ?");
    params.push(method);
  }
  if (orderId) {
    clauses.push("p.order_id = ?");
    params.push(Number(orderId));
  }
  if (from) {
    clauses.push("p.paid_at >= ?");
    params.push(`${from}T00:00:00.000Z`);
  }
  if (to) {
    clauses.push("p.paid_at <= ?");
    params.push(`${to}T23:59:59.999Z`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) as n FROM payments p ${where}`)
    .bind(...params)
    .first<{ n: number }>();
  const rows = await c.env.DB.prepare(
    `SELECT p.*, o.order_number,
       CASE WHEN p.type IN ('payment','cod_collection') THEN p.amount ELSE -p.amount END as signed
     FROM payments p LEFT JOIN orders o ON o.id = p.order_id
     ${where}
     ORDER BY p.paid_at DESC, p.id DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(...params, pageSize, offset)
    .all<Payment>();
  const sums = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN type IN ('payment','cod_collection') THEN amount ELSE -amount END),0) as net
     FROM payments p ${where}`,
  )
    .bind(...params)
    .first<{ net: number }>();
  return c.json({ items: rows.results, total: totalRow?.n ?? 0, page, pageSize, net: sums?.net ?? 0 });
});

app.post("/", async (c) => {
  const body = await readJson<Partial<Payment>>(c);
  if (!body) return err(c, 400, "Invalid payload");
  const amount = num(body.amount);
  if (amount <= 0) return err(c, 400, "Amount must be greater than zero");
  const type = str(body.type) || "payment";
  if (!TYPES.includes(type)) return err(c, 400, "Invalid payment type");
  const orderId = body.order_id ? num(body.order_id) : null;
  if (orderId) {
    const order = await c.env.DB.prepare("SELECT id FROM orders WHERE id = ?").bind(orderId).first();
    if (!order) return err(c, 404, "Order not found");
  }
  const res = await c.env.DB.prepare(
    `INSERT INTO payments (order_id, type, method, amount, reference, paid_at, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      orderId,
      type,
      str(body.method) || "cash",
      amount,
      str(body.reference),
      str(body.paid_at) ? `${clampDate(str(body.paid_at))}T12:00:00.000Z` : new Date().toISOString(),
      str(body.notes),
    )
    .run();
  if (orderId) await recomputePaymentStatus(c.env.DB, orderId);
  const row = await c.env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(res.meta.last_row_id).first();
  return c.json(row, 201);
});

app.put("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await readJson<Partial<Payment>>(c);
  if (!body) return err(c, 400, "Invalid payload");
  const existing = await c.env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(id).first<Payment>();
  if (!existing) return err(c, 404, "Payment not found");
  const amount = "amount" in body ? num(body.amount) : existing.amount;
  if (amount <= 0) return err(c, 400, "Amount must be greater than zero");
  const type = "type" in body ? str(body.type) || existing.type : existing.type;
  if (!TYPES.includes(type)) return err(c, 400, "Invalid payment type");
  await c.env.DB.prepare(
    "UPDATE payments SET type=?, method=?, amount=?, reference=?, paid_at=?, notes=? WHERE id=?",
  )
    .bind(
      type,
      "method" in body ? str(body.method) || existing.method : existing.method,
      amount,
      "reference" in body ? str(body.reference) : existing.reference,
      "paid_at" in body && str(body.paid_at) ? `${clampDate(str(body.paid_at))}T12:00:00.000Z` : existing.paid_at,
      "notes" in body ? str(body.notes) : existing.notes,
      id,
    )
    .run();
  if (existing.order_id) await recomputePaymentStatus(c.env.DB, existing.order_id);
  const row = await c.env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(id).first();
  return c.json(row);
});

app.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const existing = await c.env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(id).first<Payment>();
  if (!existing) return err(c, 404, "Payment not found");
  await c.env.DB.prepare("DELETE FROM payments WHERE id = ?").bind(id).run();
  if (existing.order_id) await recomputePaymentStatus(c.env.DB, existing.order_id);
  return c.body(null, 204);
});

export default app;
