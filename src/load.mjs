// How busy the service is, as the percentage magpie routes on.
//
// /api/status needs no key and is the only place the queue is visible: the
// upstream's inflight count against its capacity.
//
// Deliberately not used, though the same body carries them:
//
//   - `sessions_in_flight` is service-wide while `allowance.session_limit` is
//     per account, so their ratio says nothing about this account's queue;
//   - `state` reads "degraded" whenever the upstream is retrying anything,
//     which is most of the day, so treating it as full would report 100 for
//     ever and route every request away from a working provider.
//
// Pure, so the arithmetic can be tested without a server.

const clamp = (n) => Math.max(0, Math.min(10_000, Math.round(n)));

export function loadOf(status) {
  if (!status || typeof status !== "object") return null;

  const upstream = status.upstream ?? {};
  const inflight = Number(upstream.inflight);
  const capacity = Number(upstream.capacity);
  if (!Number.isFinite(inflight) || !Number.isFinite(capacity) || capacity <= 0) return null;

  // Over-subscribed is worth showing as more than 100; magpie clamps at 10000.
  return clamp((100 * inflight) / capacity);
}
