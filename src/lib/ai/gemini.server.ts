// Server-only Gemini client. Calls the Google Gemini REST API directly via
// `fetch` — no SDK, no native/node-only dependencies — so it bundles cleanly for
// any target (Vercel node, edge, workers) and never leaks into the client bundle.
// The GEMINI_API_KEY is read from process.env and never reaches the browser.
//
// FREE-TIER QUOTA PROTECTION (so normal use never exhausts the free quota):
//   • The brain sits behind a response cache + a daily call budget (see
//     cost-control.server.ts) — identical prompts are served from memory and the
//     app stops calling the model once the daily budget is spent.
//   • This client leads with the HIGHEST-free-quota models (flash-lite) and, on a
//     429 / "resource exhausted", automatically falls through to the next model
//     in the chain instead of failing — so one model's per-minute limit doesn't
//     take the whole feature down.
//   • A modest maxOutputTokens cap keeps each response small.
//
// The exported surface (executeGeminiPrompt / executeGeminiText / pingGemini /
// isGeminiConfigured / GeminiError and the *Input/*Result types) is unchanged so
// every existing caller keeps working without edits.

export class GeminiError extends Error {
  readonly code:
    | "missing_key"
    | "api_error"
    | "rate_limit"
    | "invalid_json"
    | "empty_response";
  readonly raw?: string;
  // For rate_limit errors: whether the limit is per-minute (clears within ~60s,
  // worth retrying) or per-day (won't clear until quota reset — fail fast).
  quotaScope?: "perMinute" | "perDay";
  constructor(code: GeminiError["code"], message: string, raw?: string) {
    super(message);
    this.code = code;
    this.raw = raw;
  }
}

// Accept any of the common env names so a key set under either works.
export function getGeminiKey(): string {
  return (
    process.env.GEMINI_API_KEY ??
    process.env.GOOGLE_API_KEY ??
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
    ""
  );
}

export function isGeminiConfigured(): boolean {
  return getGeminiKey().length > 0;
}

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Cap each response so a single call can't burn an outsized amount of quota/
// tokens. The briefs and reports comfortably fit; override with GEMINI_MAX_TOKENS.
const MAX_OUTPUT_TOKENS = (() => {
  const v = Number(process.env.GEMINI_MAX_TOKENS);
  return Number.isFinite(v) && v > 0 ? v : 4096;
})();

// Retry/backoff budget for transient PER-MINUTE (RPM) rate limits only. A
// PER-DAY (RPD) limit is never retried — see generate(). Exponential backoff
// with jitter, bounded by BOTH a retry count and a total wall-clock wait so a
// single request can never hang for long.
const BASE_DELAY_MS = 1_000;
const MAX_RETRIES = 5;
const MAX_TOTAL_WAIT_MS = 30_000;
const MAX_SINGLE_DELAY_MS = 16_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Free-tier model chain. Each model has its OWN separate daily free quota, so
// listing several gives the app more total daily headroom and a real fallback
// when one model is momentarily rate-limited or its daily quota is spent. Order
// matters: lead with flash-lite (fastest + highest per-minute allowance), then
// 2.5-flash (independent quota), then the 2.0 models as a last resort. If the
// lead model is briefly throttled, the next one keeps the app live instead of
// falling straight to the built-in fallback. GEMINI_MODEL (resolved by the
// caller) overrides the lead model; a non-Gemini id is just prepended and tried
// first.
const DEFAULT_MODEL_CHAIN = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.0-flash-lite",
  "gemini-2.0-flash",
];

function modelsToTry(requested?: string): string[] {
  if (!requested) return DEFAULT_MODEL_CHAIN;
  return [requested, ...DEFAULT_MODEL_CHAIN.filter((m) => m !== requested)];
}

export type QuotaScope = "perMinute" | "perDay" | "unknown";

