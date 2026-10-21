-- PostgreSQL baseline: the schema SQLite reaches after migrations 001-022,
-- including the columns server/database/client.js adds with ensureColumn().
-- Every migration after 022 must be added to both server/migrations/ and
-- server/migrations/postgres/ with the same version number.
--
-- Type mapping keeps SQLite query semantics:
--   TEXT     -> TEXT (ids, ISO-8601 timestamps and JSON payloads stay text)
--   INTEGER  -> NUMERIC (SQLite INTEGER affinity also stores fractional values,
--               e.g. scores; NUMERIC accepts them and stays exact)
--   REAL     -> DOUBLE PRECISION
--   INTEGER PRIMARY KEY AUTOINCREMENT -> BIGINT identity
-- Tables are ordered so that every foreign key target already exists.

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'starter',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'teacher', 'student')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  teacher_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  join_code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS class_memberships (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at TEXT NOT NULL,
  approved_at TEXT,
  UNIQUE (class_id, student_id)
);

CREATE TABLE IF NOT EXISTS assessments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  class_id TEXT REFERENCES classes(id) ON DELETE SET NULL,
  teacher_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'published',
  topic TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assessment_classes (
  tenant_id TEXT NOT NULL,
  assessment_id TEXT NOT NULL,
  class_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published',
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, assessment_id, class_id)
);

CREATE TABLE IF NOT EXISTS assessment_attempts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempt_no NUMERIC NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('STARTED', 'SUBMITTING', 'FINALIZED', 'EXPIRED', 'CANCELLED')),
  assessment_hash TEXT NOT NULL,
  rubric_hash TEXT,
  snapshot_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  deadline_at TEXT,
  submitted_at TEXT,
  submission_id TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  evaluation_started_at TEXT,
  UNIQUE (tenant_id, assessment_id, user_id, attempt_no),
  UNIQUE (tenant_id, assessment_id, user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  assessment_id TEXT REFERENCES assessments(id) ON DELETE CASCADE,
  student_name TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  final_score NUMERIC NOT NULL,
  payload TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  attempt_id TEXT,
  assessment_hash TEXT,
  rubric_hash TEXT,
  submission_hash TEXT,
  evaluation_status TEXT
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS ai_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens NUMERIC NOT NULL,
  completion_tokens NUMERIC NOT NULL,
  total_tokens NUMERIC NOT NULL,
  latency_ms NUMERIC NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'error')),
  error_message TEXT,
  estimated_prefix_cache_savings NUMERIC DEFAULT 0,
  created_at TEXT NOT NULL,
  retry_count NUMERIC DEFAULT 0,
  cost_usd DOUBLE PRECISION DEFAULT 0,
  cache_read_input_tokens NUMERIC DEFAULT 0,
  cache_creation_input_tokens NUMERIC DEFAULT 0,
  kv_cache_measured NUMERIC NOT NULL DEFAULT 0,
  run_id TEXT
);

CREATE TABLE IF NOT EXISTS evaluation_runs (
  run_id TEXT PRIMARY KEY,
  tenant_id TEXT,
  user_id TEXT,
  assessment_id TEXT REFERENCES assessments(id) ON DELETE SET NULL,
  submission_id TEXT,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  rubric_version TEXT NOT NULL,
  harness_version TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  final_score DOUBLE PRECISION,
  verification_valid NUMERIC,
  verification_issues TEXT,
  created_at TEXT NOT NULL,
  verification_status TEXT,
  input_hash TEXT,
  rubric_hash TEXT,
  prompt_hash TEXT,
  config_hash TEXT,
  published NUMERIC,
  requires_human_review NUMERIC,
  context_hash TEXT,
  context_version TEXT,
  risk_score DOUBLE PRECISION,
  risk_level TEXT,
  policy_applied TEXT,
  attempt_id TEXT,
  assessment_hash TEXT,
  answer_hash TEXT,
  evaluation_hash TEXT,
  attempt_rubric_hash TEXT
);

CREATE TABLE IF NOT EXISTS evaluation_criteria (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES evaluation_runs(run_id) ON DELETE CASCADE,
  criterion_id TEXT NOT NULL,
  score DOUBLE PRECISION NOT NULL,
  weight DOUBLE PRECISION NOT NULL,
  rationale TEXT,
  confidence DOUBLE PRECISION,
  evidence_json TEXT
);

