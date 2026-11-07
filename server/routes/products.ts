import { Hono } from "hono";
import type { AppEnv } from "../types";
import { err, paging, q, readJson, str, num } from "../helpers";
import type { Product, StockMovement } from "../../shared/types";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  const { page, pageSize, offset } = paging(c, 50, 500);
  const search = q(c, "search");
  const status = q(c, "status");
  const lowStock = q(c, "low_stock");

  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (search) {
    clauses.push("(name LIKE ? OR sku LIKE ? OR category LIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (lowStock === "1") clauses.push("stock_qty <= low_stock_threshold");
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) as n FROM products ${where}`)
    .bind(...params)
    .first<{ n: number }>();
  const rows = await c.env.DB.prepare(`SELECT * FROM products ${where} ORDER BY name ASC LIMIT ? OFFSET ?`)
    .bind(...params, pageSize, offset)
    .all<Product>();
  return c.json({ items: rows.results, total: totalRow?.n ?? 0, page, pageSize });
});

app.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const product = await c.env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(id).first<Product>();
  if (!product) return err(c, 404, "Product not found");
  const movements = await c.env.DB.prepare(
    "SELECT * FROM stock_movements WHERE product_id = ? ORDER BY created_at DESC LIMIT 50",
  )
    .bind(id)
    .all<StockMovement>();
  return c.json({ product, movements: movements.results });
});

app.post("/", async (c) => {
  const body = await readJson<Partial<Product>>(c);
  if (!body || !str(body.name)) return err(c, 400, "Product name is required");
  const price = num(body.price);
  const cost = num(body.cost_price);
  if (price < 0 || cost < 0) return err(c, 400, "Prices cannot be negative");

  const res = await c.env.DB.prepare(
    `INSERT INTO products (name, sku, category, description, price, cost_price, stock_qty, low_stock_threshold, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      str(body.name),
      str(body.sku),
      str(body.category),
      str(body.description),
      price,
      cost,
      num(body.stock_qty),
      Math.max(0, num(body.low_stock_threshold ?? 5)),
      str(body.status) === "inactive" ? "inactive" : "active",
    )
    .run();
  const id = Number(res.meta.last_row_id);
  const stock = num(body.stock_qty);
  if (stock !== 0) {
    await c.env.DB.prepare(
      "INSERT INTO stock_movements (product_id, delta, reason, note) VALUES (?, ?, 'opening', 'Opening stock')",
    )
      .bind(id, stock)
      .run();
  }
  const product = await c.env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(id).first<Product>();
  return c.json(product, 201);
});

app.put("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await readJson<Partial<Product>>(c);
  if (!body) return err(c, 400, "Invalid payload");
  const existing = await c.env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(id).first<Product>();
  if (!existing) return err(c, 404, "Product not found");

  const merged = {
    name: "name" in body ? str(body.name) : existing.name,
    sku: "sku" in body ? str(body.sku) : existing.sku,
    category: "category" in body ? str(body.category) : existing.category,
    description: "description" in body ? str(body.description) : existing.description,
    price: "price" in body ? num(body.price) : existing.price,
    cost_price: "cost_price" in body ? num(body.cost_price) : existing.cost_price,
    low_stock_threshold: "low_stock_threshold" in body ? Math.max(0, num(body.low_stock_threshold)) : existing.low_stock_threshold,
    status: "status" in body ? (str(body.status) === "inactive" ? "inactive" : "active") : existing.status,
  };
  if (!merged.name) return err(c, 400, "Product name is required");
  if (merged.price < 0 || merged.cost_price < 0) return err(c, 400, "Prices cannot be negative");

  await c.env.DB.prepare(
    `UPDATE products SET name=?, sku=?, category=?, description=?, price=?, cost_price=?, low_stock_threshold=?, status=?, updated_at=? WHERE id=?`,
  )
    .bind(
      merged.name,
      merged.sku,
      merged.category,
      merged.description,
      merged.price,
      merged.cost_price,
      merged.low_stock_threshold,
      merged.status,
      new Date().toISOString(),
      id,
    )
    .run();

  if ("stock_qty" in body && num(body.stock_qty) !== existing.stock_qty) {
    const delta = num(body.stock_qty) - existing.stock_qty;
    await applyStockChange(c.env.DB, id, delta, "adjustment", "Manual stock correction");
  }
  const product = await c.env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(id).first<Product>();
  return c.json(product);
});

async function applyStockChange(db: D1Database, productId: number, delta: number, reason: string, note: string, orderId?: number) {
  await db
    .prepare("UPDATE products SET stock_qty = stock_qty + ?, updated_at = ? WHERE id = ?")
    .bind(delta, new Date().toISOString(), productId)
    .run();
  await db
    .prepare("INSERT INTO stock_movements (product_id, delta, reason, order_id, note) VALUES (?, ?, ?, ?, ?)")
    .bind(productId, delta, reason, orderId ?? null, note)
    .run();
}

app.post("/:id/stock", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await readJson<{ delta?: number; reason?: string; note?: string }>(c);
  if (!body) return err(c, 400, "Invalid payload");
  const delta = num(body.delta);
  if (delta === 0) return err(c, 400, "Stock change must be non-zero");
  const product = await c.env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(id).first<Product>();
  if (!product) return err(c, 404, "Product not found");
  if (product.stock_qty + delta < 0) return err(c, 400, "Stock cannot go below zero");
  await applyStockChange(c.env.DB, id, delta, str(body.reason) || "adjustment", str(body.note));
  const updated = await c.env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(id).first<Product>();
  return c.json(updated);
});

app.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const product = await c.env.DB.prepare("SELECT id FROM products WHERE id = ?").bind(id).first();
  if (!product) return err(c, 404, "Product not found");
  await c.env.DB.prepare("DELETE FROM products WHERE id = ?").bind(id).run();
  return c.body(null, 204);
});

export { applyStockChange };
export default app;