// Classify a 429 from the status, message and structured error.details so the
// caller can tell a transient per-minute throttle (retry) from a spent daily
// quota (don't bother). Exported for unit testing.
export function parseRateLimit(
  status: number,
  message: string,
  details?: GeminiErrorDetail[],
): { isRateLimit: boolean; scope: QuotaScope; retryAfterMs?: number } {
  const isRateLimit = status === 429 || /quota|rate.?limit|resource.?exhausted/i.test(message);
  if (!isRateLimit) return { isRateLimit: false, scope: "unknown" };

  let scope: QuotaScope = "unknown";
  let retryAfterMs: number | undefined;
  for (const d of details ?? []) {
    for (const v of d.violations ?? []) {
      const id = `${v.quotaId ?? ""} ${v.quotaMetric ?? ""}`;
      if (/per.?day|daily/i.test(id)) scope = "perDay";
      else if (scope === "unknown" && /per.?minute/i.test(id)) scope = "perMinute";
    }
    const m = typeof d.retryDelay === "string" ? d.retryDelay.match(/([\d.]+)s/) : null;
    if (m) retryAfterMs = Math.round(parseFloat(m[1]) * 1000);
  }
  // Fall back to the message text when structured details are absent.
  if (scope === "unknown") {
    if (/per.?day|daily/i.test(message)) scope = "perDay";
    else if (/per.?minute/i.test(message)) scope = "perMinute";
  }
  return { isRateLimit, scope, retryAfterMs };
}

// Exponential backoff with jitter, honoring the server's RetryInfo as a floor,
// and clamped so a single wait never blows the per-call wall-clock budget.
function computeBackoffMs(attempt: number, retryAfterMs: number | undefined, remainingBudgetMs: number): number {
  const exp = BASE_DELAY_MS * 2 ** attempt; // 1s, 2s, 4s, 8s, 16s
  const jitter = Math.random() * BASE_DELAY_MS; // 0–1s
  const delay = Math.max(exp, retryAfterMs ?? 0) + jitter;
  return Math.max(0, Math.round(Math.min(delay, MAX_SINGLE_DELAY_MS, remainingBudgetMs)));
}

export interface GeminiPromptInput {
  system: string;
  user: string;
  model?: string;
}

interface RawResult {
  text: string;
  model: string;
  durationMs: number;
  promptTokens: number;
  responseTokens: number;
  totalTokens: number;
}

// A single entry in the error.details[] array Google returns on a 429. We care
// about QuotaFailure (tells us per-day vs per-minute) and RetryInfo (server's
// suggested wait).
interface GeminiErrorDetail {
  "@type"?: string;
  retryDelay?: string; // RetryInfo, e.g. "27s"
  violations?: Array<{ quotaId?: string; quotaMetric?: string }>;
}

interface GeminiApiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  error?: { message?: string; status?: string; code?: number; details?: GeminiErrorDetail[] };
}