CREATE TABLE IF NOT EXISTS evaluation_events (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES evaluation_runs(run_id) ON DELETE CASCADE,
  seq NUMERIC NOT NULL,
  type TEXT NOT NULL,
  data TEXT,
  ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evaluation_human_scores (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES evaluation_runs(run_id) ON DELETE CASCADE,
  human_score NUMERIC,
  human_feedback TEXT,
  reviewed_at TEXT,
  reviewer_id TEXT
);

CREATE TABLE IF NOT EXISTS evaluation_results (
  run_id TEXT PRIMARY KEY REFERENCES evaluation_runs(run_id) ON DELETE CASCADE,
  evaluation_id TEXT NOT NULL,
  criteria_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  weighted_json TEXT
);

CREATE TABLE IF NOT EXISTS evaluation_versions (
  run_id TEXT PRIMARY KEY REFERENCES evaluation_runs(run_id) ON DELETE CASCADE,
  model_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  rubric_version TEXT NOT NULL,
  harness_version TEXT NOT NULL,
  engine_version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS human_approvals (
  run_id TEXT PRIMARY KEY REFERENCES evaluation_runs(run_id) ON DELETE CASCADE,
  tenant_id TEXT,
  final_score DOUBLE PRECISION,
  approval_status TEXT NOT NULL DEFAULT 'pending',
  approved_by TEXT,
  approved_at TEXT,
  deadline_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evaluation_contexts (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  context_version TEXT NOT NULL,
  artifact_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  UNIQUE (tenant_id, context_hash)
);

CREATE TABLE IF NOT EXISTS question_bank (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  teacher_id TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  difficulty TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  focus TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT '',
  rubric TEXT NOT NULL DEFAULT '',
  ideal TEXT NOT NULL DEFAULT '',
  criteria TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  learning_outcome_ids TEXT NOT NULL DEFAULT '[]',
  learning_outcome_id TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS student_competency_state (
  tenant_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  learning_outcome_id TEXT NOT NULL,
  learning_outcome TEXT NOT NULL,
  latest_score NUMERIC NOT NULL,
  latest_submitted_at TEXT,
  snapshot_count NUMERIC NOT NULL DEFAULT 0,
  history TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, student_id, learning_outcome_id, learning_outcome)
);

-- Created lazily by server/seed-demo.js and server/rate-limit.js on SQLite;
-- declared here so data can be migrated into them.
CREATE TABLE IF NOT EXISTS demo_seeds (
  tenant_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, table_name, row_id)
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  reset_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_logs_created_at ON ai_logs (created_at);
CREATE INDEX IF NOT EXISTS idx_ai_logs_run ON ai_logs (run_id);
CREATE INDEX IF NOT EXISTS idx_ai_logs_tenant ON ai_logs (tenant_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys (tenant_id);
CREATE INDEX IF NOT EXISTS idx_assessment_attempts_deadline ON assessment_attempts (tenant_id, deadline_at, status);
CREATE INDEX IF NOT EXISTS idx_assessment_attempts_submission_lease ON assessment_attempts (tenant_id, status, evaluation_started_at);
CREATE INDEX IF NOT EXISTS idx_assessment_attempts_user ON assessment_attempts (tenant_id, user_id, assessment_id, status);
CREATE INDEX IF NOT EXISTS idx_assessment_classes_assessment ON assessment_classes (tenant_id, assessment_id, status);
CREATE INDEX IF NOT EXISTS idx_assessment_classes_class ON assessment_classes (tenant_id, class_id, status);
CREATE INDEX IF NOT EXISTS idx_assessments_teacher ON assessments (teacher_id);
CREATE INDEX IF NOT EXISTS idx_assessments_tenant_class ON assessments (tenant_id, class_id);
CREATE INDEX IF NOT EXISTS idx_assessments_tenant_created ON assessments (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_assessments_tenant_teacher_created ON assessments (tenant_id, teacher_id, created_at);
CREATE INDEX IF NOT EXISTS idx_class_memberships_tenant_class ON class_memberships (tenant_id, class_id, student_id);
CREATE INDEX IF NOT EXISTS idx_classes_tenant_teacher ON classes (tenant_id, teacher_id, created_at);
CREATE INDEX IF NOT EXISTS idx_competency_state_outcome ON student_competency_state (tenant_id, learning_outcome_id);
CREATE INDEX IF NOT EXISTS idx_competency_state_student ON student_competency_state (tenant_id, student_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_evaluation_contexts_tenant ON evaluation_contexts (tenant_id, context_hash);
CREATE INDEX IF NOT EXISTS idx_evaluation_criteria_run ON evaluation_criteria (run_id);
CREATE INDEX IF NOT EXISTS idx_evaluation_events_run ON evaluation_events (run_id, seq);
CREATE INDEX IF NOT EXISTS idx_evaluation_runs_assessment ON evaluation_runs (assessment_id);
CREATE INDEX IF NOT EXISTS idx_evaluation_runs_created ON evaluation_runs (created_at);
CREATE INDEX IF NOT EXISTS idx_evaluation_runs_evaluation_hash ON evaluation_runs (tenant_id, evaluation_hash);
CREATE INDEX IF NOT EXISTS idx_human_approvals_pending ON human_approvals (approval_status, deadline_at);
CREATE INDEX IF NOT EXISTS idx_memberships_class_student ON class_memberships (class_id, student_id);
CREATE INDEX IF NOT EXISTS idx_question_bank_tenant ON question_bank (tenant_id, teacher_id, created_at);
CREATE INDEX IF NOT EXISTS idx_submissions_assessment ON submissions (assessment_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_attempt ON submissions (tenant_id, attempt_id);
CREATE INDEX IF NOT EXISTS idx_submissions_student_assessment ON submissions (tenant_id, user_id, assessment_id);
CREATE INDEX IF NOT EXISTS idx_submissions_tenant ON submissions (tenant_id);
CREATE INDEX IF NOT EXISTS idx_submissions_tenant_created ON submissions (tenant_id, submitted_at);
CREATE INDEX IF NOT EXISTS idx_submissions_tenant_user ON submissions (tenant_id, user_id, submitted_at);
CREATE INDEX IF NOT EXISTS idx_submissions_user ON submissions (user_id);
