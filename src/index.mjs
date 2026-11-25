// The 100milionseek provider, as magpie's plugin host calls it.
//
// The service is an OpenAI-compatible proxy: one chat model on a free daily
// token allowance, plus a judge model (JEV) that answers routing questions.
// Two things make it need a plugin rather than a plain provider block:
//
//   - the daily allowance is only ever reported in x-quota-* response headers,
//     so `usage` has to read a response to know it;
//   - the judge answers {model, questions, state} with one probability per
//     question, which `decides` + `decide: true` hand to magpie as a classifier
//     once the answers are in the shape it reads.
//
// Everything else — models, base URL, sign-in — is a normal API key provider.

import { quotaWindow, planOf, nextUtcMidnight } from "./quota.mjs";
import { CHAT_SDK, CHAT_MODEL, JUDGE_MODEL, configModels, accountModels, modelIDs } from "./models.mjs";
import { normalizeSystemOne } from "./systemone.mjs";
import { loadOf } from "./load.mjs";

export const PROVIDER = "hundred-milion-seek";
export const ORIGIN = "https://100milionseek.top";
export const BASE = `${ORIGIN}/v1`;

const TIMEOUT_MS = 15_000;

// The key an account was signed in with, however magpie stored it: an api
// account is {type:"api", key}, older multi-method accounts keep it per
// method, and a keyless-style account may only carry `access`.
export function keyOf(auth) {
  if (!auth || typeof auth !== "object") return "";
  const key = auth.key ?? auth.apiKey ?? auth.access ?? auth.methods?.[0]?.key ?? "";
  return typeof key === "string" ? key.trim() : "";
}

