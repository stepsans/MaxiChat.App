// Pure (db-free) classifier for the priority failover chain (SPEC BAGIAN 5.1).
// Decides whether a failed AI call should fail OVER to the next engine, or be
// surfaced as-is. Only provider/credential/availability failures are eligible:
//   401/402/403 (auth/billing), 429 (quota/rate), 5xx (provider down),
//   network/timeout (AbortError, ECONN*, ENOTFOUND, "fetch failed").
// A content rejection or invalid input (4xx other than the above) is NOT
// eligible — retrying on another engine would just fail the same way.
//
// NOTE: a tenant running out of credits is NOT a provider error — it never
// reaches here; the prepaid gate stops the call first.

function statusOf(err: unknown): number | string | undefined {
  if (err && typeof err === "object") {
    const e = err as { status?: number | string; code?: number | string };
    return e.status ?? e.code;
  }
  return undefined;
}

export function isFailoverEligible(err: unknown): boolean {
  const s = statusOf(err);
  if (s === 401 || s === 402 || s === 403) return true; // auth / billing
  if (s === 429) return true; // quota / rate / insufficient_quota
  if (typeof s === "number" && s >= 500) return true; // provider down
  if (s === "ECONNRESET" || s === "ECONNREFUSED" || s === "ENOTFOUND" || s === "ETIMEDOUT") {
    return true;
  }
  const name = err && typeof err === "object" ? (err as { name?: string }).name : undefined;
  if (name === "AbortError") return true;
  const msg = err && typeof err === "object" ? String((err as { message?: string }).message ?? "") : String(err ?? "");
  if (/timeout|ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|network/i.test(msg)) return true;
  return false; // content rejected / invalid input → do NOT failover
}
