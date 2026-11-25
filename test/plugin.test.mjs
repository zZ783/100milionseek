import test from "node:test";
import assert from "node:assert/strict";

import { HundredMilionSeekPlugin, PROVIDER, BASE, ORIGIN, keyOf } from "../src/index.mjs";
import { CHAT_MODEL, JUDGE_MODEL } from "../src/models.mjs";

const QUOTA = {
  "x-quota-limit": "100000000",
  "x-quota-used": "2500000",
  "x-quota-remaining": "97500000",
  "x-quota-reset": "2026-11-26T00:00:00Z",
};

// A fetch double that records what was sent and answers with a scripted reply.
function recorder(reply) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = { url: String(url), init };
    calls.push(call);
    return typeof reply === "function" ? reply(call) : reply;
  };
  return { calls, fetchImpl };
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const account = { type: "api", key: "hms-test-key" };

test("keyOf reads every shape magpie stores a key in", () => {
  assert.equal(keyOf({ type: "api", key: "hms-a" }), "hms-a");
  assert.equal(keyOf({ type: "api", key: "  hms-a  " }), "hms-a");
  assert.equal(keyOf({ apiKey: "hms-b" }), "hms-b");
  assert.equal(keyOf({ access: "hms-c" }), "hms-c");
  assert.equal(keyOf({ methods: [{ key: "hms-d" }] }), "hms-d");
  assert.equal(keyOf({ type: "api", key: "hms-e" }), "hms-e");
  assert.equal(keyOf(null), "");
  assert.equal(keyOf({}), "");
  assert.equal(keyOf({ key: 42 }), "");
});

test("config declares the provider once and never overwrites the user's own", async () => {
  const plugin = await HundredMilionSeekPlugin({}, { fetchImpl: async () => json({}) });

  const fresh = {};
  await plugin.config(fresh);
  assert.equal(fresh.provider[PROVIDER].npm, "@ai-sdk/openai-compatible");
  assert.equal(fresh.provider[PROVIDER].api, BASE);
  assert.equal(fresh.provider[PROVIDER].decide, true);
  assert.ok(fresh.provider[PROVIDER].models[CHAT_MODEL]);

  const mine = { provider: { [PROVIDER]: { name: "mine", models: {} } } };
  await plugin.config(mine);
  assert.equal(mine.provider[PROVIDER].name, "mine");
});

test("auth names the provider, its five slots and its icon", async () => {
  const plugin = await HundredMilionSeekPlugin({}, { fetchImpl: async () => json({}) });
  assert.equal(plugin.auth.provider, PROVIDER);
  assert.equal(plugin.auth.maxConcurrency, 5);
  assert.equal(plugin.auth.icon, `${ORIGIN}/favicon.svg`);
  assert.equal(plugin.auth.methods[0].type, "api");
  assert.equal(plugin.auth.checkin, undefined);
});

test("the key is asked for through a prompt, so magpie hands it to authorize", async () => {
  // Without `prompts` the host draws its own key box and calls authorize with
  // no key, which is what produced "An API key is required" at sign-in.
  const plugin = await HundredMilionSeekPlugin({}, { fetchImpl: async () => json({}) });
  const [method] = plugin.auth.methods;
  assert.ok(Array.isArray(method.prompts) && method.prompts.length >= 1);
  const keyPrompt = method.prompts.find((p) => p.key === "key");
  assert.ok(keyPrompt, "there is a prompt that submits `key`");
  assert.equal(typeof keyPrompt.validate, "function");
  // The prompt's own validation rejects an empty or multi-line key.
  assert.match(keyPrompt.validate("   "), /required/i);
  assert.match(keyPrompt.validate("hms-a\r\nb"), /line break/i);
  assert.equal(keyPrompt.validate("hms-ok"), undefined);
});

test("the sign-in check accepts a working key and remembers the allowance it saw", async () => {
  const { calls, fetchImpl } = recorder(json({ object: "list", data: [] }, 200, QUOTA));
  const plugin = await HundredMilionSeekPlugin({}, { fetchImpl });
  const out = await plugin.auth.methods[0].authorize({ key: " hms-good " });
  assert.equal(out.type, "success");
  assert.equal(out.key, "hms-good");
  assert.equal(calls[0].url, `${BASE}/models`);
  assert.equal(calls[0].init.headers.authorization, "Bearer hms-good");
});

