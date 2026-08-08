import { describe, expect, it } from "vitest";
import {
  APPEALABLE_ACTIONS,
  INVERSE_ACTION,
  MODERATION_ACTION_CODES,
  POST_REPORT_REASONS,
  USER_REPORT_REASONS,
} from "./constants.js";

describe("MODERATION_ACTION_CODES", () => {
  it("lists the nine stable codes — the schema check constraint's list", () => {
    expect(MODERATION_ACTION_CODES).toEqual([
      "post_removed",
      "post_restored",
      "user_suspended",
      "user_unsuspended",
      "user_banned",
      "user_unbanned",
      "role_changed",
      "case_resolved",
      "appeal_resolved",
    ]);
  });

  it("contains no duplicates — the check constraint on moderation_action.action accepts exactly these", () => {
    expect(new Set(MODERATION_ACTION_CODES).size).toBe(MODERATION_ACTION_CODES.length);
  });
});

describe("INVERSE_ACTION", () => {
  it("maps each appealable action to a real, distinct code", () => {
    const values = Object.values(INVERSE_ACTION);
    expect(values.every((code) => MODERATION_ACTION_CODES.includes(code))).toBe(true);
    expect(new Set(values).size).toBe(values.length);
  });

  it("covers exactly the four appealable actions — nothing more, nothing less", () => {
    expect(Object.keys(INVERSE_ACTION).sort()).toEqual([
      "post_removed",
      "role_changed",
      "user_banned",
      "user_suspended",
    ]);
  });

  it("role_changed maps to itself — the restore is another role change, logging the full swing", () => {
    expect(INVERSE_ACTION.role_changed).toBe("role_changed");
  });

  it("the non-appealable actions (restores, resolutions) have no inverse by construction", () => {
    for (const code of [
      "post_restored",
      "user_unsuspended",
      "user_unbanned",
      "case_resolved",
      "appeal_resolved",
    ]) {
      expect(Object.keys(INVERSE_ACTION)).not.toContain(code);
    }
  });
});

describe("APPEALABLE_ACTIONS", () => {
  it("is derived from INVERSE_ACTION — the two lists can never drift", () => {
    expect(APPEALABLE_ACTIONS).toEqual(Object.keys(INVERSE_ACTION));
  });

  it("is a non-empty subset of the action codes", () => {
    expect(APPEALABLE_ACTIONS.length).toBeGreaterThan(0);
    expect(APPEALABLE_ACTIONS.every((code) => MODERATION_ACTION_CODES.includes(code))).toBe(true);
  });
});

describe("report reason enums vs the schema's check constraint", () => {
  /**
   * The exact list `report_reason` accepts, copied from the check constraint
   * in packages/db/src/schema/app.ts (the union of both per-kind sets). The
   * DB side is additionally pinned by db:check (drizzle-kit drift) and by the
   * integration suite exercising every code through the real procedure.
   */
  const checkConstraintCodes = [
    "spam",
    "harassment",
    "hate_speech",
    "misinformation",
    "self_harm",
    "illegal_content",
    "nsfw",
    "impersonation",
    "underage",
  ];

  it("the two per-kind sets union to exactly the check constraint's list — the shared codes (spam, harassment) dedupe", () => {
    const union = [...new Set([...POST_REPORT_REASONS, ...USER_REPORT_REASONS])];
    expect(union.sort()).toEqual([...checkConstraintCodes].sort());
  });

  it("every code a procedure accepts is one the database row can hold — and vice versa", () => {
    for (const code of POST_REPORT_REASONS) {
      expect(checkConstraintCodes).toContain(code);
    }
    for (const code of USER_REPORT_REASONS) {
      expect(checkConstraintCodes).toContain(code);
    }
    for (const code of checkConstraintCodes) {
      expect(
        (POST_REPORT_REASONS as readonly string[]).includes(code) ||
          (USER_REPORT_REASONS as readonly string[]).includes(code),
      ).toBe(true);
    }
  });

  it("each set is distinct and non-empty — no duplicate codes, no empty picker", () => {
    expect(new Set(POST_REPORT_REASONS).size).toBe(POST_REPORT_REASONS.length);
    expect(new Set(USER_REPORT_REASONS).size).toBe(USER_REPORT_REASONS.length);
    expect(POST_REPORT_REASONS.length).toBeGreaterThan(0);
    expect(USER_REPORT_REASONS.length).toBeGreaterThan(0);
  });
});
