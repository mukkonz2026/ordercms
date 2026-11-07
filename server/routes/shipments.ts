import { Hono } from "hono";
import type { AppEnv } from "../types";
import { err, paging, q, readJson, str, num, clampDate } from "../helpers";
import type { Shipment, Paged } from "../../shared/types";

const app = new Hono<AppEnv>();

const SHIPMENT_STATUSES = ["pending", "picked_up", "in_transit", "out_for_delivery", "delivered", "returned", "lost"];

app.get("/", async (c) => {
  const { page, pageSize, offset } = paging(c);
  const status = q(c, "status");
  const search = q(c, "search");
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (status) {
    clauses.push("s.status = ?");
    params.push(status);
  }
  if (search) {
    clauses.push("(s.awb LIKE ? OR s.tracking_number LIKE ? OR o.order_number LIKE ? OR s.courier LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) as n FROM shipments s JOIN orders o ON o.id = s.order_id ${where}`)
    .bind(...params)
    .first<{ n: number }>();
  const rows = await c.env.DB.prepare(
    `SELECT s.*, o.order_number, o.status as order_status, cu.name as customer_name, cu.phone as customer_phone
     FROM shipments s
     JOIN orders o ON o.id = s.order_id
     JOIN customers cu ON cu.id = o.customer_id
     ${where}
     ORDER BY s.created_at DESC, s.id DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(...params, pageSize, offset)
    .all<Shipment>();
  return c.json({ items: rows.results, total: totalRow?.n ?? 0, page, pageSize });
});

app.post("/", async (c) => {
  const body = await readJson<Partial<Shipment>>(c);
  if (!body || !num(body.order_id)) return err(c, 400, "Order is required");
  const orderId = num(body.order_id);
  const order = await c.env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first<{
    id: number;
    status: string;
    order_number: string;
    shipping_charge: number;
  }>();
  if (!order) return err(c, 404, "Order not found");
  const status = str(body.status) || "pending";
  if (!SHIPMENT_STATUSES.includes(status)) return err(c, 400, "Invalid shipment status");

  const res = await c.env.DB.prepare(
    `INSERT INTO shipments (order_id, courier, awb, tracking_number, ship_date, shipping_charge, weight_g, cod_amount, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      orderId,
      str(body.courier),
      str(body.awb),
      str(body.tracking_number),
      str(body.ship_date) || clampDate(new Date().toISOString()),
      "shipping_charge" in body ? Math.max(0, num(body.shipping_charge)) : order.shipping_charge,
      Math.max(0, num(body.weight_g)),
      Math.max(0, num(body.cod_amount)),
      status,
      str(body.notes),
    )
    .run();
  const shipmentId = Number(res.meta.last_row_id);

  const active = ["pending", "confirmed", "packed"];
  if (active.includes(order.status)) {
    await c.env.DB.prepare("UPDATE orders SET status = 'shipped', updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), orderId)
      .run();
    await c.env.DB.prepare("INSERT INTO order_status_history (order_id, status, note) VALUES (?, 'shipped', ?)")
      .bind(orderId, `Shipment created${str(body.courier) ? ` (${str(body.courier)})` : ""}`)
      .run();
  }

  const row = await c.env.DB.prepare("SELECT * FROM shipments WHERE id = ?").bind(shipmentId).first<Shipment>();
  return c.json(row, 201);
});

app.put("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await readJson<Partial<Shipment>>(c);
  if (!body) return err(c, 400, "Invalid payload");
  const existing = await c.env.DB.prepare("SELECT * FROM shipments WHERE id = ?").bind(id).first<Shipment>();
  if (!existing) return err(c, 404, "Shipment not found");

  const status = "status" in body ? str(body.status) || existing.status : existing.status;
  if (!SHIPMENT_STATUSES.includes(status)) return err(c, 400, "Invalid shipment status");
  const deliveredDate =
    status === "delivered"
      ? str(body.delivered_date) || existing.delivered_date || clampDate(new Date().toISOString())
      : str(body.delivered_date) ?? existing.delivered_date;

  await c.env.DB.prepare(
    `UPDATE shipments SET courier=?, awb=?, tracking_number=?, ship_date=?, shipping_charge=?, weight_g=?,
      cod_amount=?, status=?, delivered_date=?, notes=?, updated_at=? WHERE id=?`,
  )
    .bind(
      "courier" in body ? str(body.courier) : existing.courier,
      "awb" in body ? str(body.awb) : existing.awb,
      "tracking_number" in body ? str(body.tracking_number) : existing.tracking_number,
      "ship_date" in body ? clampDate(str(body.ship_date)) : existing.ship_date,
      "shipping_charge" in body ? Math.max(0, num(body.shipping_charge)) : existing.shipping_charge,
      "weight_g" in body ? Math.max(0, num(body.weight_g)) : existing.weight_g,
      "cod_amount" in body ? Math.max(0, num(body.cod_amount)) : existing.cod_amount,
      status,
      deliveredDate,
      "notes" in body ? str(body.notes) : existing.notes,
      new Date().toISOString(),
      id,
    )
    .run();

  const order = await c.env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(existing.order_id).first<{
    status: string;
  }>();
  if (order) {
    const orderStatuses = ["pending", "confirmed", "packed", "shipped", "delivered"];
    if (status === "delivered" && order.status !== "delivered" && orderStatuses.includes(order.status)) {
      await c.env.DB.prepare("UPDATE orders SET status = 'delivered', updated_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), existing.order_id)
        .run();
      await c.env.DB.prepare("INSERT INTO order_status_history (order_id, status, note) VALUES (?, 'delivered', ?)")
        .bind(existing.order_id, `Shipment delivered${str(body.awb) ? ` (AWB ${str(body.awb)})` : ""}`)
        .run();
    } else if (
      ["picked_up", "in_transit", "out_for_delivery"].includes(status) &&
      ["pending", "confirmed", "packed"].includes(order.status)
    ) {
      await c.env.DB.prepare("UPDATE orders SET status = 'shipped', updated_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), existing.order_id)
        .run();
      await c.env.DB.prepare("INSERT INTO order_status_history (order_id, status, note) VALUES (?, 'shipped', ?)")
        .bind(existing.order_id, `Shipment ${status.replace("_", " ")}`)
        .run();
    }
  }

  const row = await c.env.DB.prepare("SELECT * FROM shipments WHERE id = ?").bind(id).first<Shipment>();
  return c.json(row);
});

app.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const existing = await c.env.DB.prepare("SELECT id FROM shipments WHERE id = ?").bind(id).first();
  if (!existing) return err(c, 404, "Shipment not found");
  await c.env.DB.prepare("DELETE FROM shipments WHERE id = ?").bind(id).run();
  return c.body(null, 204);
});

export default app;
