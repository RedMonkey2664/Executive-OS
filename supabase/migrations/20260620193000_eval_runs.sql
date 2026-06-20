-- LLM eval harness run log (Prompt 4). One row per `npm run eval:agent` run.
-- Portable Postgres DDL — applies to Aurora as well as Supabase. The eval runner
-- also self-applies this via CREATE TABLE IF NOT EXISTS, so it works against
-- Aurora without a migration tool.
create table if not exists public.eval_runs (
  id          bigint generated always as identity primary key,
  run_at      timestamptz not null default now(),
  agent_model text,
  judge_model text,
  total       integer not null,
  passed      integer not null,
  pass_rate   numeric not null,
  report_path text,
  failures    jsonb,
  notes       text
);
