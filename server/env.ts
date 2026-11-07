export interface Env {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  LIMITS: KVNamespace;
  ASSETS: Fetcher;
}
