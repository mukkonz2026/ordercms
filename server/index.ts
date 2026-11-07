import { Hono } from "hono";
import type { AppEnv } from "./types";
import { sameOrigin, requireAuth } from "./middleware";
import auth from "./routes/auth";
import customers from "./routes/customers";
import products from "./routes/products";
import orders from "./routes/orders";
import campaigns from "./routes/campaigns";
import shipments from "./routes/shipments";
import payments from "./routes/payments";
import finance from "./routes/finance";
import dashboard from "./routes/dashboard";
import { scheduled } from "./cron";

const app = new Hono<AppEnv>();

app.use("/api/*", sameOrigin);

app.get("/api/health", (c) => c.json({ ok: true }));

const isPublic = (path: string, method: string): boolean =>
  path === "/api/health" ||
  path === "/api/auth/login" ||
  (path === "/api/auth/settings" && method === "GET");

app.use("/api/*", async (c, next) => {
  if (isPublic(c.req.path, c.req.method)) return next();
  return requireAuth(c, next);
});

app.route("/api/auth", auth);
app.route("/api/customers", customers);
app.route("/api/products", products);
app.route("/api/orders", orders);
app.route("/api/campaigns", campaigns);
app.route("/api/shipments", shipments);
app.route("/api/payments", payments);
app.route("/api/finance", finance);
app.route("/api/dashboard", dashboard);

app.notFound(async (c) => {
  if (c.req.path.startsWith("/api/")) return c.json({ error: "Not found" }, 404);
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((error, c) => {
  console.error("Unhandled error:", error?.message || error, error?.stack || "");
  return c.json({ error: "Internal server error" }, 500);
});

export default {
  fetch: app.fetch,
  scheduled,
};