test("the sign-in check refuses a key the service rejected", async () => {
  const plugin = await HundredMilionSeekPlugin({}, {
    fetchImpl: async () => json({ error: { message: "invalid_api_key" } }, 401),
  });
  const out = await plugin.auth.methods[0].authorize({ key: "hms-bad" });
  assert.equal(out.type, "failed");
  assert.match(out.error, /invalid_api_key/);
});

test("the sign-in check refuses an empty key without asking the service", async () => {
  const { calls, fetchImpl } = recorder(json({}));
  const plugin = await HundredMilionSeekPlugin({}, { fetchImpl });
  const out = await plugin.auth.methods[0].authorize({ key: "   " });
  assert.equal(out.type, "failed");
  assert.equal(calls.length, 0);
});

test("the sign-in check keeps the key when the service cannot be reached", async () => {
  const plugin = await HundredMilionSeekPlugin({}, {
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  const out = await plugin.auth.methods[0].authorize({ key: "hms-unreachable" });
  assert.equal(out.type, "success");
  assert.equal(out.key, "hms-unreachable");
});

test("the loader hands out the base URL, the account's key and a guarded fetch", async () => {
  const { calls, fetchImpl } = recorder(json({ choices: [] }, 200, QUOTA));
  const plugin = await HundredMilionSeekPlugin({}, { fetchImpl });
  const loader = await plugin.auth.loader(async () => account);
  assert.equal(loader.baseURL, BASE);
  assert.equal(loader.apiKey, "hms-test-key");

  await loader.fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer someone-else" },
    body: JSON.stringify({ model: CHAT_MODEL, messages: [] }),
  });
  const sent = calls[0];
  assert.equal(sent.url, `${BASE}/chat/completions`);
  // The account's key wins over whatever was passed in.
  assert.equal(sent.init.headers.get("authorization"), "Bearer hms-test-key");
  assert.equal(sent.init.headers.get("content-type"), "application/json");
  assert.equal(sent.init.method, "POST");
});

test("the loader sends nothing when no account is signed in", async () => {
  const plugin = await HundredMilionSeekPlugin({}, { fetchImpl: async () => json({}) });
  assert.deepEqual(await plugin.auth.loader(async () => undefined), {});
});

test("a request is rebuilt on the plugin's own origin", async () => {
  const { calls, fetchImpl } = recorder(json({ ok: true }, 200, QUOTA));
  const plugin = await HundredMilionSeekPlugin({}, { fetchImpl });
  const loader = await plugin.auth.loader(async () => account);
  await loader.fetch("https://elsewhere.example/v1/chat/completions?trace=1", { method: "POST", body: "{}" });
  assert.equal(calls[0].url, `${BASE}/chat/completions?trace=1`);
});

test("the judge's answer is rewritten into what magpie reads", async () => {
  const { fetchImpl } = recorder(json({ model: JUDGE_MODEL, answers: { q1: 0.8 } }));
  const plugin = await HundredMilionSeekPlugin({}, { fetchImpl });
  const loader = await plugin.auth.loader(async () => account);
  const res = await loader.fetch(`${BASE}/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: JUDGE_MODEL, questions: ["q1"], state: {} }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { model: JUDGE_MODEL, answers: { q1: { score: 0.8 } } });
});

test("the judge's own request is forwarded as magpie sent it", async () => {
  // The vendor's /systemone already takes {model, questions, state}; rewriting
  // the request would be shaping an answer that does not exist yet.
  const { calls, fetchImpl } = recorder(json({ model: JUDGE_MODEL, answers: { q1: 0.8 } }));
  const plugin = await HundredMilionSeekPlugin({}, { fetchImpl });
  const loader = await plugin.auth.loader(async () => account);
  const sent = JSON.stringify({ model: JUDGE_MODEL, questions: ["q1"], state: { turns: 3 } });
  await loader.fetch(`${BASE}/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: sent,
  });
  assert.equal(calls[0].url, `${BASE}/systemone`);
  assert.equal(calls[0].init.body, sent);
});

test("a spent allowance gets a Retry-After even when the service sent none", async () => {
  const reset = new Date(Date.now() + 3_600_000).toISOString();
  const body = {
    error: { message: "You have used today's allowance", code: "daily_quota_exceeded", reset_at: reset },
  };
  const plugin = await HundredMilionSeekPlugin({}, { fetchImpl: async () => json(body, 429) });
  const loader = await plugin.auth.loader(async () => account);
  const res = await loader.fetch(`${BASE}/chat/completions`, { method: "POST", body: "{}" });
  assert.equal(res.status, 429);
  const after = Number(res.headers.get("retry-after"));
  assert.ok(after > 3500 && after <= 3600, `retry-after was ${after}`);
  assert.equal((await res.json()).error.code, "daily_quota_exceeded");
});