export async function HundredMilionSeekPlugin(input, options = {}) {
  const baseURL = String(options.baseURL ?? BASE).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const reasoning = options.reasoning === true;
  const reportLoad = options.load !== false;
  const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : TIMEOUT_MS;

  // The model table both hooks describe from. `config` publishes it; the
  // models hook starts from it.
  const template = configModels({ reasoning });

  // Load is per model in magpie, and this service has one upstream behind all
  // of them: every model gets the same figure. Started here rather than in a
  // hook, so a host that only ever calls `config` still gets the report.
  if (reportLoad) publishLoad();

  // The newest allowance any response reported, per account key. Only a
  // fallback for `usage` when its own read fails: keeping it under the key
  // keeps two signed-in keys from showing each other's spend.
  const seen = new Map();
  const remember = (key, headers, now) => {
    if (!key) return;
    const window = quotaWindow(headers, now);
    if (window) seen.set(key, { window, at: now });
  };

  // One account's worth of headers, from a GET the caller is making anyway.
  async function readAllowance(apiKey) {
    const res = await fetchImpl(`${baseURL}/models`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
    const window = quotaWindow(res.headers);
    if (window) seen.set(apiKey, { window, at: Date.now() });
    // Nothing reads this body; drop it rather than hold the connection open.
    try {
      await res.body?.cancel?.();
    } catch {
      /* already gone */
    }
    return { res, window };
  }

  // How busy the service is, for magpie's "busy models go later" routing.
  // /api/status needs no key; `loadOf` turns it into a percentage.
  async function readLoad() {
    const res = await fetchImpl(`${ORIGIN}/api/status`, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`status returned HTTP ${res.status}`);
    return loadOf(await res.json());
  }

  // Load is per model in magpie, and one upstream stands behind every model
  // here, so each of them carries the same figure.
  function publishLoad() {
    // Only magpie reads load, and it hands the function over with `input`.
    if (typeof input?.magpie?.load !== "function") return;
    const once = () => {
      readLoad()
        .then((load) => {
          if (load === null) return;
          const loads = {};
          for (const id of Object.keys(template)) loads[id] = load;
          input.magpie.load(PROVIDER, loads);
        })
        // Unreadable load is "unknown", never 0: a blind report would hide a
        // busy service instead of showing it.
        .catch(() => {});
    };
    once();
    // magpie forgets a model's load five minutes after it was reported.
    const timer = setInterval(once, 120_000);
    timer?.unref?.(); // never hold the host open for a report
  }

  // The daily allowance is a hard stop until 00:00 UTC. The service says so in
  // Retry-After already; when it doesn't, the reset instant does.
  async function spentAllowance(res) {
    const text = await res.text().catch(() => "");
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* non-JSON body: pass its own words through */
    }
    const headers = new Headers(res.headers);
    if (!headers.get("retry-after")) {
      const reset = body?.error?.reset_at ?? headers.get("x-quota-reset");
      const at = typeof reset === "string" ? Date.parse(reset) : NaN;
      const until = Number.isFinite(at) ? at : nextUtcMidnight().getTime();
      headers.set("retry-after", String(Math.max(1, Math.ceil((until - Date.now()) / 1000))));
    }
    return new Response(text, { status: res.status, statusText: res.statusText, headers });
  }

  return {
    async config(cfg) {
      cfg.provider ??= {};
      // ??= so a provider the user declared in providers.json or plugins.json
      // keeps its own name, models and options.
      cfg.provider[PROVIDER] ??= {
        name: "100milionseek",
        npm: CHAT_SDK,
        api: baseURL,
        // Lets the judge below serve as a route-group classifier.
        decide: true,
        models: template,
      };
    },

    auth: {
      provider: PROVIDER,
      icon: `${ORIGIN}/favicon.svg`,
      // The service admits 5 requests at once per account; more is a 429
      // (session_limit_reached), so ask magpie not to queue more than that.
      maxConcurrency: 5,
      methods: [
        {
          type: "api",
          label: "100milionseek API key",
          placeholder: "hms-…",
          // The key is collected through a prompt, so magpie hands it to
          // `authorize` as `inputs.key`. Without `prompts`, older hosts draw
          // their own key box and call `authorize` with no key at all, and
          // newer ones have nowhere to ask for one.
          prompts: [
            {
              type: "password",
              key: "key",
              message: "100milionseek API key",
              placeholder: "hms-…",
              validate: (value) => {
                if (typeof value !== "string" || !value.trim()) return "An API key is required.";
                if (/[\r\n]/.test(value)) return "The key must not contain line breaks.";
                return undefined;
              },
            },
          ],
          // Checked before it is stored, so a typo fails at sign-in instead of
          // as a 401 in the middle of a chat. A network failure is not the
          // key's fault and must not refuse it.
          async authorize(inputs) {
            const given = typeof inputs === "string" ? inputs : (inputs?.key ?? inputs?.apiKey ?? inputs?.token ?? "");
            const key = typeof given === "string" ? given.trim() : "";
            if (!key) return { type: "failed", error: "An API key is required." };
            try {
              const res = await fetchImpl(`${baseURL}/models`, {
                headers: { authorization: `Bearer ${key}`, accept: "application/json" },
                redirect: "error",
                signal: AbortSignal.timeout(timeout),
              });
              if (res.status === 401 || res.status === 403) {
                const text = await res.text().catch(() => "");
                let message = "";
                try {
                  message = JSON.parse(text)?.error?.message ?? "";
                } catch {
                  /* not JSON: the status is the whole answer */
                }
                return {
                  type: "failed",
                  error: message || `The key was refused (HTTP ${res.status}). Check it on 100milionseek.top.`,
                };
              }
              const window = quotaWindow(res.headers);
              if (window) seen.set(key, { window, at: Date.now() });
              try {
                await res.body?.cancel?.();
              } catch {
                /* already gone */
              }
            } catch {
              // Unreachable right now: keep the key, let requests say so.
            }
            return { type: "success", key, metadata: {} };
          },
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth();
        const apiKey = keyOf(auth);
        if (!apiKey) return {};

        return {
          baseURL,
          apiKey,
          async fetch(input, init) {
            const request = new Request(input, init);
            const url = new URL(request.url);
            // Rebuild on our own origin: a model-metadata URL from somewhere
            // else must not carry the key off to it.
            const path = url.pathname.startsWith("/v1/") ? url.pathname.slice(3) : url.pathname;
            const target = `${baseURL}${path}${url.search}`;

            const headers = new Headers(request.headers);
            for (const name of ["host", "authorization", "content-length", "connection", "accept-encoding"]) {
              headers.delete(name);
            }
            headers.set("authorization", `Bearer ${apiKey}`);
            if (!headers.get("accept")) headers.set("accept", "application/json");
            if (!headers.get("content-type") && request.method !== "GET" && request.method !== "HEAD") {
              headers.set("content-type", "application/json");
            }

            let body = init?.body;
            if (body === undefined || body === null) {
              body = request.body ? await request.text() : undefined;
            }

            // magpie already sends the judge {model, questions, state}, which is
            // the shape the vendor's /systemone takes, so the request goes as it
            // came; only the answer below needs shaping. The questions are still
            // read here, so a bare list of probabilities can be paired with them.
            const judge = path === "/systemone";
            let asked;
            if (judge && typeof body === "string") {
              try {
                asked = JSON.parse(body)?.questions;
              } catch {
                /* not JSON: the vendor will refuse it, which is its call */
              }
            }

            const res = await fetchImpl(target, {
              method: request.method,
              headers,
              body,
              signal: init?.signal ?? request.signal,
              redirect: "error",
            });
            remember(apiKey, res.headers, Date.now());

            if (res.status === 429) {
              // Only the day's allowance is worth a long rest; a concurrency
              // 429 keeps its own short Retry-After, or a working account
              // would be benched for the rest of the day.
              const copy = res.clone();
              let spent = false;
              try {
                spent = (await copy.json())?.error?.code === "daily_quota_exceeded";
              } catch {
                /* not JSON: no reason to rewrite it */
              }
              if (spent) return spentAllowance(res);
            }

            if (!judge) return res;

            // magpie reads answers: {<question>: {score, confidence}}. The
            // body has to be re-sent, so its framing headers go with it.
            const text = await res.text();
            let answered = text;
            try {
              const parsed = JSON.parse(text);
              answered = JSON.stringify(normalizeSystemOne(parsed, parsed?.questions ?? asked));
            } catch {
              /* non-JSON: hand it back untouched */
            }
            const out = new Headers(res.headers);
            for (const name of ["content-length", "content-encoding", "transfer-encoding"]) out.delete(name);
            return new Response(answered, { status: res.status, statusText: res.statusText, headers: out });
          },
        };
      },

      async usage(getAuth) {
        const auth = await getAuth?.();
        const apiKey = keyOf(auth);
        if (!apiKey) return {};

        let window = null;
        let error = "";
        let signIn;
        try {
          const read = await readAllowance(apiKey);
          window = read.window;
          if (read.res.status === 401) {
            // 401 is about the key itself, so the account is the one to fix.
            signIn = "expired";
            error = "The API key is no longer accepted. Sign in again.";
          }
        } catch (e) {
          error = `Could not read the allowance: ${e?.message ?? e}`;
        }
        // A read that failed falls back to what a request already reported,
        // still under this account's own key.
        window ??= seen.get(apiKey)?.window ?? null;

        const windows = [];
        if (window) {
          windows.push({ ...window });
        } else {
          // No figures at all: shown, never routed on (no `used`, no counts).
          windows.push({
            name: "Tokens today (UTC)",
            span: 86400,
            resetsAt: nextUtcMidnight().toISOString(),
            unit: "tokens",
            display: "The daily allowance is reported in response headers; it appears after this account's first request.",
          });
        }
        return {
          plan: window ? planOf(window) : "Free",
          windows,
          ...(error ? { error } : {}),
          ...(signIn ? { signIn } : {}),
        };
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models;
        const apiKey = keyOf(auth);
        if (!apiKey) return provider.models;
        try {
          const res = await fetchImpl(`${baseURL}/models`, {
            headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
            redirect: "error",
            signal: AbortSignal.timeout(timeout),
          });
          remember(apiKey, res.headers, Date.now());
          // The list is only usable when the account could read it.
          if (!res.ok) return provider.models;
          const ids = modelIDs(await res.json());
          // A model the plugin can't describe still gets the chat model's
          // shape, so a model added upstream works before the next release.
          const models = accountModels(ids, template, {
            baseURL,
            providerID: PROVIDER,
            fallback: template[CHAT_MODEL],
          });
          return models ?? provider.models;
        } catch {
          // Keep the models magpie already has rather than lose the list over
          // one failed read.
          return provider.models;
        }
      },
    },
  };
}

export const _internal = {
  PROVIDER,
  ORIGIN,
  BASE,
  CHAT_MODEL,
  JUDGE_MODEL,
  keyOf,
  quotaWindow,
  planOf,
  configModels,
  accountModels,
  modelIDs,
  normalizeSystemOne,
};
