import assert from "node:assert/strict";
import test from "node:test";
import { requiresTls, sslModeForConnection } from "./connection-options.js";

void test("keeps TLS disabled for loopback and single-label service URLs", () => {
  for (const url of [
    "postgresql://user:password@localhost:5432/mytuums",
    "postgresql://user:password@127.0.0.1:5432/mytuums",
    "postgresql://user:password@[::1]:5432/mytuums",
    "postgresql://user:password@postgres:5432/mytuums",
  ]) {
    assert.equal(requiresTls(url), false, url);
    assert.equal(sslModeForConnection(url), false, url);
  }
});

void test("uses postgres.js verify-full for dotted database hosts", () => {
  for (const url of [
    "postgresql://user:password@db.example.com:5432/mytuums",
    "postgresql://user:password@postgres.railway.internal:5432/mytuums",
  ]) {
    assert.equal(requiresTls(url), true, url);
    assert.equal(sslModeForConnection(url), "verify-full", url);
  }
});
