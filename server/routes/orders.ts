import { Hono } from "hono";
import type { AppEnv } from "../types";
import { err, paging, q, readJson, str, num, pad } from "../helpers";
import type { Order, OrderItem, Paged, PaymentStatus } from "../../shared/types";
import { applyStockChange } from "./products";

const app = new Hono<AppEnv>();

const ACTIVE_STATUSES = ["pending", "confirmed", "packed", "shipped", "delivered"];

function lineTotal(item: { unit_price: number; quantity: number }): number {
  return Math.max(0, Math.round(item.unit_price)) * Math.max(1, Math.round(item.quantity));
}

async function getOrderNumber(db: D1Database): Promise<string> {
  const setting = await db.prepare("SELECT value FROM settings WHERE key = 'order_prefix'").first<{ value: string }>();
  const prefix = (setting?.value || "MK").toUpperCase();
  const row = await db.prepare("SELECT COALESCE(MAX(id), 0) + 1 as n FROM orders").first<{ n: number }>();
  return `${prefix}-${pad(row?.n ?? 1, 5)}`;
}

async function recomputePaymentStatus(db: D1Database, orderId: number) {
  const order = await db.prepare("SELECT id, total, status FROM orders WHERE id = ?").bind(orderId).first<Order>();
  if (!order) return;
  const sums = await db
    .prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN type IN ('payment','cod_collection') THEN amount ELSE 0 END),0) as inflow,
        COALESCE(SUM(CASE WHEN type = 'refund' THEN amount ELSE 0 END),0) as refund
       FROM payments WHERE order_id = ?`,
    )
    .bind(orderId)
    .first<{ inflow: number; refund: number }>();
  const inflow = sums?.inflow ?? 0;
  const refund = sums?.refund ?? 0;
  let status: PaymentStatus = "unpaid";
  if (refund > 0 && inflow <= refund) status = "refunded";
  else if (inflow >= order.total && order.total > 0) status = "paid";
  else if (inflow > 0) status = "partial";
  else status = "unpaid";
  await db.prepare("UPDATE orders SET payment_status = ?, updated_at = ? WHERE id = ?").bind(status, new Date().toISOString(), orderId).run();
}

async function loadItems(db: D1Database, orderId: number): Promise<OrderItem[]> {
  const rows = await db.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id").bind(orderId).all<OrderItem>();
  return rows.results;
}

/** Reverse the stock impact of existing items, then apply the impact of new items. */
async function replaceItems(
  db: D1Database,
  orderId: number,
  oldItems: OrderItem[],
  newItems: OrderItem[],
  status: string,
) {
  const applies = ACTIVE_STATUSES.includes(status);
  if (applies) {
    for (const it of oldItems) {
      if (it.product_id) await applyStockChange(db, it.product_id, it.quantity, "order_edit_reverse", `Order #${orderId} edited`, orderId);
    }
  }
  await db.prepare("DELETE FROM order_items WHERE order_id = ?").bind(orderId).run();
  for (const it of newItems) {
    await db
      .prepare(
        `INSERT INTO order_items (order_id, product_id, product_name, sku, unit_price, unit_cost, quantity, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(orderId, it.product_id, it.product_name, it.sku, it.unit_price, it.unit_cost, it.quantity, it.line_total)
      .run();
    if (applies && it.product_id) {
      await applyStockChange(db, it.product_id, -it.quantity, "order", `Order #${orderId}`, orderId);
    }
  }
}

