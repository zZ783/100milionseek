import test from "node:test";
import assert from "node:assert/strict";

import { loadOf } from "../src/load.mjs";

// The shapes /api/status really returns, trimmed to the fields the load reads.
const status = (over = {}) => ({
  state: "ok",
  sessions_in_flight: 0,
  allowance: { session_limit: 5 },
  upstream: { inflight: 100, capacity: 1000 },
  ...over,
});

test("load is how much of the upstream's capacity is already in use", () => {
  assert.equal(loadOf(status()), 10);
  assert.equal(loadOf(status({ upstream: { inflight: 500, capacity: 1000 } })), 50);
  assert.equal(loadOf(status({ upstream: { inflight: 999, capacity: 1000 } })), 100);
});

test("an idle service is a real zero", () => {
  assert.equal(loadOf(status({ upstream: { inflight: 0, capacity: 1000 } })), 0);
});

test("a load above one hundred is passed on, not clipped to it", () => {
  // Over-subscribed is worth showing; magpie clamps at 10000 itself.
  assert.equal(loadOf(status({ upstream: { inflight: 1200, capacity: 1000 } })), 120);
});

test("the service-wide session count is not this account's queue", () => {
  // `sessions_in_flight` counts every user while `session_limit` is per
  // account; reading one against the other would report a permanent 100.
  const out = loadOf(status({ sessions_in_flight: 977, allowance: { session_limit: 5 } }));
  assert.equal(out, 10);
});

test("a degraded upstream is not treated as full", () => {
  // It reads "degraded" whenever it is retrying anything, which is most of the
  // day; calling that full would route every request away for ever.
  assert.equal(loadOf(status({ state: "degraded" })), 10);
});

test("counts that cannot be read say nothing rather than zero", () => {
  assert.equal(loadOf(status({ upstream: { inflight: "many", capacity: 1000 } })), null);
  assert.equal(loadOf(status({ upstream: { inflight: 5, capacity: 0 } })), null);
  assert.equal(loadOf(status({ upstream: {} })), null);
  assert.equal(loadOf(null), null);
  assert.equal(loadOf("nonsense"), null);
});

test("the figure is always a whole number magpie can use", () => {
  const out = loadOf(status({ upstream: { inflight: 1, capacity: 3 } }));
  assert.equal(out, 33);
});
