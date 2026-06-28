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

function classifyStatus(status: number, msg: string): { code: GeminiError["code"]; retryable: boolean } {
  if (status === 429 || /quota|rate.?limit|resource.?exhausted/i.test(msg)) return { code: "rate_limit", retryable: true };
  if (status >= 400) return { code: "api_error", retryable: true };
  return { code: "api_error", retryable: false };
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

interface GeminiApiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  error?: { message?: string; status?: string };
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
  for (const model of modelsToTry(input.model)) {
    const t0 = Date.now();
    let resp: Response;
    try {
      resp = await fetch(`${API_BASE}/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Network/transport failure — try the next model, then give up.
      lastError = new GeminiError("api_error", err instanceof Error ? err.message : String(err));
      continue;
    }
    const durationMs = Date.now() - t0;

    if (!resp.ok) {
      let detail = `${resp.status} ${resp.statusText}`;
      try {
        const j = (await resp.json()) as GeminiApiResponse;
        if (j.error?.message) detail = j.error.message;
      } catch {
        /* ignore parse failure */
      }
      const { code, retryable } = classifyStatus(resp.status, detail);
      lastError = new GeminiError(code, detail);
      // On a quota/rate-limit (or other retryable error) fall through to the
      // next, higher-quota model rather than failing the whole request.
      if (retryable) continue;
      throw lastError;
    }

    let data: GeminiApiResponse;
    try {
      data = (await resp.json()) as GeminiApiResponse;
    } catch (err) {
      lastError = new GeminiError("api_error", err instanceof Error ? err.message : String(err));
      continue;
    }

    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    if (!text) {
      lastError = new GeminiError("empty_response", "Gemini returned an empty response.");
      continue;
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
