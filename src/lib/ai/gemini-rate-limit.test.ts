// Unit tests for parseRateLimit — the helper that decides whether a Gemini 429
// is a transient per-minute throttle (retry) or a spent per-day quota (fail fast).
import { describe, it, expect } from "vitest";
import { parseRateLimit } from "./gemini.server";

describe("parseRateLimit", () => {
  it("treats non-429 statuses as not rate-limited", () => {
    expect(parseRateLimit(200, "ok").isRateLimit).toBe(false);
    expect(parseRateLimit(500, "internal error").isRateLimit).toBe(false);
  });

  it("flags any 429 as a rate limit", () => {
    expect(parseRateLimit(429, "whatever").isRateLimit).toBe(true);
  });

  it("flags resource-exhausted text even without a 429 status", () => {
    expect(parseRateLimit(0, "RESOURCE_EXHAUSTED: quota").isRateLimit).toBe(true);
  });

  it("detects a per-DAY quota from structured violations", () => {
    const res = parseRateLimit(429, "You exceeded your current quota", [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }],
      },
    ]);
    expect(res.scope).toBe("perDay");
  });

  it("detects a per-MINUTE quota from structured violations", () => {
    const res = parseRateLimit(429, "You exceeded your current quota", [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }],
      },
    ]);
    expect(res.scope).toBe("perMinute");
  });

  it("parses RetryInfo retryDelay into milliseconds", () => {
    const res = parseRateLimit(429, "slow down", [
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "27s" },
    ]);
    expect(res.retryAfterMs).toBe(27_000);
  });

  it("falls back to the message text when details are absent", () => {
    expect(parseRateLimit(429, "per-day limit reached").scope).toBe("perDay");
    expect(parseRateLimit(429, "per-minute limit reached").scope).toBe("perMinute");
  });

  it("returns unknown scope when nothing identifies the quota", () => {
    expect(parseRateLimit(429, "quota exceeded").scope).toBe("unknown");
  });
});
