import { DurableObject } from "cloudflare:workers";

/** Better Auth's inactivity-window semantics, persisted per opaque auth key. */
export class AuthRateLimitCounter extends DurableObject {
  #ensureTable(): void {
    this.ctx.storage.sql.exec(`create table if not exists budget (
      id integer primary key check (id = 1), count integer not null,
      last_request integer not null, expires_at integer not null
    )`);
  }

  async consume(rule: {
    window: number;
    max: number;
  }): Promise<{ allowed: boolean; retryAfter: number | null }> {
    if (
      !Number.isSafeInteger(rule.max) ||
      rule.max < 1 ||
      rule.max > 1_000_000 ||
      !Number.isSafeInteger(rule.window) ||
      rule.window < 1 ||
      rule.window > 86_400
    )
      throw new Error("Invalid auth rate limit rule.");
    const now = Date.now();
    const window = rule.window * 1000;
    const result = this.ctx.storage.transactionSync(() => {
      this.#ensureTable();
      const old = this.ctx.storage.sql
        .exec<{ count: number; last_request: number }>(
          "select count, last_request from budget where id = 1",
        )
        .toArray()[0];
      const expired = !old || now - old.last_request > window;
      const allowed = expired || old.count < rule.max;
      const lastRequest = allowed ? now : old.last_request;
      // Better Auth resets strictly after the window, not at equality. Keep
      // storage one additional millisecond so the alarm cannot relax that rule.
      const expiresAt = lastRequest + window + 1;
      if (allowed)
        this.ctx.storage.sql.exec(
          `insert into budget values (1, ?, ?, ?) on conflict(id) do update set
         count = excluded.count, last_request = excluded.last_request, expires_at = excluded.expires_at`,
          expired ? 1 : old.count + 1,
          lastRequest,
          expiresAt,
        );
      else this.ctx.storage.sql.exec("update budget set expires_at = ? where id = 1", expiresAt);
      return {
        allowed,
        expiresAt,
        retryAfter: allowed ? null : Math.max(1, Math.ceil((lastRequest + window - now) / 1000)),
      };
    });
    await this.ctx.storage.setAlarm(result.expiresAt);
    return { allowed: result.allowed, retryAfter: result.retryAfter };
  }

  get(): { count: number; lastRequest: number } | null {
    if (
      !this.ctx.storage.sql
        .exec("select name from sqlite_master where type = 'table' and name = 'budget'")
        .toArray().length
    )
      return null;
    return (
      this.ctx.storage.sql
        .exec<{ count: number; lastRequest: number }>(
          "select count, last_request as lastRequest from budget where id = 1 and expires_at > ?",
          Date.now(),
        )
        .toArray()[0] ?? null
    );
  }

  async set(value: { count: number; lastRequest: number }): Promise<void> {
    if (
      !Number.isSafeInteger(value.count) ||
      value.count < 0 ||
      value.count > 1_000_000 ||
      !Number.isSafeInteger(value.lastRequest) ||
      value.lastRequest < 0 ||
      value.lastRequest > Date.now() + 60_000
    )
      throw new Error("Invalid auth rate limit state.");
    // Legacy set has no rule argument. Retain at most the longest accepted
    // window; normal atomic consumption replaces this with the actual deadline.
    const expiresAt = value.lastRequest + 86_400_001;
    this.ctx.storage.transactionSync(() => {
      this.#ensureTable();
      this.ctx.storage.sql.exec(
        `insert into budget values (1, ?, ?, ?)
        on conflict(id) do update set count = excluded.count,
        last_request = excluded.last_request, expires_at = excluded.expires_at`,
        value.count,
        value.lastRequest,
        expiresAt,
      );
    });
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, expiresAt));
  }

  async alarm(): Promise<void> {
    if (
      !this.ctx.storage.sql
        .exec("select name from sqlite_master where type = 'table' and name = 'budget'")
        .toArray().length
    )
      return;
    const state = this.ctx.storage.sql
      .exec<{ expires_at: number }>("select expires_at from budget where id = 1")
      .toArray()[0];
    if (state && state.expires_at > Date.now()) {
      await this.ctx.storage.setAlarm(state.expires_at);
      return;
    }
    await this.ctx.storage.deleteAll();
  }
}