app.get("/", async (c) => {
  const { page, pageSize, offset } = paging(c, 25, 200);
  const status = q(c, "status");
  const source = q(c, "source");
  const search = q(c, "search");
  const from = q(c, "from");
  const to = q(c, "to");
  const campaignId = q(c, "campaign_id");
  const paymentStatus = q(c, "payment_status");

  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (status) {
    clauses.push("o.status = ?");
    params.push(status);
  }
  if (source) {
    clauses.push("o.source = ?");
    params.push(source);
  }
  if (paymentStatus) {
    clauses.push("o.payment_status = ?");
    params.push(paymentStatus);
  }
  if (campaignId) {
    clauses.push("o.campaign_id = ?");
    params.push(Number(campaignId));
  }
  if (from) {
    clauses.push("o.placed_at >= ?");
    params.push(`${from}T00:00:00.000Z`);
  }
  if (to) {
    clauses.push("o.placed_at <= ?");
    params.push(`${to}T23:59:59.999Z`);
  }
  if (search) {
    clauses.push("(o.order_number LIKE ? OR cu.name LIKE ? OR o.ship_phone LIKE ? OR cu.phone LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const totalRow = await c.env.DB.prepare(
    `SELECT COUNT(*) as n FROM orders o JOIN customers cu ON cu.id = o.customer_id ${where}`,
  )
    .bind(...params)
    .first<{ n: number }>();
  const rows = await c.env.DB.prepare(
    `SELECT o.*, cu.name as customer_name, cu.phone as customer_phone, ca.name as campaign_name,
       (SELECT COALESCE(SUM(CASE WHEN p.type IN ('payment','cod_collection') THEN p.amount ELSE -p.amount END),0)
        FROM payments p WHERE p.order_id = o.id) as paid_amount
     FROM orders o
     JOIN customers cu ON cu.id = o.customer_id
     LEFT JOIN campaigns ca ON ca.id = o.campaign_id
     ${where}
     ORDER BY o.placed_at DESC, o.id DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(...params, pageSize, offset)
    .all<Order>();

  const body: Paged<Order> = { items: rows.results, total: totalRow?.n ?? 0, page, pageSize };
  return c.json(body);
});

app.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const order = await c.env.DB.prepare(
    `SELECT o.*, cu.name as customer_name, cu.phone as customer_phone, ca.name as campaign_name
     FROM orders o JOIN customers cu ON cu.id = o.customer_id
     LEFT JOIN campaigns ca ON ca.id = o.campaign_id WHERE o.id = ?`,
  )
    .bind(id)
    .first<Order>();
  if (!order) return err(c, 404, "Order not found");
  const items = await loadItems(c.env.DB, id);
  const history = await c.env.DB.prepare("SELECT * FROM order_status_history WHERE order_id = ? ORDER BY id DESC")
    .bind(id)
    .all();
  const payments = await c.env.DB.prepare(
    "SELECT *, CASE WHEN type='refund' THEN -amount ELSE amount END as signed FROM payments WHERE order_id = ? ORDER BY paid_at DESC, id DESC",
  )
    .bind(id)
    .all();
  const shipment = await c.env.DB.prepare("SELECT * FROM shipments WHERE order_id = ? ORDER BY id DESC LIMIT 1")
    .bind(id)
    .first();
  const attachments = await c.env.DB.prepare(
    "SELECT id, key, filename, size, content_type, created_at FROM order_attachments WHERE order_id = ? ORDER BY id DESC",
  )
    .bind(id)
    .all();
  const paid = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN type IN ('payment','cod_collection') THEN amount ELSE 0 END),0) as inflow,
            COALESCE(SUM(CASE WHEN type = 'refund' THEN amount ELSE 0 END),0) as refund
     FROM payments WHERE order_id = ?`,
  )
    .bind(id)
    .first<{ inflow: number; refund: number }>();
  return c.json({
    order: { ...order, items, history: history.results, paid_amount: (paid?.inflow ?? 0) - (paid?.refund ?? 0) },
    payments: payments.results,
    shipment,
    attachments: attachments.results,
  });
});

app.post("/", async (c) => {
  const body = await readJson<{
    customer_id?: number;
    source?: string;
    status?: string;
    discount?: number;
    shipping_charge?: number;
    payment_method?: string;
    campaign_id?: number | null;
    ship?: Partial<Order>;
    notes?: string;
    placed_at?: string;
    items?: Array<{ product_id?: number | null; product_name?: string; quantity?: number; unit_price?: number }>;
  }>(c);
  if (!body) return err(c, 400, "Invalid payload");

  const customerId = num(body.customer_id);
  if (!customerId) return err(c, 400, "Customer is required");
  const customer = await c.env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(customerId).first();
  if (!customer) return err(c, 400, "Customer not found");
  if (!body.items || body.items.length === 0) return err(c, 400, "At least one item is required");

  const items: OrderItem[] = [];
  for (const raw of body.items) {
    const qty = Math.max(1, num(raw.quantity));
    const productId = raw.product_id ? num(raw.product_id) : null;
    let name = str(raw.product_name);
    let sku = "";
    let unitPrice = num(raw.unit_price);
    let unitCost = 0;
    if (productId) {
      const p = await c.env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(productId).first<{
        id: number;
        name: string;
        sku: string;
        price: number;
        cost_price: number;
        stock_qty: number;
        status: string;
      }>();
      if (!p) return err(c, 400, `Product #${productId} not found`);
      if (p.status !== "active") return err(c, 400, `Product "${p.name}" is inactive`);
      name = p.name;
      sku = p.sku;
      unitCost = p.cost_price;
      if (unitPrice <= 0) unitPrice = p.price;
      if (p.stock_qty < qty) return err(c, 400, `Insufficient stock for "${p.name}" (available: ${p.stock_qty})`);
    } else {
      if (!name) return err(c, 400, "Custom item name is required");
      if (unitPrice <= 0) return err(c, 400, `Price is required for "${name}"`);
    }
    items.push({
      product_id: productId,
      product_name: name,
      sku,
      unit_price: unitPrice,
      unit_cost: unitCost,
      quantity: qty,
      line_total: lineTotal({ unit_price: unitPrice, quantity: qty }),
    });
  }

  const subtotal = items.reduce((s, i) => s + i.line_total, 0);
  const discount = Math.max(0, num(body.discount));
  const shipping = Math.max(0, num(body.shipping_charge));
  if (discount > subtotal) return err(c, 400, "Discount cannot exceed subtotal");
  const total = subtotal - discount + shipping;

  const orderNumber = await getOrderNumber(c.env.DB);
  const ship = body.ship || {};
  const source = str(body.source) || "manual";
  const status = str(body.status) || "pending";
  const placedAt = str(body.placed_at) ? `${str(body.placed_at).slice(0, 10)}T09:00:00.000Z` : new Date().toISOString();

  const res = await c.env.DB.prepare(
    `INSERT INTO orders (order_number, customer_id, source, status, subtotal, discount, shipping_charge, total,
       payment_method, campaign_id, ship_name, ship_phone, ship_address_line1, ship_address_line2, ship_city,
       ship_state, ship_pincode, notes, placed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      orderNumber,
      customerId,
      source,
      status,
      subtotal,
      discount,
      shipping,
      total,
      str(body.payment_method) || "cod",
      body.campaign_id ? num(body.campaign_id) : null,
      str(ship.ship_name) || str((customer as { name: string }).name),
      str(ship.ship_phone) || str((customer as { phone: string }).phone),
      str(ship.ship_address_line1) || str((customer as { address_line1: string }).address_line1),
      str(ship.ship_address_line2) || str((customer as { address_line2: string }).address_line2),
      str(ship.ship_city) || str((customer as { city: string }).city),
      str(ship.ship_state) || str((customer as { state: string }).state),
      str(ship.ship_pincode) || str((customer as { pincode: string }).pincode),
      str(body.notes),
      placedAt,
    )
    .run();
  const orderId = Number(res.meta.last_row_id);

  await replaceItems(c.env.DB, orderId, [], items, status);
  await c.env.DB.prepare("INSERT INTO order_status_history (order_id, status, note) VALUES (?, ?, ?)")
    .bind(orderId, status, "Order created")
    .run();

  const created = await c.env.DB.prepare(
    `SELECT o.*, cu.name as customer_name FROM orders o JOIN customers cu ON cu.id = o.customer_id WHERE o.id = ?`,
  )
    .bind(orderId)
    .first<Order>();
  return c.json({ ...created, items }, 201);
});

app.put("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await readJson<{
    source?: string;
    discount?: number;
    shipping_charge?: number;
    payment_method?: string;
    campaign_id?: number | null;
    ship?: Partial<Order>;
    notes?: string;
    placed_at?: string;
    items?: Array<{ product_id?: number | null; product_name?: string; quantity?: number; unit_price?: number }>;
  }>(c);
  if (!body) return err(c, 400, "Invalid payload");
  const existing = await c.env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first<Order>();
  if (!existing) return err(c, 404, "Order not found");

  const oldItems = await loadItems(c.env.DB, id);
  let items: OrderItem[] | null = null;
  if (body.items) {
    if (body.items.length === 0) return err(c, 400, "At least one item is required");
    items = [];
    for (const raw of body.items) {
      const qty = Math.max(1, num(raw.quantity));
      const productId = raw.product_id ? num(raw.product_id) : null;
      let name = str(raw.product_name);
      let sku = "";
      let unitPrice = num(raw.unit_price);
      let unitCost = 0;
      if (productId) {
        const p = await c.env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(productId).first<{
          name: string;
          sku: string;
          price: number;
          cost_price: number;
          stock_qty: number;
        }>();
        if (!p) return err(c, 400, `Product #${productId} not found`);
        name = p.name;
        sku = p.sku;
        unitCost = p.cost_price;
        if (unitPrice <= 0) unitPrice = p.price;
        if (ACTIVE_STATUSES.includes(existing.status)) {
          const oldQty = oldItems
            .filter((i) => i.product_id === productId)
            .reduce((s, i) => s + i.quantity, 0);
          if (p.stock_qty + oldQty < qty) {
            return err(c, 400, `Insufficient stock for "${p.name}" (available: ${p.stock_qty + oldQty})`);
          }
        } else if (p.stock_qty < qty) {
          return err(c, 400, `Insufficient stock for "${p.name}" (available: ${p.stock_qty})`);
        }
      } else {
        if (!name) return err(c, 400, "Custom item name is required");
        if (unitPrice <= 0) return err(c, 400, `Price is required for "${name}"`);
      }
      items.push({
        product_id: productId,
        product_name: name,
        sku,
        unit_price: unitPrice,
        unit_cost: unitCost,
        quantity: qty,
        line_total: lineTotal({ unit_price: unitPrice, quantity: qty }),
      });
    }
  }

  const subtotal = items ? items.reduce((s, i) => s + i.line_total, 0) : existing.subtotal;
  const discount = "discount" in body ? Math.max(0, num(body.discount)) : existing.discount;
  const shipping = "shipping_charge" in body ? Math.max(0, num(body.shipping_charge)) : existing.shipping_charge;
  if (discount > subtotal) return err(c, 400, "Discount cannot exceed subtotal");
  const total = subtotal - discount + shipping;
  const ship = body.ship || {};

  await c.env.DB.prepare(
    `UPDATE orders SET subtotal=?, discount=?, shipping_charge=?, total=?, source=?, payment_method=?, campaign_id=?,
      ship_name=?, ship_phone=?, ship_address_line1=?, ship_address_line2=?, ship_city=?, ship_state=?, ship_pincode=?,
      notes=?, placed_at=?, updated_at=? WHERE id=?`,
  )
    .bind(
      subtotal,
      discount,
      shipping,
      total,
      "source" in body ? str(body.source) || existing.source : existing.source,
      "payment_method" in body ? str(body.payment_method) || existing.payment_method : existing.payment_method,
      "campaign_id" in body ? (body.campaign_id ? num(body.campaign_id) : null) : existing.campaign_id,
      "ship" in body ? str(ship.ship_name) || existing.ship_name : existing.ship_name,
      "ship" in body ? str(ship.ship_phone) || existing.ship_phone : existing.ship_phone,
      "ship" in body ? str(ship.ship_address_line1) || existing.ship_address_line1 : existing.ship_address_line1,
      "ship" in body ? str(ship.ship_address_line2) || existing.ship_address_line2 : existing.ship_address_line2,
      "ship" in body ? str(ship.ship_city) || existing.ship_city : existing.ship_city,
      "ship" in body ? str(ship.ship_state) || existing.ship_state : existing.ship_state,
      "ship" in body ? str(ship.ship_pincode) || existing.ship_pincode : existing.ship_pincode,
      "notes" in body ? str(body.notes) : existing.notes,
      "placed_at" in body && str(body.placed_at) ? `${str(body.placed_at).slice(0, 10)}T09:00:00.000Z` : existing.placed_at,
      new Date().toISOString(),
      id,
    )
    .run();

  if (items) await replaceItems(c.env.DB, id, oldItems, items, existing.status);

  const updated = await c.env.DB.prepare(
    `SELECT o.*, cu.name as customer_name FROM orders o JOIN customers cu ON cu.id = o.customer_id WHERE o.id = ?`,
  )
    .bind(id)
    .first<Order>();
  return c.json({ ...updated, items: await loadItems(c.env.DB, id) });
});

