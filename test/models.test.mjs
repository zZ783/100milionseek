import test from "node:test";
import assert from "node:assert/strict";

import {
  CHAT_MODEL,
  JUDGE_MODEL,
  isJudge,
  flagMap,
  configModels,
  fullModel,
  fullModels,
  modelIDs,
  accountModels,
  smallOf,
} from "../src/models.mjs";

const BASE = "https://100milionseek.top/v1";
const ID = "hundred-milion-seek";

test("isJudge recognises the judge family and nothing else", () => {
  assert.equal(isJudge(JUDGE_MODEL), true);
  assert.equal(isJudge("jev-2.0"), true);
  assert.equal(isJudge("JEV-anything"), true);
  assert.equal(isJudge(CHAT_MODEL), false);
  assert.equal(isJudge(""), false);
  assert.equal(isJudge(undefined), false);
});

test("configModels describes the chat model and the judge", () => {
  const models = configModels();
  const chat = models[CHAT_MODEL];
  assert.equal(chat.limit.context, 198_000);
  assert.equal(chat.limit.output, 65_536);
  assert.equal(chat.tool_call, true);
  assert.equal(chat.reasoning, false);
  assert.deepEqual(chat.cost, { input: 0, output: 0 });
  // Never `free: true`: every token spends the day's allowance.
  assert.equal("free" in chat, false);

  const judge = models[JUDGE_MODEL];
  assert.equal(judge.decides, true);
  assert.equal(judge.tool_call, false);
});

test("configModels turns reasoning on only when asked", () => {
  assert.equal(configModels({ reasoning: true })[CHAT_MODEL].reasoning, true);
});

test("flagMap fills a capability map and never returns an empty one", () => {
  assert.deepEqual(flagMap(["text", "image"]), { text: true, image: true });
  assert.deepEqual(flagMap([]), { text: true });
  assert.deepEqual(flagMap(undefined), { text: true });
  assert.deepEqual(flagMap(["audio"], ["text"]), { audio: true });
});

test("fullModel expands a config entry into a whole Model", () => {
  const small = configModels({ reasoning: true })[CHAT_MODEL];
  const model = fullModel(ID, CHAT_MODEL, small, BASE);
  assert.equal(model.id, CHAT_MODEL);
  assert.equal(model.providerID, ID);
  assert.equal(model.api.id, CHAT_MODEL);
  assert.equal(model.api.url, BASE);
  assert.equal(model.api.npm, "@ai-sdk/openai-compatible");
  assert.equal(model.limit.context, 198_000);
  assert.equal(model.capabilities.reasoning, true);
  assert.equal(model.capabilities.toolcall, true);
  assert.equal(model.capabilities.attachment, false);
  assert.deepEqual(model.capabilities.input, { text: true });
  assert.deepEqual(model.capabilities.output, { text: true });
  assert.deepEqual(model.cost, { input: 0, output: 0, cache: { read: 0, write: 0 } });
  assert.equal(model.status, "active");
  assert.equal("decides" in model, false);
});

test("fullModel keeps decides on the judge", () => {
  const model = fullModel(ID, JUDGE_MODEL, configModels()[JUDGE_MODEL], BASE);
  assert.equal(model.decides, true);
  assert.equal(model.limit.output, 4_096);
  assert.equal(model.capabilities.toolcall, false);
});

test("fullModel survives a missing entry by falling back to the chat limits", () => {
  const model = fullModel(ID, "brand-new-model", undefined, BASE);
  assert.equal(model.limit.context, 198_000);
  assert.equal(model.limit.output, 65_536);
  assert.equal(model.name, "brand-new-model");
});

test("fullModels expands the whole table", () => {
  const models = fullModels(configModels(), { baseURL: BASE, providerID: ID });
  assert.deepEqual(Object.keys(models).sort(), [CHAT_MODEL, JUDGE_MODEL].sort());
  assert.equal(models[JUDGE_MODEL].decides, true);
});

test("modelIDs reads every listing shape the API might use", () => {
  assert.deepEqual(modelIDs({ object: "list", data: [{ id: "a" }, { id: "b" }] }), ["a", "b"]);
  assert.deepEqual(modelIDs({ models: ["a", "b"] }), ["a", "b"]);
  assert.deepEqual(modelIDs(["a", { id: "b" }]), ["a", "b"]);
  // A model served twice is offered once.
  assert.deepEqual(modelIDs({ data: [{ id: "a" }, { id: "a" }] }), ["a"]);
  assert.deepEqual(modelIDs({ data: [{ id: "" }, { object: "model" }] }), []);
  assert.deepEqual(modelIDs(null), []);
  assert.deepEqual(modelIDs("nonsense"), []);
});

test("accountModels describes the listed ids and always offers the judge", () => {
  const template = configModels();
  const models = accountModels([CHAT_MODEL], template, { baseURL: BASE, providerID: ID });
  assert.deepEqual(Object.keys(models).sort(), [CHAT_MODEL, JUDGE_MODEL].sort());
  assert.equal(models[CHAT_MODEL].api.id, CHAT_MODEL);
  assert.equal(models[JUDGE_MODEL].decides, true);
});

test("accountModels gives an unknown listed id the chat model's shape", () => {
  const models = accountModels(["some-new-model"], configModels(), {
    baseURL: BASE,
    providerID: ID,
    fallback: configModels()[CHAT_MODEL],
  });
  assert.equal(models["some-new-model"].id, "some-new-model");
  assert.equal(models["some-new-model"].api.id, "some-new-model");
  assert.equal(models["some-new-model"].limit.context, 198_000);
  assert.equal(models[JUDGE_MODEL].decides, true);
});

test("accountModels never invents a judge shape for an unknown jev- id", () => {
  const models = accountModels(["jev-9.9"], configModels(), {
    baseURL: BASE,
    providerID: ID,
    fallback: configModels()[CHAT_MODEL],
  });
  // Unknown judge ids are not offered as chat models; the known judge still is.
  assert.equal(models["jev-9.9"], undefined);
  assert.ok(models[JUDGE_MODEL]);
});

test("accountModels falls back to the whole table when nothing was listed", () => {
  const models = accountModels([], configModels(), { baseURL: BASE, providerID: ID });
  assert.deepEqual(Object.keys(models).sort(), [CHAT_MODEL, JUDGE_MODEL].sort());
});

test("smallOf turns either model shape back into the config entry shape", () => {
  const full = fullModel(ID, CHAT_MODEL, configModels({ reasoning: true })[CHAT_MODEL], BASE);
  const small = smallOf(full, CHAT_MODEL);
  assert.equal(small.name, full.name);
  assert.equal(small.id, CHAT_MODEL);
  assert.deepEqual(small.limit, { context: 198_000, output: 65_536 });
  assert.equal(small.reasoning, true);
  assert.equal(small.tool_call, true);
  assert.equal(small.attachment, false);
  assert.deepEqual(small.modalities, { input: ["text"], output: ["text"] });
  assert.equal(smallOf(undefined, "x"), undefined);
});