async function generate(input: GeminiPromptInput, json: boolean): Promise<RawResult> {
  const key = getGeminiKey();
  if (!key) throw new GeminiError("missing_key", "GEMINI_API_KEY is not configured on the server.");

  const body = {
    systemInstruction: { parts: [{ text: input.system }] },
    contents: [{ role: "user", parts: [{ text: input.user }] }],
    generationConfig: {
      temperature: json ? 0.4 : 0.5,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      ...(json ? { responseMimeType: "application/json" } : {}),
    },
  };

  let lastError: GeminiError | null = null;
  let sawDailyExhaustion = false;
  let totalWaitedMs = 0;
  let retries = 0;

  for (const model of modelsToTry(input.model)) {
    // Retry the SAME model with exponential backoff on a per-minute (RPM) limit
    // — it clears within ~60s. A per-day (RPD) limit won't clear by retrying, so
    // skip straight to the next model (which has its own daily quota).
    for (;;) {
      const t0 = Date.now();
      let resp: Response;
      try {
        resp = await fetch(`${API_BASE}/${model}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(body),
        });
      } catch (err) {
        // Network/transport failure — try the next model.
        lastError = new GeminiError("api_error", err instanceof Error ? err.message : String(err));
        break;
      }
      const durationMs = Date.now() - t0;

      if (resp.ok) {
        let data: GeminiApiResponse;
        try {
          data = (await resp.json()) as GeminiApiResponse;
        } catch (err) {
          lastError = new GeminiError("api_error", err instanceof Error ? err.message : String(err));
          break;
        }
        const text = (data.candidates?.[0]?.content?.parts ?? [])
          .map((p) => p.text ?? "")
          .join("")
          .trim();
        if (!text) {
          lastError = new GeminiError("empty_response", "Gemini returned an empty response.");
          break;
        }
        const usage = data.usageMetadata;
        return {
          text,
          model,
          durationMs,
          promptTokens: usage?.promptTokenCount ?? 0,
          responseTokens: usage?.candidatesTokenCount ?? 0,
          totalTokens: usage?.totalTokenCount ?? 0,
        };
      }

      // Non-OK: read the structured error body.
      let detail = `${resp.status} ${resp.statusText}`;
      let errDetails: GeminiErrorDetail[] | undefined;
      try {
        const j = (await resp.json()) as GeminiApiResponse;
        if (j.error?.message) detail = j.error.message;
        errDetails = j.error?.details;
      } catch {
        /* ignore parse failure */
      }

      // Client errors (bad request / bad key / forbidden) are NOT retryable.
      if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
        throw new GeminiError("api_error", detail);
      }

      const rl = parseRateLimit(resp.status, detail, errDetails);
      if (rl.isRateLimit) {
        if (rl.scope === "perDay") {
          // This model's daily quota is spent — retrying today is pointless.
          sawDailyExhaustion = true;
          const e = new GeminiError("rate_limit", detail);
          e.quotaScope = "perDay";
          lastError = e;
          break; // next model (separate daily quota)
        }
        // Per-minute or unspecified 429 → back off and retry the SAME model.
        const remaining = MAX_TOTAL_WAIT_MS - totalWaitedMs;
        if (retries < MAX_RETRIES && remaining > 0) {
          const wait = computeBackoffMs(retries, rl.retryAfterMs, remaining);
          retries += 1;
          totalWaitedMs += wait;
          await sleep(wait);
          continue; // retry same model
        }
        const e = new GeminiError("rate_limit", detail);
        e.quotaScope = "perMinute";
        lastError = e;
        break; // retry budget spent — try the next model
      }

      // Other server errors (5xx etc.) — transient; try the next model.
      lastError = new GeminiError("api_error", detail);
      break;
    }
  }

  // Every model failed. If at least one was a daily-quota exhaustion, fail fast
  // with a clear, actionable message rather than a generic rate-limit.
  if (sawDailyExhaustion) {
    const e = new GeminiError(
      "rate_limit",
      "Gemini free-tier DAILY quota is exhausted for every available model. It resets around midnight US-Pacific. Enable pay-as-you-go billing on the API project (or wait for the reset) to continue.",
    );
    e.quotaScope = "perDay";
    throw e;
  }
  throw lastError ?? new GeminiError("api_error", "All Gemini models failed.");
}

export interface GeminiPromptResult {
  parsed: unknown;
  raw: string;
  model: string;
  durationMs: number;
  promptTokens: number;
  responseTokens: number;
  totalTokens: number;
}

export async function executeGeminiPrompt(input: GeminiPromptInput): Promise<GeminiPromptResult> {
  const res = await generate(input, true);
  const text = res.text;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Best-effort fence/object extraction (defense against models that ignore
    // responseMimeType and wrap JSON in prose / fences).
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = (fenced ? fenced[1] : text).trim();
    const first = candidate.indexOf("{");
    const last = candidate.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        parsed = JSON.parse(candidate.slice(first, last + 1));
      } catch {
        throw new GeminiError("invalid_json", "Gemini returned non-JSON output", text);
      }
    } else {
      throw new GeminiError("invalid_json", "Gemini returned non-JSON output", text);
    }
  }

  return {
    parsed,
    raw: text,
    model: res.model,
    durationMs: res.durationMs,
    promptTokens: res.promptTokens,
    responseTokens: res.responseTokens,
    totalTokens: res.totalTokens,
  };
}

export interface GeminiTextResult {
  text: string;
  model: string;
  durationMs: number;
  promptTokens: number;
  responseTokens: number;
  totalTokens: number;
}

// Free-text variant: returns the model's natural-language output (e.g. markdown)
// instead of forcing/parsing JSON. Used for conversational sections like Copilot.
export async function executeGeminiText(input: GeminiPromptInput): Promise<GeminiTextResult> {
  return generate(input, false);
}

// Live connectivity probe so the UI/health route can show the REAL reason when
// live AI is unavailable, instead of a silent fallback. (One tiny model call.)
export async function pingGemini(): Promise<
  { ok: true; model: string; latencyMs: number } | { ok: false; code: string; message: string }
> {
  if (!isGeminiConfigured())
    return {
      ok: false,
      code: "missing_key",
      message:
        "GEMINI_API_KEY is not set on the server. Add a free Google AI Studio key (aistudio.google.com) as GEMINI_API_KEY locally in .env and in your Vercel project's Environment Variables.",
    };
  try {
    const r = await generate({ system: "Reply with the single word OK.", user: "ping" }, false);
    return { ok: true, model: r.model, latencyMs: r.durationMs };
  } catch (e) {
    if (e instanceof GeminiError) return { ok: false, code: e.code, message: e.message };
    return { ok: false, code: "api_error", message: e instanceof Error ? e.message : String(e) };
  }
}
