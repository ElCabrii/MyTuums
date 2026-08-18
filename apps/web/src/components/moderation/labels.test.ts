import { describe, expect, it } from "vitest";
import {
  actionBadgeVariant,
  actionIcon,
  reasonBadgeVariant,
  roleIcon,
} from "@/components/moderation/labels";

/**
 * The four classifiers over the server's stable code sets. Every one of them
 * has the same contract: a code it knows gets its own treatment, and a code it
 * has never seen falls back to the neutral one rather than inheriting another
 * code's meaning. That fallback is the part worth pinning — a reason added
 * server-side must read as ordinary here until someone classifies it, never as
 * urgent by accident.
 */
describe("moderation label classifiers", () => {
  it("reads the harm reasons as destructive and everything else neutrally", () => {
    expect(reasonBadgeVariant("illegal_content")).toBe("destructive");
    expect(reasonBadgeVariant("self_harm")).toBe("destructive");
    expect(reasonBadgeVariant("hate_speech")).toBe("destructive");
    expect(reasonBadgeVariant("underage")).toBe("destructive");
    expect(reasonBadgeVariant("spam")).toBe("secondary");
    expect(reasonBadgeVariant("a_reason_added_later")).toBe("secondary");
  });

  it("reads the actions that took something away as destructive, and their inverses neutrally", () => {
    expect(actionBadgeVariant("post_removed")).toBe("destructive");
    expect(actionBadgeVariant("user_suspended")).toBe("destructive");
    expect(actionBadgeVariant("user_banned")).toBe("destructive");
    expect(actionBadgeVariant("post_restored")).toBe("secondary");
    expect(actionBadgeVariant("user_unbanned")).toBe("secondary");
    expect(actionBadgeVariant("an_action_added_later")).toBe("secondary");
  });

  it("still returns a glyph for a code neither switch knows", () => {
    // The rendered element, not the component — see the docblock on
    // `actionIcon`. Both must survive an unknown code rather than returning
    // undefined and crashing the row that renders them.
    expect(actionIcon("an_action_added_later")).not.toBeNull();
    expect(roleIcon("a_role_added_later")).not.toBeNull();
  });
});
