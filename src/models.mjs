// The models 100milionseek serves, and how they read on magpie's side.
//
// The service documents exactly two: one chat model on the free daily
// allowance, and one judge model (JEV) that answers routing questions instead
// of holding a conversation. The judge is what `decide` / `decides` exist for:
// with them, magpie offers it as a classifier for route groups and keeps it
// out of the chat model list.
//
// Two shapes are needed. `config` takes the small table (name, limit,
// tool_call…); `provider.models` takes full OpenCode Model objects (api,
// capabilities, cost). `configModels` builds the first, `fullModel` expands an
// entry of the first into the second, so both hooks describe one model alike.

export const CHAT_SDK = "@ai-sdk/openai-compatible";
export const CHAT_MODEL = "deepseek-v4.1-flash-free";
export const JUDGE_MODEL = "jev-1.13-free";
export const JUDGE_PREFIX = /^jev-/i;

// 198K in, 64K out — what /api/status reports for the chat model.
const CHAT_CONTEXT = 198_000;
const CHAT_OUTPUT = 65_536;
const JUDGE_OUTPUT = 4_096;

export function isJudge(id) {
  return typeof id === "string" && JUDGE_PREFIX.test(id);
}

// A modality list as the capability map OpenCode reads ({text: true, …}).
export function flagMap(list, fallback = ["text"]) {
  const out = {};
  for (const m of Array.isArray(list) ? list : []) {
    if (typeof m === "string" && m) out[m] = true;
  }
  if (Object.keys(out).length) return out;
  for (const m of fallback) out[m] = true;
  return out;
}

// The `config` hook's model table: the smaller shape OpenCode and magpie take
// there (name, limit, tool_call, cost…), not a full Model object.
export function configModels({ reasoning = false } = {}) {
  return {
    [CHAT_MODEL]: {
      name: "DeepSeek V4.1 Flash (free)",
      limit: { context: CHAT_CONTEXT, output: CHAT_OUTPUT },
      // Thinking stays off unless the plugin option turns it on: a proxy in
      // front of the model may reject reasoning parameters, and a chat that
      // fails is worse than one without a visible reasoning pane.
      reasoning,
      tool_call: true,
      attachment: false,
      modalities: { input: ["text"], output: ["text"] },
      // Charged in tokens against the daily allowance, never in money. No
      // `free` flag: magpie reads that as "does not spend the plan's quota",
      // and this model spends every token it answers.
      cost: { input: 0, output: 0 },
    },
    [JUDGE_MODEL]: {
      name: "JEV 1.13 (judge)",
      decides: true,
      limit: { context: CHAT_CONTEXT, output: JUDGE_OUTPUT },
      reasoning: false,
      tool_call: false,
      attachment: false,
      modalities: { input: ["text"], output: ["text"] },
      cost: { input: 0, output: 0 },
    },
  };
}

// An entry of the config table as the full Model the `provider.models` hook
// returns. `id` is what the agent writes after the provider id; `api.id` is
// what goes in the request body, and stays the service's own id.
export function fullModel(providerID, id, small, baseURL, npm = CHAT_SDK) {
  const known = small ?? {};
  const modalities = known.modalities ?? {};
  const limit = known.limit ?? {};
  const model = {
    id,
    providerID,
    name: known.name ?? id,
    api: { id: known.id ?? id, url: baseURL, npm },
    limit: {
      context: Number.isFinite(limit.context) ? limit.context : CHAT_CONTEXT,
      output: Number.isFinite(limit.output) ? limit.output : CHAT_OUTPUT,
    },
    capabilities: {
      temperature: true,
      reasoning: known.reasoning === true,
      toolcall: known.tool_call !== false,
      attachment: known.attachment === true,
      input: flagMap(modalities.input),
      output: flagMap(modalities.output),
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    variants: {},
    release_date: "",
    status: "active",
  };
  // magpie reads `decides` on the models hook too, and it is what turns the
  // judge into a classifier instead of a chat model.
  if (known.decides === true) model.decides = true;
  return model;
}

// A whole config table as full Models, for the fallback list.
export function fullModels(template, { baseURL, npm = CHAT_SDK, providerID } = {}) {
  const out = {};
  for (const [id, small] of Object.entries(template ?? {})) {
    out[id] = fullModel(providerID, id, small, baseURL, npm);
  }
  return out;
}

// The ids in a GET /v1/models answer, in the order the API gave them.
export function modelIDs(listing) {
  const rows = Array.isArray(listing)
    ? listing
    : Array.isArray(listing?.data)
      ? listing.data
      : Array.isArray(listing?.models)
        ? listing.models
        : [];
  const ids = [];
  for (const row of rows) {
    const id = typeof row === "string" ? row : row?.id;
    if (typeof id === "string" && id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// The account's own model list, for the `provider.models` hook.
//
// A listed id the plugin knows gets its own description; one it does not know
// (a model added upstream after this release) borrows `fallback`'s shape
// instead of vanishing, since the service only lists models it serves. The
// judge is always offered even when the listing omits it: magpie refuses to
// use a classifier it was never given.
export function accountModels(ids, template, { baseURL, npm = CHAT_SDK, providerID, fallback } = {}) {
  const out = {};
  const spare = fallback ?? template?.[CHAT_MODEL];
  let described = 0;
  for (const id of ids ?? []) {
    const small = template?.[id] ?? (isJudge(id) ? undefined : spare);
    if (!small) continue;
    out[id] = fullModel(providerID, id, small, baseURL, npm);
    described += 1;
  }
  // Nothing in the listing could be described (an empty list, or every id
  // unknown): the whole table is more useful than the judge alone.
  if (!described) return fullModels(template, { baseURL, npm, providerID });
  if (!out[JUDGE_MODEL] && template?.[JUDGE_MODEL]) {
    out[JUDGE_MODEL] = fullModel(providerID, JUDGE_MODEL, template[JUDGE_MODEL], baseURL, npm);
  }
  return out;
}

// Either shape of a model — the config table's small one, or a full Model
// magpie handed back — as the small one, so `fullModel` can rebuild it.
export function smallOf(model, id) {
  if (!model || typeof model !== "object") return undefined;
  const caps = model.capabilities ?? {};
  const limit = model.limit ?? {};
  const modalities = model.modalities ?? {
    input: Object.keys(caps.input ?? {}).filter((k) => caps.input[k]),
    output: Object.keys(caps.output ?? {}).filter((k) => caps.output[k]),
  };
  return {
    name: model.name,
    id: model.api?.id ?? id,
    limit: { context: limit.context, output: limit.output },
    reasoning: model.reasoning ?? caps.reasoning,
    tool_call: model.tool_call ?? caps.toolcall,
    attachment: model.attachment ?? caps.attachment,
    modalities,
    decides: model.decides,
  };
}