app.post("/:id/status", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await readJson<{ status?: string; note?: string }>(c);
  if (!body || !str(body.status)) return err(c, 400, "Status is required");
  const allowed = ["pending", "confirmed", "packed", "shipped", "delivered", "cancelled", "returned"];
  const next = str(body.status);
  if (!allowed.includes(next)) return err(c, 400, "Invalid status");
  const order = await c.env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first<Order>();
  if (!order) return err(c, 404, "Order not found");
  if (order.status === next) return err(c, 400, "Order is already in this status");

  const wasActive = ACTIVE_STATUSES.includes(order.status);
  const willBeActive = ACTIVE_STATUSES.includes(next);
  const items = await loadItems(c.env.DB, id);

  if (wasActive && !willBeActive) {
    for (const it of items) if (it.product_id) await applyStockChange(c.env.DB, it.product_id, it.quantity, "order_release", `Order ${order.order_number} ${next}`, id);
  } else if (!wasActive && willBeActive) {
    for (const it of items) {
      if (it.product_id) {
        const p = await c.env.DB.prepare("SELECT stock_qty FROM products WHERE id = ?").bind(it.product_id).first<{ stock_qty: number }>();
        if ((p?.stock_qty ?? 0) < it.quantity) return err(c, 400, `Insufficient stock for "${it.product_name}"`);
      }
    }
    for (const it of items) if (it.product_id) await applyStockChange(c.env.DB, it.product_id, -it.quantity, "order_reopen", `Order ${order.order_number} reactivated`, id);
  }

  await c.env.DB.prepare("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?")
    .bind(next, new Date().toISOString(), id)
    .run();
  await c.env.DB.prepare("INSERT INTO order_status_history (order_id, status, note) VALUES (?, ?, ?)")
    .bind(id, next, str(body.note))
    .run();
  if (next === "cancelled" || next === "returned") await recomputePaymentStatus(c.env.DB, id);

  const updated = await c.env.DB.prepare(
    `SELECT o.*, cu.name as customer_name FROM orders o JOIN customers cu ON cu.id = o.customer_id WHERE o.id = ?`,
  )
    .bind(id)
    .first<Order>();
  return c.json(updated);
});

