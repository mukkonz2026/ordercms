import { Hono } from "hono";
import type { AppEnv } from "../types";
import { err, paging, q, readJson, str, num } from "../helpers";
import type { Customer, Paged } from "../../shared/types";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  const { page, pageSize, offset } = paging(c);
  const search = q(c, "search");
  const where = search
    ? "WHERE name LIKE ? OR phone LIKE ? OR email LIKE ? OR city LIKE ?"
    : "";
  const like = `%${search}%`;
  const params = search ? [like, like, like, like] : [];

  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) as n FROM customers ${where}`)
    .bind(...params)
    .first<{ n: number }>();
  const rows = await c.env.DB.prepare(
    `SELECT * FROM customers ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...params, pageSize, offset)
    .all<Customer>();

  const body: Paged<Customer> = {
    items: rows.results,
    total: totalRow?.n ?? 0,
    page,
    pageSize,
  };
  return c.json(body);
});

app.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const customer = await c.env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(id).first<Customer>();
  if (!customer) return err(c, 404, "Customer not found");
  const stats = await c.env.DB.prepare(
    `SELECT COUNT(*) as orders, COALESCE(SUM(CASE WHEN status NOT IN ('cancelled','returned') THEN total ELSE 0 END),0) as spend
     FROM orders WHERE customer_id = ?`,
  )
    .bind(id)
    .first<{ orders: number; spend: number }>();
  const orders = await c.env.DB.prepare(
    "SELECT id, order_number, status, total, payment_status, source, placed_at FROM orders WHERE customer_id = ? ORDER BY placed_at DESC LIMIT 50",
  )
    .bind(id)
    .all();
  return c.json({ customer, stats, orders: orders.results });
});

app.post("/", async (c) => {
  const body = await readJson<Partial<Customer>>(c);
  if (!body || !str(body.name)) return err(c, 400, "Customer name is required");
  const res = await c.env.DB.prepare(
    `INSERT INTO customers (name, phone, email, address_line1, address_line2, city, state, pincode, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      str(body.name),
      str(body.phone),
      str(body.email),
      str(body.address_line1),
      str(body.address_line2),
      str(body.city),
      str(body.state),
      str(body.pincode),
      str(body.notes),
    )
    .run();
  const customer = await c.env.DB.prepare("SELECT * FROM customers WHERE id = ?")
    .bind(res.meta.last_row_id)
    .first<Customer>();
  return c.json(customer, 201);
});

app.put("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await readJson<Partial<Customer>>(c);
  if (!body) return err(c, 400, "Invalid payload");
  const existing = await c.env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(id).first<Customer>();
  if (!existing) return err(c, 404, "Customer not found");
  if ("name" in body && !str(body.name)) return err(c, 400, "Customer name is required");

  const merged = {
    name: "name" in body ? str(body.name) : existing.name,
    phone: "phone" in body ? str(body.phone) : existing.phone,
    email: "email" in body ? str(body.email) : existing.email,
    address_line1: "address_line1" in body ? str(body.address_line1) : existing.address_line1,
    address_line2: "address_line2" in body ? str(body.address_line2) : existing.address_line2,
    city: "city" in body ? str(body.city) : existing.city,
    state: "state" in body ? str(body.state) : existing.state,
    pincode: "pincode" in body ? str(body.pincode) : existing.pincode,
    notes: "notes" in body ? str(body.notes) : existing.notes,
  };
  await c.env.DB.prepare(
    `UPDATE customers SET name=?, phone=?, email=?, address_line1=?, address_line2=?, city=?, state=?, pincode=?, notes=?, updated_at=? WHERE id=?`,
  )
    .bind(
      merged.name,
      merged.phone,
      merged.email,
      merged.address_line1,
      merged.address_line2,
      merged.city,
      merged.state,
      merged.pincode,
      merged.notes,
      new Date().toISOString(),
      id,
    )
    .run();
  const customer = await c.env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(id).first<Customer>();
  return c.json(customer);
});

app.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const orders = await c.env.DB.prepare("SELECT COUNT(*) as n FROM orders WHERE customer_id = ?")
    .bind(id)
    .first<{ n: number }>();
  if ((orders?.n ?? 0) > 0) {
    return err(c, 409, "Customer has orders and cannot be deleted");
  }
  await c.env.DB.prepare("DELETE FROM customers WHERE id = ?").bind(id).run();
  return c.body(null, 204);
});

export default app;
