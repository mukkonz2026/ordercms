import type { Env } from "./env";
import { purgeExpiredSessions } from "./session";

export async function scheduled(_controller: ScheduledController, env: Env): Promise<void> {
  try {
    await purgeExpiredSessions(env.DB);
  } catch (error) {
    console.error("Session purge failed:", error instanceof Error ? error.message : error);
  }
}