app.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const order = await c.env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first<Order>();
  if (!order) return err(c, 404, "Order not found");
  if (order.status === "shipped" || order.status === "delivered") {
    return err(c, 409, "Shipped or delivered orders cannot be deleted. Cancel the order instead.");
  }
  const items = await loadItems(c.env.DB, id);
  for (const it of items) if (it.product_id) await applyStockChange(c.env.DB, it.product_id, it.quantity, "order_delete", `Order ${order.order_number} deleted`, id);
  await c.env.DB.prepare("DELETE FROM orders WHERE id = ?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM payments WHERE order_id = ?").bind(id).run();
  return c.body(null, 204);
});

app.post("/:id/attachments", async (c) => {
  const id = Number(c.req.param("id"));
  const order = await c.env.DB.prepare("SELECT id FROM orders WHERE id = ?").bind(id).first();
  if (!order) return err(c, 404, "Order not found");
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return err(c, 400, "File is required");
  if (file.size > 8 * 1024 * 1024) return err(c, 400, "File must be 8MB or smaller");
  const key = `${id}/${crypto.randomUUID()}-${file.name.replace(/[^\w.\-]+/g, "_")}`;
  await c.env.ATTACHMENTS.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });
  const res = await c.env.DB.prepare(
    "INSERT INTO order_attachments (order_id, key, filename, size, content_type) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, key, file.name, file.size, file.type || "application/octet-stream")
    .run();
  const row = await c.env.DB.prepare("SELECT * FROM order_attachments WHERE id = ?")
    .bind(res.meta.last_row_id)
    .first();
  return c.json(row, 201);
});

app.delete("/:id/attachments/:attachmentId", async (c) => {
  const attachmentId = Number(c.req.param("attachmentId"));
  const row = await c.env.DB.prepare("SELECT * FROM order_attachments WHERE id = ?")
    .bind(attachmentId)
    .first<{ id: number; key: string }>();
  if (!row) return err(c, 404, "Attachment not found");
  await c.env.ATTACHMENTS.delete(row.key);
  await c.env.DB.prepare("DELETE FROM order_attachments WHERE id = ?").bind(attachmentId).run();
  return c.body(null, 204);
});

app.get("/attachments/*", async (c) => {
  const key = decodeURIComponent(new URL(c.req.url).pathname.split("/attachments/")[1] || "");
  if (!key) return err(c, 400, "Missing attachment key");
  const obj = await c.env.ATTACHMENTS.get(key);
  if (!obj) return err(c, 404, "Attachment not found");
  const meta = obj.httpMetadata;
  const filename = key.split("/").pop() || "attachment";
  return new Response(obj.body, {
    headers: {
      "Content-Type": meta?.contentType || "application/octet-stream",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "private, max-age=300",
    },
  });
});

export { recomputePaymentStatus };
export default app;
