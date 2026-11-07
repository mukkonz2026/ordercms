import { Hono } from "hono";
import type { AppEnv } from "../types";
import { err, paging, q, readJson, str, num, clampDate } from "../helpers";
import type { Expense, Paged, PnlReport } from "../../shared/types";

const app = new Hono<AppEnv>();

const EXPENSE_CATEGORIES = [
  "packaging",
  "shipping",
  "office",
  "salary",
  "marketing",
  "utilities",
  "software",
  "tax",
  "rent",
  "other",
];

// ---------- expenses ----------

app.get("/expenses", async (c) => {
  const { page, pageSize, offset } = paging(c);
  const category = q(c, "category");
  const from = q(c, "from");
  const to = q(c, "to");
  const search = q(c, "search");

  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (category) {
    clauses.push("e.category = ?");
    params.push(category);
  }
  if (from) {
    clauses.push("e.expense_date >= ?");
    params.push(from);
  }
  if (to) {
    clauses.push("e.expense_date <= ?");
    params.push(to);
  }
  if (search) {
    clauses.push("(e.description LIKE ? OR e.notes LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) as n FROM expenses e ${where}`)
    .bind(...params)
    .first<{ n: number }>();
  const rows = await c.env.DB.prepare(
    `SELECT e.*, o.order_number FROM expenses e LEFT JOIN orders o ON o.id = e.order_id
     ${where} ORDER BY e.expense_date DESC, e.id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...params, pageSize, offset)
    .all<Expense>();
  const sums = await c.env.DB.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM expenses e ${where}`)
    .bind(...params)
    .first<{ total: number }>();
  return c.json({ items: rows.results, total: totalRow?.n ?? 0, page, pageSize, sum: sums?.total ?? 0 });
});

app.post("/expenses", async (c) => {
  const body = await readJson<Partial<Expense>>(c);
  if (!body || !str(body.category)) return err(c, 400, "Category is required");
  if (!EXPENSE_CATEGORIES.includes(str(body.category))) return err(c, 400, "Invalid expense category");
  const amount = num(body.amount);
  if (amount <= 0) return err(c, 400, "Amount must be greater than zero");
  const res = await c.env.DB.prepare(
    `INSERT INTO expenses (category, description, amount, expense_date, order_id, notes)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      str(body.category),
      str(body.description),
      amount,
      clampDate(str(body.expense_date) || new Date().toISOString()),
      body.order_id ? num(body.order_id) : null,
      str(body.notes),
    )
    .run();
  const row = await c.env.DB.prepare("SELECT * FROM expenses WHERE id = ?").bind(res.meta.last_row_id).first();
  return c.json(row, 201);
});

app.put("/expenses/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await readJson<Partial<Expense>>(c);
  if (!body) return err(c, 400, "Invalid payload");
  const existing = await c.env.DB.prepare("SELECT * FROM expenses WHERE id = ?").bind(id).first<Expense>();
  if (!existing) return err(c, 404, "Expense not found");
  const category = "category" in body ? str(body.category) : existing.category;
  if (!EXPENSE_CATEGORIES.includes(category)) return err(c, 400, "Invalid expense category");
  const amount = "amount" in body ? num(body.amount) : existing.amount;
  if (amount <= 0) return err(c, 400, "Amount must be greater than zero");
  await c.env.DB.prepare(
    "UPDATE expenses SET category=?, description=?, amount=?, expense_date=?, order_id=?, notes=? WHERE id=?",
  )
    .bind(
      category,
      "description" in body ? str(body.description) : existing.description,
      amount,
      "expense_date" in body ? clampDate(str(body.expense_date)) : existing.expense_date,
      "order_id" in body ? (body.order_id ? num(body.order_id) : null) : existing.order_id,
      "notes" in body ? str(body.notes) : existing.notes,
      id,
    )
    .run();
  const row = await c.env.DB.prepare("SELECT * FROM expenses WHERE id = ?").bind(id).first();
  return c.json(row);
});

app.delete("/expenses/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const existing = await c.env.DB.prepare("SELECT id FROM expenses WHERE id = ?").bind(id).first();
  if (!existing) return err(c, 404, "Expense not found");
  await c.env.DB.prepare("DELETE FROM expenses WHERE id = ?").bind(id).run();
  return c.body(null, 204);
});

// ---------- P&L ----------

async function buildPnl(db: D1Database, from: string, to: string): Promise<PnlReport> {
  const dateFrom = `${from}T00:00:00.000Z`;
  const dateTo = `${to}T23:59:59.999Z`;

  const orderAgg = await db
    .prepare(
      `SELECT COUNT(CASE WHEN status NOT IN ('cancelled','returned') THEN 1 END) as orders_count,
              COALESCE(SUM(CASE WHEN status NOT IN ('cancelled','returned') THEN subtotal ELSE 0 END),0) as product_revenue,
              COALESCE(SUM(CASE WHEN status NOT IN ('cancelled','returned') THEN discount ELSE 0 END),0) as discounts,
              COALESCE(SUM(CASE WHEN status NOT IN ('cancelled','returned') THEN shipping_charge ELSE 0 END),0) as shipping_income,
              COALESCE(SUM(CASE WHEN status NOT IN ('cancelled','returned')
                THEN (SELECT COALESCE(SUM(oi.unit_cost * oi.quantity),0) FROM order_items oi WHERE oi.order_id = orders.id)
                ELSE 0 END),0) as cogs,
              COALESCE(SUM(CASE WHEN status NOT IN ('cancelled','returned')
                THEN (SELECT COALESCE(SUM(oi.quantity),0) FROM order_items oi WHERE oi.order_id = orders.id)
                ELSE 0 END),0) as units_sold,
              COALESCE(SUM(CASE WHEN status = 'returned' THEN total ELSE 0 END),0) as returns_loss,
              COALESCE(SUM(CASE WHEN status NOT IN ('cancelled','returned') AND campaign_id IS NOT NULL THEN total ELSE 0 END),0) as attributed_revenue
       FROM orders WHERE placed_at >= ? AND placed_at <= ?`,
    )
    .bind(dateFrom, dateTo)
    .first<{
      orders_count: number;
      product_revenue: number;
      discounts: number;
      shipping_income: number;
      cogs: number;
      units_sold: number;
      returns_loss: number;
      attributed_revenue: number;
    }>();

  const spend = await db
    .prepare("SELECT COALESCE(SUM(spend),0) as s FROM campaign_daily_metrics WHERE date >= ? AND date <= ?")
    .bind(from, to)
    .first<{ s: number }>();

  const expenseAgg = await db
    .prepare(
      `SELECT COALESCE(SUM(amount),0) as total,
              COALESCE(SUM(CASE WHEN category = 'shipping' THEN amount ELSE 0 END),0) as shipping_exp,
              COALESCE(SUM(CASE WHEN category = 'packaging' THEN amount ELSE 0 END),0) as packaging_exp
       FROM expenses WHERE expense_date >= ? AND expense_date <= ?`,
    )
    .bind(from, to)
    .first<{ total: number; shipping_exp: number; packaging_exp: number }>();

  const refundAgg = await db
    .prepare(
      `SELECT COALESCE(SUM(amount),0) as refunds FROM payments
       WHERE type = 'refund' AND paid_at >= ? AND paid_at <= ?`,
    )
    .bind(dateFrom, dateTo)
    .first<{ refunds: number }>();

  const categoryRows = await db
    .prepare(
      `SELECT category, COALESCE(SUM(amount),0) as amount FROM expenses
       WHERE expense_date >= ? AND expense_date <= ? GROUP BY category ORDER BY amount DESC`,
    )
    .bind(from, to)
    .all<{ category: string; amount: number }>();

  const productRevenue = orderAgg?.product_revenue ?? 0;
  const discounts = orderAgg?.discounts ?? 0;
  const shippingIncome = orderAgg?.shipping_income ?? 0;
  const cogs = orderAgg?.cogs ?? 0;
  const ordersCount = orderAgg?.orders_count ?? 0;
  const netRevenue = productRevenue - discounts;
  const grossProfit = netRevenue - cogs;
  const adSpend = spend?.s ?? 0;
  const expenses = expenseAgg?.total ?? 0;
  const totalExpenses = expenses + adSpend;
  const netProfit = grossProfit - totalExpenses;
  const attributedRevenue = orderAgg?.attributed_revenue ?? 0;

  return {
    from,
    to,
    product_revenue: productRevenue,
    discounts,
    refunds: refundAgg?.refunds ?? 0,
    net_revenue: netRevenue,
    cogs,
    gross_profit: grossProfit,
    shipping_income: shippingIncome,
    shipping_expense: expenseAgg?.shipping_exp ?? 0,
    packaging_expense: expenseAgg?.packaging_exp ?? 0,
    advertising_expense: adSpend,
    returns_loss: orderAgg?.returns_loss ?? 0,
    operating_expense: expenses,
    total_expenses: totalExpenses,
    net_profit: netProfit,
    gross_margin: netRevenue ? (grossProfit / netRevenue) * 100 : 0,
    net_margin: netRevenue ? (netProfit / netRevenue) * 100 : 0,
    orders_count: ordersCount,
    units_sold: orderAgg?.units_sold ?? 0,
    ad_spend: adSpend,
    attributed_revenue: attributedRevenue,
    roas: adSpend ? attributedRevenue / adSpend : 0,
    average_order_value: ordersCount ? netRevenue / ordersCount : 0,
    expense_breakdown: categoryRows.results,
  };
}

app.get("/pnl", async (c) => {
  const now = new Date();
  const from = q(c, "from") || `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const to = q(c, "to") || clampDate(now.toISOString());
  const report = await buildPnl(c.env.DB, from, to);
  return c.json(report);
});

// ---------- reports ----------

app.get("/products", async (c) => {
  const from = q(c, "from") || "2000-01-01";
  const to = q(c, "to") || clampDate(new Date().toISOString());
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.name, p.sku, p.category, p.stock_qty, p.low_stock_threshold,
            p.price, p.cost_price,
            COALESCE(SUM(oi.quantity),0) as units_sold,
            COALESCE(SUM(oi.line_total),0) as revenue,
            COALESCE(SUM(oi.unit_cost * oi.quantity),0) as cogs
     FROM products p
     LEFT JOIN order_items oi ON oi.product_id = p.id
     LEFT JOIN orders o ON o.id = oi.order_id AND o.status NOT IN ('cancelled','returned')
          AND o.placed_at >= ? AND o.placed_at <= ?
     GROUP BY p.id
     ORDER BY revenue DESC, p.name ASC`,
  )
    .bind(`${from}T00:00:00.000Z`, `${to}T23:59:59.999Z`)
    .all();
  const items = rows.results.map((r) => {
    const row = r as { units_sold: number; revenue: number; cogs: number; price: number };
    return {
      ...row,
      profit: row.revenue - row.cogs,
      margin: row.revenue ? ((row.revenue - row.cogs) / row.revenue) * 100 : 0,
      stock_value: (r as { stock_qty: number; cost_price: number }).stock_qty * (r as { cost_price: number }).cost_price,
    };
  });
  return c.json({ items });
});

app.get("/campaigns", async (c) => {
  const from = q(c, "from") || "2000-01-01";
  const to = q(c, "to") || clampDate(new Date().toISOString());
  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.objective, c.status, c.start_date, c.end_date,
            COALESCE((SELECT SUM(m.spend) FROM campaign_daily_metrics m
                      WHERE m.campaign_id = c.id AND m.date >= ? AND m.date <= ?),0) as spend,
            COALESCE((SELECT SUM(m.impressions) FROM campaign_daily_metrics m
                      WHERE m.campaign_id = c.id AND m.date >= ? AND m.date <= ?),0) as impressions,
            COALESCE((SELECT SUM(m.clicks) FROM campaign_daily_metrics m
                      WHERE m.campaign_id = c.id AND m.date >= ? AND m.date <= ?),0) as clicks,
            COALESCE((SELECT SUM(m.leads) FROM campaign_daily_metrics m
                      WHERE m.campaign_id = c.id AND m.date >= ? AND m.date <= ?),0) as leads,
            (SELECT COUNT(*) FROM orders o WHERE o.campaign_id = c.id
              AND o.status NOT IN ('cancelled','returned') AND o.placed_at >= ? AND o.placed_at <= ?) as orders,
            COALESCE((SELECT SUM(o.total) FROM orders o WHERE o.campaign_id = c.id
              AND o.status NOT IN ('cancelled','returned') AND o.placed_at >= ? AND o.placed_at <= ?),0) as revenue,
            COALESCE((SELECT SUM(oi.unit_cost * oi.quantity) FROM order_items oi
              JOIN orders o ON o.id = oi.order_id WHERE o.campaign_id = c.id
              AND o.status NOT IN ('cancelled','returned') AND o.placed_at >= ? AND o.placed_at <= ?),0) as cogs
     FROM campaigns c ORDER BY spend DESC`,
  )
    .bind(from, to, from, to, from, to, from, to, `${from}T00:00:00.000Z`, `${to}T23:59:59.999Z`,
      `${from}T00:00:00.000Z`, `${to}T23:59:59.999Z`, `${from}T00:00:00.000Z`, `${to}T23:59:59.999Z`)
    .all();
  const items = rows.results.map((r) => {
    const row = r as { spend: number; impressions: number; clicks: number; leads: number; revenue: number; orders: number; cogs: number };
    const profit = row.revenue - row.spend - row.cogs;
    return {
      ...row,
      ctr: row.impressions ? (row.clicks / row.impressions) * 100 : 0,
      cpc: row.clicks ? row.spend / row.clicks : 0,
      cpl: row.leads ? row.spend / row.leads : 0,
      cpa: row.orders ? row.spend / row.orders : 0,
      roas: row.spend ? row.revenue / row.spend : 0,
      profit,
    };
  });
  return c.json({ items });
});

app.get("/cod", async (c) => {
  const from = q(c, "from") || "2000-01-01";
  const to = q(c, "to") || clampDate(new Date().toISOString());
  const rows = await c.env.DB.prepare(
    `SELECT o.id, o.order_number, o.total, o.payment_status, o.status, o.placed_at,
            cu.name as customer_name, cu.phone as customer_phone,
            s.courier, s.awb, s.status as shipment_status, s.delivered_date,
            COALESCE((SELECT SUM(CASE WHEN p.type IN ('payment','cod_collection') THEN p.amount ELSE -p.amount END)
                      FROM payments p WHERE p.order_id = o.id),0) as collected
     FROM orders o
     JOIN customers cu ON cu.id = o.customer_id
     LEFT JOIN shipments s ON s.order_id = o.id
     WHERE o.payment_method = 'cod' AND o.placed_at >= ? AND o.placed_at <= ?
       AND o.status NOT IN ('cancelled')
     ORDER BY o.placed_at DESC`,
  )
    .bind(`${from}T00:00:00.000Z`, `${to}T23:59:59.999Z`)
    .all();
  const items = rows.results.map((r) => {
    const row = r as { total: number; collected: number };
    return { ...row, pending_amount: Math.max(0, row.total - row.collected) };
  });
  return c.json({ items });
});

export { buildPnl, EXPENSE_CATEGORIES };
export default app;
