import { describe, expect, it } from "vitest";
import { canManageRole, roleAtLeast, roleRank, USER_ROLES } from "./roles.js";

describe("roleRank", () => {
  it("orders the four roles weakest to strongest — the index IS the rank", () => {
    expect(USER_ROLES).toEqual(["user", "moderator", "staff", "admin"]);
    expect(roleRank("user")).toBe(0);
    expect(roleRank("moderator")).toBe(1);
    expect(roleRank("staff")).toBe(2);
    expect(roleRank("admin")).toBe(3);
  });

  it("ranks an unknown role -1 — a check that can't see a role it knows nothing about must not pass", () => {
    expect(roleRank("superuser")).toBe(-1);
    expect(roleRank("")).toBe(-1);
  });
});

describe("roleAtLeast", () => {
  it("is true at and above the minimum, false below", () => {
    expect(roleAtLeast("moderator", "moderator")).toBe(true);
    expect(roleAtLeast("staff", "moderator")).toBe(true);
    expect(roleAtLeast("admin", "moderator")).toBe(true);
    expect(roleAtLeast("user", "moderator")).toBe(false);
  });

  it("gates everyone at user — the weakest minimum", () => {
    expect(roleAtLeast("user", "user")).toBe(true);
    expect(roleAtLeast("admin", "user")).toBe(true);
  });

  it("an unknown role fails even the weakest minimum", () => {
    expect(roleAtLeast("superuser", "user")).toBe(false);
  });
});

describe("canManageRole", () => {
  it("requires a strictly greater rank — same rank cannot manage same rank", () => {
    expect(canManageRole("moderator", "moderator")).toBe(false);
    expect(canManageRole("staff", "staff")).toBe(false);
    expect(canManageRole("admin", "admin")).toBe(false);
  });

  it("an actor always holds their own rank, so acting on yourself is covered by the same rule", () => {
    // The rank guard's load-bearing property: nobody can suspend, ban or
    // demote themselves, with no separate self-check needed.
    expect(canManageRole("admin", "admin")).toBe(false);
    expect(canManageRole("moderator", "moderator")).toBe(false);
  });

  it("allows acting down exactly one rank and every rank below", () => {
    expect(canManageRole("moderator", "user")).toBe(true);
    expect(canManageRole("staff", "moderator")).toBe(true);
    expect(canManageRole("staff", "user")).toBe(true);
    expect(canManageRole("admin", "staff")).toBe(true);
    expect(canManageRole("admin", "user")).toBe(true);
  });

  it("refuses acting up or across — the hierarchy is one-directional", () => {
    expect(canManageRole("user", "moderator")).toBe(false);
    expect(canManageRole("moderator", "staff")).toBe(false);
    expect(canManageRole("staff", "admin")).toBe(false);
  });

  it("an unknown role refuses nothing the actor side could rely on: an unknown actor can't act, an unknown target ranks below everyone", () => {
    // rank(-1) is never > anything, so an unknown actor is inert; and a
    // target the system can't place is treated as below every known role, so
    // a known actor may act on it (the guard only protects roles the system
    // knows rank at or above the actor's).
    expect(canManageRole("superuser", "user")).toBe(false);
    expect(canManageRole("superuser", "admin")).toBe(false);
    expect(canManageRole("admin", "superuser")).toBe(true);
  });
});
