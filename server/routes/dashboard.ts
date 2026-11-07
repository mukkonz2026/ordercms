import { Hono } from "hono";
import type { AppEnv } from "../types";
import { q, clampDate, daysAgo } from "../helpers";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  const now = new Date();
  const today = clampDate(now.toISOString());
  const monthStart = `${today.slice(0, 8)}01`;
  const from = q(c, "from") || monthStart;
  const to = q(c, "to") || today;

  const ordersMonth = await c.env.DB.prepare(
    `SELECT COUNT(*) as n, COALESCE(SUM(total),0) as revenue
     FROM orders WHERE placed_at >= ? AND placed_at <= ? AND status NOT IN ('cancelled','returned')`,
  )
    .bind(`${from}T00:00:00.000Z`, `${to}T23:59:59.999Z`)
    .first<{ n: number; revenue: number }>();

  const ordersToday = await c.env.DB.prepare(
    "SELECT COUNT(*) as n FROM orders WHERE placed_at >= ?",
  )
    .bind(`${today}T00:00:00.000Z`)
    .first<{ n: number }>();

  const spend = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(spend),0) as s FROM campaign_daily_metrics WHERE date >= ? AND date <= ?",
  )
    .bind(from, to)
    .first<{ s: number }>();

  const pendingShip = await c.env.DB.prepare(
    `SELECT COUNT(*) as n FROM shipments s JOIN orders o ON o.id = s.order_id
     WHERE s.status NOT IN ('delivered','returned','lost') AND o.status NOT IN ('delivered','cancelled','returned')`,
  ).first<{ n: number }>();

  const codPending = await c.env.DB.prepare(
    `SELECT COUNT(*) as n, COALESCE(SUM(o.total - COALESCE(
       (SELECT SUM(CASE WHEN p.type IN ('payment','cod_collection') THEN p.amount ELSE -p.amount END)
        FROM payments p WHERE p.order_id = o.id),0)),0) as amount
     FROM orders o WHERE o.payment_method = 'cod' AND o.status = 'delivered'
       AND COALESCE((SELECT SUM(CASE WHEN p.type IN ('payment','cod_collection') THEN p.amount ELSE -p.amount END)
         FROM payments p WHERE p.order_id = o.id),0) < o.total`,
  ).first<{ n: number; amount: number }>();

  const lowStock = await c.env.DB.prepare(
    "SELECT COUNT(*) as n FROM products WHERE status = 'active' AND stock_qty <= low_stock_threshold",
  ).first<{ n: number }>();

  const unpaid = await c.env.DB.prepare(
    `SELECT COUNT(*) as n FROM orders WHERE payment_status IN ('unpaid','partial')
     AND status NOT IN ('cancelled','returned')`,
  ).first<{ n: number }>();

  const topCampaigns = await c.env.DB.prepare(
    `SELECT c.id, c.name, COALESCE(SUM(m.spend),0) as spend
     FROM campaigns c LEFT JOIN campaign_daily_metrics m ON m.campaign_id = c.id AND m.date >= ? AND m.date <= ?
     GROUP BY c.id HAVING spend > 0 ORDER BY spend DESC LIMIT 5`,
  )
    .bind(from, to)
    .all();

  const recentOrders = await c.env.DB.prepare(
    `SELECT o.id, o.order_number, o.status, o.total, o.payment_status, o.source, o.placed_at,
            cu.name as customer_name
     FROM orders o JOIN customers cu ON cu.id = o.customer_id
     ORDER BY o.placed_at DESC, o.id DESC LIMIT 8`,
  ).all();

  const daily = await c.env.DB.prepare(
    `SELECT date, spend, impressions, clicks, leads, conversations, revenue
     FROM campaign_daily_metrics WHERE date >= ? AND date <= ? ORDER BY date ASC`,
  )
    .bind(daysAgo(29), to)
    .all();

  return c.json({
    period: { from, to },
    kpis: {
      orders_month: ordersMonth?.n ?? 0,
      orders_today: ordersToday?.n ?? 0,
      revenue_month: ordersMonth?.revenue ?? 0,
      ad_spend: spend?.s ?? 0,
      pending_shipments: pendingShip?.n ?? 0,
      cod_pending_count: codPending?.n ?? 0,
      cod_pending_amount: codPending?.amount ?? 0,
      low_stock_count: lowStock?.n ?? 0,
      unpaid_count: unpaid?.n ?? 0,
    },
    top_campaigns: topCampaigns.results,
    recent_orders: recentOrders.results,
    daily_metrics: daily.results,
  });
});

export default app;
