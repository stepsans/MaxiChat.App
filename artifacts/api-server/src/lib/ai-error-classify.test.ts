import { test } from "node:test";
import assert from "node:assert/strict";
import { isFailoverEligible } from "./ai-error-classify";

test("auth/billing/quota statuses are failover-eligible", () => {
  for (const status of [401, 402, 403, 429]) {
    assert.equal(isFailoverEligible({ status }), true, `status ${status}`);
  }
});

test("5xx provider errors are eligible", () => {
  assert.equal(isFailoverEligible({ status: 500 }), true);
  assert.equal(isFailoverEligible({ status: 503 }), true);
  assert.equal(isFailoverEligible({ code: 502 }), true);
});

test("network/timeout errors are eligible", () => {
  assert.equal(isFailoverEligible({ name: "AbortError" }), true);
  assert.equal(isFailoverEligible({ code: "ECONNRESET" }), true);
  assert.equal(isFailoverEligible({ code: "ENOTFOUND" }), true);
  assert.equal(isFailoverEligible(new Error("fetch failed")), true);
  assert.equal(isFailoverEligible(new Error("Request timeout after 30s")), true);
});

test("content rejection / invalid input is NOT eligible", () => {
  assert.equal(isFailoverEligible({ status: 400 }), false); // bad request / invalid input
  assert.equal(isFailoverEligible({ status: 404 }), false);
  assert.equal(isFailoverEligible({ status: 422 }), false); // content policy
  assert.equal(isFailoverEligible(new Error("invalid JSON in response")), false);
  assert.equal(isFailoverEligible(undefined), false);
});
