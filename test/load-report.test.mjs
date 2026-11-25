import test from "node:test";
import assert from "node:assert/strict";

import { HundredMilionSeekPlugin, PROVIDER } from "../src/index.mjs";
import { CHAT_MODEL, JUDGE_MODEL } from "../src/models.mjs";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const status = (over = {}) => ({
  state: "ok",
  upstream: { inflight: 500, capacity: 1000 },
  ...over,
});

// The host hands `input.magpie.load` over and records what was reported.
function host(reply) {
  const reports = [];
  return {
    reports,
    input: {
      magpie: {
        load: (provider, loads) => {
          reports.push({ provider, loads });
          return Object.keys(loads).length;
        },
      },
    },
    fetchImpl: async (url, init) => (typeof reply === "function" ? reply(url, init) : reply),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

test("every model of the provider carries the upstream's load", async () => {
  const h = host(json(status()));
  await HundredMilionSeekPlugin(h.input, { fetchImpl: h.fetchImpl });
  await settle();

  assert.equal(h.reports.length, 1);
  const [report] = h.reports;
  assert.equal(report.provider, PROVIDER);
  assert.deepEqual(Object.keys(report.loads).sort(), [CHAT_MODEL, JUDGE_MODEL].sort());
  assert.equal(report.loads[CHAT_MODEL], 50);
  assert.equal(report.loads[JUDGE_MODEL], 50);
});

test("a load the service did not give is not reported at all", async () => {
  // Reporting 0 would tell magpie the relay is idle, which it does not know.
  const h = host(json({}));
  await HundredMilionSeekPlugin(h.input, { fetchImpl: h.fetchImpl });
  await settle();
  assert.equal(h.reports.length, 0);
});

test("a failing status read is silent, not fatal", async () => {
  const h = host(async () => {
    throw new TypeError("fetch failed");
  });
  const plugin = await HundredMilionSeekPlugin(h.input, { fetchImpl: h.fetchImpl });
  await settle();
  assert.equal(h.reports.length, 0);
  // And the rest of the plugin still works.
  assert.equal(plugin.auth.provider, PROVIDER);
});

test("an HTTP error from the status endpoint is not a load of zero", async () => {
  const h = host(json({ error: "nope" }, 503));
  await HundredMilionSeekPlugin(h.input, { fetchImpl: h.fetchImpl });
  await settle();
  assert.equal(h.reports.length, 0);
});

test("no magpie on the host means no polling", async () => {
  // A plain OpenCode host passes no `magpie`, and the plugin must not fetch.
  let asked = 0;
  await HundredMilionSeekPlugin({}, {
    fetchImpl: async () => {
      asked += 1;
      return json(status());
    },
  });
  await settle();
  assert.equal(asked, 0);
});

test("the report can be turned off", async () => {
  const h = host(json(status()));
  await HundredMilionSeekPlugin(h.input, { fetchImpl: h.fetchImpl, load: false });
  await settle();
  assert.equal(h.reports.length, 0);
});
