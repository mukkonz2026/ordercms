import { Hono } from "hono";
import type { AppEnv } from "../types";
import { err, paging, q, readJson, str, num, clampDate } from "../helpers";
import type { Campaign, Paged } from "../../shared/types";

const app = new Hono<AppEnv>();

const METRIC_FIELDS = ["impressions", "clicks", "reach", "spend", "conversations", "leads", "purchases", "revenue"] as const;

async function computeMetrics(db: D1Database, campaignId: number) {
  const s = await db
    .prepare(
      `SELECT COALESCE(SUM(impressions),0) impressions, COALESCE(SUM(clicks),0) clicks,
              COALESCE(SUM(reach),0) reach, COALESCE(SUM(spend),0) spend,
              COALESCE(SUM(conversations),0) conversations, COALESCE(SUM(leads),0) leads,
              COALESCE(SUM(purchases),0) purchases, COALESCE(SUM(revenue),0) revenue
       FROM campaign_daily_metrics WHERE campaign_id = ?`,
    )
    .bind(campaignId)
    .first<Record<string, number>>();
  const orderStats = await db
    .prepare(
      `SELECT COUNT(*) as orders, COALESCE(SUM(total),0) as rev,
              COALESCE(SUM((SELECT COALESCE(SUM(oi.unit_cost * oi.quantity),0) FROM order_items oi WHERE oi.order_id = orders.id)),0) as cogs
       FROM orders WHERE campaign_id = ? AND status NOT IN ('cancelled','returned')`,
    )
    .bind(campaignId)
    .first<{ orders: number; rev: number; cogs: number }>();

  const m = s || ({} as Record<string, number>);
  const spend = m.spend ?? 0;
  const impressions = m.impressions ?? 0;
  const clicks = m.clicks ?? 0;
  const attributedRevenue = orderStats?.rev ?? m.revenue ?? 0;
  const cogs = orderStats?.cogs ?? 0;
  return {
    impressions,
    clicks,
    reach: m.reach ?? 0,
    spend,
    conversations: m.conversations ?? 0,
    leads: m.leads ?? 0,
    purchases: orderStats?.orders ?? m.purchases ?? 0,
    attributed_revenue: attributedRevenue,
    cogs,
    ctr: impressions ? (clicks / impressions) * 100 : 0,
    cpc: clicks ? spend / clicks : 0,
    cpm: impressions ? (spend / impressions) * 1000 : 0,
    cpl: m.leads ? spend / m.leads : 0,
    cpa: orderStats?.orders ? spend / orderStats.orders : 0,
    roas: spend ? attributedRevenue / spend : 0,
    profit: attributedRevenue - spend - cogs,
  };
}

app.get("/", async (c) => {
  const { page, pageSize, offset } = paging(c);
  const status = q(c, "status");
  const search = q(c, "search");
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (search) {
    clauses.push("(name LIKE ? OR objective LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) as n FROM campaigns ${where}`)
    .bind(...params)
    .first<{ n: number }>();
  const rows = await c.env.DB.prepare(`SELECT * FROM campaigns ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...params, pageSize, offset)
    .all<Campaign>();
  return c.json({ items: rows.results, total: totalRow?.n ?? 0, page, pageSize });
});

app.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const campaign = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first<Campaign>();
  if (!campaign) return err(c, 404, "Campaign not found");
  const metrics = await computeMetrics(c.env.DB, id);
  const adSets = await c.env.DB.prepare("SELECT * FROM ad_sets WHERE campaign_id = ? ORDER BY id").bind(id).all();
  const ads = await c.env.DB.prepare(
    "SELECT a.* FROM ads a JOIN ad_sets s ON s.id = a.ad_set_id WHERE s.campaign_id = ? ORDER BY a.id",
  )
    .bind(id)
    .all();
  const daily = await c.env.DB.prepare(
    "SELECT * FROM campaign_daily_metrics WHERE campaign_id = ? ORDER BY date DESC LIMIT 365",
  )
    .bind(id)
    .all();
  const orders = await c.env.DB.prepare(
    "SELECT id, order_number, status, total, payment_status, placed_at FROM orders WHERE campaign_id = ? ORDER BY placed_at DESC LIMIT 50",
  )
    .bind(id)
    .all();
  return c.json({
    campaign: { ...campaign, ...metrics },
    adSets: adSets.results,
    ads: ads.results,
    daily: daily.results,
    orders: orders.results,
  });
});

app.post("/", async (c) => {
  const body = await readJson<Partial<Campaign>>(c);
  if (!body || !str(body.name)) return err(c, 400, "Campaign name is required");
  const res = await c.env.DB.prepare(
    `INSERT INTO campaigns (name, objective, status, daily_budget, start_date, end_date, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      str(body.name),
      str(body.objective) || "sales",
      str(body.status) || "active",
      Math.max(0, num(body.daily_budget)),
      str(body.start_date) || clampDate(new Date().toISOString()),
      str(body.end_date),
      str(body.notes),
    )
    .run();
  const campaign = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ?")
    .bind(res.meta.last_row_id)
    .first<Campaign>();
  return c.json(campaign, 201);
});

app.put("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await readJson<Partial<Campaign>>(c);
  if (!body) return err(c, 400, "Invalid payload");
  const existing = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first<Campaign>();
  if (!existing) return err(c, 404, "Campaign not found");
  if ("name" in body && !str(body.name)) return err(c, 400, "Campaign name is required");
  await c.env.DB.prepare(
    `UPDATE campaigns SET name=?, objective=?, status=?, daily_budget=?, start_date=?, end_date=?, notes=?, updated_at=? WHERE id=?`,
  )
    .bind(
      "name" in body ? str(body.name) : existing.name,
      "objective" in body ? str(body.objective) : existing.objective,
      "status" in body ? str(body.status) : existing.status,
      "daily_budget" in body ? Math.max(0, num(body.daily_budget)) : existing.daily_budget,
      "start_date" in body ? str(body.start_date) : existing.start_date,
      "end_date" in body ? str(body.end_date) : existing.end_date,
      "notes" in body ? str(body.notes) : existing.notes,
      new Date().toISOString(),
      id,
    )
    .run();
  const campaign = await c.env.DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first<Campaign>();
  const metrics = await computeMetrics(c.env.DB, id);
  return c.json({ ...campaign, ...metrics });
});

app.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const linked = await c.env.DB.prepare("SELECT COUNT(*) as n FROM orders WHERE campaign_id = ?")
    .bind(id)
    .first<{ n: number }>();
  if ((linked?.n ?? 0) > 0) return err(c, 409, "Campaign has linked orders and cannot be deleted");
  await c.env.DB.prepare("DELETE FROM campaigns WHERE id = ?").bind(id).run();
  return c.body(null, 204);
});

