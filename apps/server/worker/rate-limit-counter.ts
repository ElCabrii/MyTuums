import { DurableObject } from "cloudflare:workers";
import type { RateLimitPolicy, RateLimitResult } from "@my-tuums/api/rate-limit";

/** One persistent counter per opaque policy/caller key, accessed only through RPC. */
export class RateLimitCounter extends DurableObject {
  async consume(policy: RateLimitPolicy): Promise<RateLimitResult> {
    if (
      !Number.isSafeInteger(policy.limit) ||
      policy.limit < 1 ||
      policy.limit > 1_000_000 ||
      !Number.isSafeInteger(policy.windowMs) ||
      policy.windowMs < 1 ||
      policy.windowMs > 86_400_000
    )
      throw new Error("Invalid rate limit policy.");

    const now = Date.now();
    // No await between schema setup and mutation. The synchronous transaction
    // prevents concurrent callers or eviction from resetting an active budget.
    const bucket = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`create table if not exists counter (
        id integer primary key check (id = 1), count integer not null, reset_at integer not null
      )`);
      return this.ctx.storage.sql
        .exec<{ count: number; reset_at: number }>(
          `insert into counter values (1, 1, ?)
         on conflict(id) do update set
           count = case when counter.reset_at <= ? then 1
             when counter.count <= ? then counter.count + 1 else counter.count end,
           reset_at = case when counter.reset_at <= ? then excluded.reset_at else counter.reset_at end
         returning count, reset_at`,
          now + policy.windowMs,
          now,
          policy.limit,
          now,
        )
        .one();
    });
    // The alarm follows the persisted window; denied requests do not extend it.
    await this.ctx.storage.setAlarm(bucket.reset_at);
    const allowed = bucket.count <= policy.limit;
    return {
      allowed,
      remaining: Math.max(0, policy.limit - bucket.count),
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((bucket.reset_at - now) / 1000)),
    };
  }

  async alarm(): Promise<void> {
    if (
      !this.ctx.storage.sql
        .exec("select name from sqlite_master where type = 'table' and name = 'counter'")
        .toArray().length
    )
      return;
    const bucket = this.ctx.storage.sql
      .exec<{ reset_at: number }>("select reset_at from counter where id = 1")
      .toArray()[0];
    // A request can open a fresh window before an old alarm is delivered.
    if (bucket && bucket.reset_at > Date.now()) {
      await this.ctx.storage.setAlarm(bucket.reset_at);
      return;
    }
    await this.ctx.storage.deleteAll();
  }
}
