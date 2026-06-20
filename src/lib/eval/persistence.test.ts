import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { persistRun, EVAL_RUNS_DDL, type RunSummary } from "./persistence";

const summary: RunSummary = {
  runAt: "2026-06-20T00:00:00.000Z",
  agentModel: "gemini-2.5-flash",
  judgeModel: "gemini-2.5-pro",
  total: 5,
  passed: 4,
  passRate: 0.8,
  reportPath: "docs/eval/agent-eval-x.md",
  failures: [{ scenario_id: "S03", verdict: null, judgeError: "boom" }],
  notes: "test run",
};

const tmp = path.join(os.tmpdir(), `eval-jsonl-${Date.now()}.jsonl`);
afterEach(() => {
  if (fs.existsSync(tmp)) fs.rmSync(tmp);
});

describe("EVAL_RUNS_DDL", () => {
  it("is an idempotent CREATE TABLE", () => {
    expect(EVAL_RUNS_DDL).toMatch(/create table if not exists eval_runs/i);
  });
});

describe("persistRun", () => {
  it("writes to JSONL when no databaseUrl is provided", async () => {
    const r = await persistRun(summary, { jsonlPath: tmp });
    expect(r.target).toBe("jsonl");
    const line = JSON.parse(fs.readFileSync(tmp, "utf8").trim());
    expect(line.passRate).toBe(0.8);
    expect(line.failures[0].scenario_id).toBe("S03");
  });

  it("falls back to JSONL when the database is unreachable", async () => {
    const r = await persistRun(summary, {
      databaseUrl: "postgres://invalid:invalid@127.0.0.1:1/none",
      jsonlPath: tmp,
    });
    expect(r.target).toBe("jsonl");
    expect(fs.existsSync(tmp)).toBe(true);
  });
});