app.post("/:id/adsets", async (c) => {
  const id = Number(c.req.param("id"));
  const campaign = await c.env.DB.prepare("SELECT id FROM campaigns WHERE id = ?").bind(id).first();
  if (!campaign) return err(c, 404, "Campaign not found");
  const body = await readJson<{ name?: string; budget?: number; audience?: string }>(c);
  if (!body || !str(body.name)) return err(c, 400, "Ad set name is required");
  const res = await c.env.DB.prepare("INSERT INTO ad_sets (campaign_id, name, audience, budget) VALUES (?, ?, ?, ?)")
    .bind(id, str(body.name), str(body.audience), Math.max(0, num(body.budget)))
    .run();
  const row = await c.env.DB.prepare("SELECT * FROM ad_sets WHERE id = ?").bind(res.meta.last_row_id).first();
  return c.json(row, 201);
});

app.post("/:id/ads", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await readJson<{ name?: string; ad_set_id?: number; creative_type?: string; cta?: string }>(c);
  if (!body || !str(body.name)) return err(c, 400, "Ad name is required");
  const adSetId = num(body.ad_set_id);
  if (!adSetId) return err(c, 400, "Ad set is required");
  const adSet = await c.env.DB.prepare("SELECT * FROM ad_sets WHERE id = ? AND campaign_id = ?")
    .bind(adSetId, id)
    .first();
  if (!adSet) return err(c, 400, "Ad set not found for this campaign");
  const res = await c.env.DB.prepare("INSERT INTO ads (ad_set_id, name, creative_type, cta) VALUES (?, ?, ?, ?)")
    .bind(adSetId, str(body.name), str(body.creative_type) || "image", str(body.cta))
    .run();
  const row = await c.env.DB.prepare("SELECT * FROM ads WHERE id = ?").bind(res.meta.last_row_id).first();
  return c.json(row, 201);
});

app.post("/:id/metrics", async (c) => {
  const id = Number(c.req.param("id"));
  const campaign = await c.env.DB.prepare("SELECT id FROM campaigns WHERE id = ?").bind(id).first();
  if (!campaign) return err(c, 404, "Campaign not found");
  const body = await readJson<Record<string, unknown> & { date?: string }>(c);
  if (!body || !str(body.date)) return err(c, 400, "Date is required");
  const date = clampDate(str(body.date));
  const binds: (string | number)[] = [id, date];
  const cols = METRIC_FIELDS.map((f) => {
    binds.push(Math.max(0, num(body[f])));
    return f;
  });
  await c.env.DB.prepare(
    `INSERT INTO campaign_daily_metrics (campaign_id, date, ${cols.join(",")}) VALUES (?, ?, ${cols.map(() => "?").join(",")})
     ON CONFLICT(campaign_id, date) DO UPDATE SET ${cols.map((f) => `${f} = excluded.${f}`).join(", ")}`,
  )
    .bind(...binds)
    .run();
  const row = await c.env.DB.prepare("SELECT * FROM campaign_daily_metrics WHERE campaign_id = ? AND date = ?")
    .bind(id, date)
    .first();
  const metrics = await computeMetrics(c.env.DB, id);
  return c.json({ row, totals: metrics }, 201);
});

app.get("/:id/metrics", async (c) => {
  const id = Number(c.req.param("id"));
  const from = q(c, "from");
  const to = q(c, "to");
  const clauses = ["campaign_id = ?"];
  const params: (string | number)[] = [id];
  if (from) {
    clauses.push("date >= ?");
    params.push(clampDate(from));
  }
  if (to) {
    clauses.push("date <= ?");
    params.push(clampDate(to));
  }
  const rows = await c.env.DB.prepare(
    `SELECT * FROM campaign_daily_metrics WHERE ${clauses.join(" AND ")} ORDER BY date DESC`,
  )
    .bind(...params)
    .all();
  return c.json(rows.results);
});

app.delete("/:id/metrics/:date", async (c) => {
  const id = Number(c.req.param("id"));
  const date = clampDate(c.req.param("date"));
  await c.env.DB.prepare("DELETE FROM campaign_daily_metrics WHERE campaign_id = ? AND date = ?")
    .bind(id, date)
    .run();
  return c.body(null, 204);
});

export { computeMetrics };
export default app;