test("a concurrency 429 keeps the service's own short Retry-After", async () => {
  const plugin = await HundredMilionSeekPlugin({}, {
    fetchImpl: async () =>
      json({ error: { code: "session_limit_reached" } }, 429, { "retry-after": "2" }),
  });
  const loader = await plugin.auth.loader(async () => account);
  const res = await loader.fetch(`${BASE}/chat/completions`, { method: "POST", body: "{}" });
  assert.equal(res.headers.get("retry-after"), "2");
});

test("other failures pass through untouched", async () => {
  const plugin = await HundredMilionSeekPlugin({}, {
    fetchImpl: async () => json({ error: { code: "model_not_found" } }, 404),
  });
  const loader = await plugin.auth.loader(async () => account);
  const res = await loader.fetch(`${BASE}/chat/completions`, { method: "POST", body: "{}" });
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("retry-after"), null);
});

test("usage reads the allowance from the account's own response headers", async () => {
  const plugin = await HundredMilionSeekPlugin({}, {
    fetchImpl: async () => json({ object: "list", data: [] }, 200, QUOTA),
  });
  const usage = await plugin.auth.usage(async () => account);
  assert.equal(usage.plan, "Free");
  assert.equal(usage.windows.length, 1);
  const [w] = usage.windows;
  assert.equal(w.limit, 100_000_000);
  assert.equal(w.amount, 2_500_000);
  assert.equal(w.used, 2.5);
  assert.equal(w.aside, undefined);
  assert.equal(usage.error, undefined);
});

test("usage marks the account when its key stopped working", async () => {
  const plugin = await HundredMilionSeekPlugin({}, {
    fetchImpl: async () => json({ error: { code: "invalid_api_key" } }, 401),
  });
  const usage = await plugin.auth.usage(async () => account);
  assert.equal(usage.signIn, "expired");
  assert.ok(usage.error);
});

test("usage shows an unknown allowance rather than a made-up number", async () => {
  const plugin = await HundredMilionSeekPlugin({}, { fetchImpl: async () => json({ object: "list" }) });
  const usage = await plugin.auth.usage(async () => account);
  assert.equal(usage.windows.length, 1);
  assert.equal("used" in usage.windows[0], false);
  assert.equal(usage.windows[0].limit, undefined);
  assert.ok(usage.windows[0].display);
});

test("usage falls back to the allowance a request already reported", async () => {
  let reply = () => json({ choices: [] }, 200, QUOTA);
  const plugin = await HundredMilionSeekPlugin({}, { fetchImpl: async (url, init) => reply(url, init) });
  const loader = await plugin.auth.loader(async () => account);
  await loader.fetch(`${BASE}/chat/completions`, { method: "POST", body: "{}" });
  reply = () => {
    throw new TypeError("fetch failed");
  };
  const usage = await plugin.auth.usage(async () => account);
  assert.equal(usage.windows[0].limit, 100_000_000);
  assert.ok(usage.error);
});

test("usage says nothing when no account is signed in", async () => {
  const plugin = await HundredMilionSeekPlugin({}, { fetchImpl: async () => json({}) });
  assert.deepEqual(await plugin.auth.usage(async () => undefined), {});
});

test("the models hook offers what the account can actually use", async () => {
  const listing = { object: "list", data: [{ id: CHAT_MODEL }, { id: JUDGE_MODEL }] };
  const plugin = await HundredMilionSeekPlugin({}, { fetchImpl: async () => json(listing, 200, QUOTA) });
  const before = { [CHAT_MODEL]: { name: "already here" } };
  const models = await plugin.provider.models({ models: before }, { auth: account });
  assert.deepEqual(Object.keys(models).sort(), [CHAT_MODEL, JUDGE_MODEL].sort());
  assert.equal(models[CHAT_MODEL].api.id, CHAT_MODEL);
  assert.equal(models[JUDGE_MODEL].decides, true);
});

test("the models hook keeps the list it has when the read fails", async () => {
  const plugin = await HundredMilionSeekPlugin({}, {
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  const before = { [CHAT_MODEL]: { name: "already here" } };
  assert.equal(await plugin.provider.models({ models: before }, { auth: account }), before);
});

test("the models hook keeps the list it has when there is no account", async () => {
  const plugin = await HundredMilionSeekPlugin({}, { fetchImpl: async () => json({}) });
  const before = { [CHAT_MODEL]: { name: "already here" } };
  assert.equal(await plugin.provider.models({ models: before }), before);
});
