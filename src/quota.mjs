// The daily allowance, read from the quota headers.
//
// 100milionseek has no route that reports an account's usage as JSON: every
// response instead carries x-quota-limit / x-quota-used / x-quota-remaining /
// x-quota-reset, and those headers are the only source of truth. The limit is
// not always 100,000,000 either — milestones raise it — so nothing here
// hardcodes the allowance into a window.

export const DAY_S = 86400; // magpie's UsageWindow.span unit is seconds, not ms
export const DAY_MS = 86_400_000;
export const BASE_DAILY_TOKENS = 100_000_000; // the Free tier's documented base

// A header value as a whole count, or null when the API did not send one.
function count(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

export function nextUtcMidnight(now = Date.now()) {
  return new Date((Math.floor(now / DAY_MS) + 1) * DAY_MS);
}

// An ISO instant from x-quota-reset, or the next 00:00 UTC when it is absent
// or unreadable (the allowance resets at 00:00 UTC, per the API reference).
export function resetInstant(value, now = Date.now()) {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? new Date(at) : nextUtcMidnight(now);
}

// One window for the UTC day, or undefined when the response said nothing
// about the allowance. `used` is left out — never written as 0 — when the
// spend is unknown, because magpie reads a missing percentage as "unknown"
// and a 0 as "nothing used".
export function quotaWindow(headers, now = Date.now()) {
  const limit = count(headers.get("x-quota-limit"));
  const used = count(headers.get("x-quota-used"));
  const remaining = count(headers.get("x-quota-remaining"));
  if (limit === null && used === null && remaining === null) return undefined;

  const total = limit ?? (used !== null && remaining !== null ? used + remaining : null);
  const spent =
    used !== null ? used : total !== null && remaining !== null ? Math.max(0, total - remaining) : null;

  const window = {
    name: "Tokens today (UTC)",
    span: DAY_S,
    unit: "tokens",
    resetsAt: resetInstant(headers.get("x-quota-reset"), now).toISOString(),
  };
  if (total !== null) window.limit = total;
  if (spent !== null) window.amount = spent;
  if (total !== null && spent !== null) {
    if (total > 0) window.used = (100 * spent) / total; // over 100 when the day's allowance is spent
    // amount / limit / unit is what magpie renders; no display line needed.
  } else if (spent !== null) {
    window.display = `${spent.toLocaleString("en-US")} tokens used today; the daily limit was not reported`;
  } else if (total !== null) {
    window.display = `${total.toLocaleString("en-US")} tokens a day; today's spend was not reported`;
  } else {
    window.display = `${remaining.toLocaleString("en-US")} tokens left today`;
  }
  return window;
}

// The plan name magpie shows on the account. The API reports no tier, but a
// limit above the Free base can only come from a milestone boost or a paid
// tier, so say what the number says instead of guessing a subscription.
export function planOf(window) {
  const limit = window?.limit;
  if (!Number.isFinite(limit) || limit <= BASE_DAILY_TOKENS) return "Free";
  return `Raised allowance (${limit.toLocaleString("en-US")}/day)`;
}
