const { getDb } = require("./client");

async function listEvaluationRuns(tenantId, assessmentId = null) {
  return getDb().all(
    `SELECT r.run_id, r.assessment_id, r.model, r.final_score,
            r.harness_version, r.prompt_version, r.verification_status,
            r.verification_valid, r.requires_human_review,
            a.approval_status, h.human_score
       FROM evaluation_runs r
       LEFT JOIN human_approvals a ON a.run_id = r.run_id
       LEFT JOIN evaluation_human_scores h ON h.run_id = r.run_id
      WHERE r.tenant_id = ?
        AND (CAST(? AS TEXT) IS NULL OR r.assessment_id = ?)
      ORDER BY r.created_at DESC`,
    tenantId,
    assessmentId,
    assessmentId
  );
}

async function getEvaluationTrace(runId, tenantId) {
  const db = getDb();
  const run = await db.get(
    "SELECT * FROM evaluation_runs WHERE run_id = ? AND tenant_id = ?",
    runId,
    tenantId
  );
  if (!run) return { runId, available: false };

  const events = await db.all(
    "SELECT type, data, ts FROM evaluation_events WHERE run_id = ? ORDER BY seq ASC",
    runId
  );
  const result = await db.get("SELECT * FROM evaluation_results WHERE run_id = ?", runId);
  const versions = await db.get("SELECT * FROM evaluation_versions WHERE run_id = ?", runId);

  return {
    runId,
    available: true,
    run,
    events: events.map((event) => ({
      type: event.type,
      data: JSON.parse(event.data || "{}"),
      ts: event.ts,
    })),
    result: result ? JSON.parse(result.result_json) : null,
    versions,
  };
}

async function listAiVsHumanRows(assessmentId, tenantId) {
  return getDb().all(
    `SELECT r.run_id, r.final_score, h.human_score, h.human_feedback
       FROM evaluation_runs r
       JOIN evaluation_human_scores h ON h.run_id = r.run_id
       WHERE (CAST(? AS TEXT) IS NULL OR r.assessment_id = ?)
        AND (CAST(? AS TEXT) IS NULL OR r.tenant_id = ?)
        AND r.final_score IS NOT NULL
        AND h.human_score IS NOT NULL`,
    assessmentId || null,
    assessmentId || null,
    tenantId || null,
    tenantId || null
  );
}

async function getEvaluationRunScore(runId, tenantId = null) {
  return getDb().get(
    `SELECT run_id, final_score
       FROM evaluation_runs
      WHERE run_id = ?
        AND (CAST(? AS TEXT) IS NULL OR tenant_id = ?)`,
    runId,
    tenantId || null,
    tenantId || null
  );
}

async function saveHumanScore({ runId, humanScore, humanFeedback, reviewerId, reviewedAt }) {
  await getDb().run(
    // Plain INSERT: the only unique key is the autoincrement id, so the former
    // INSERT OR REPLACE never replaced anything and always appended a row.
    `INSERT INTO evaluation_human_scores
       (run_id, human_score, human_feedback, reviewed_at, reviewer_id)
     VALUES (?, ?, ?, ?, ?)`,
    runId,
    humanScore,
    humanFeedback || null,
    reviewedAt || new Date().toISOString(),
    reviewerId || null
  );
}

async function listRubricComplianceRows(assessmentId, tenantId) {
  return getDb().all(
    `SELECT run_id, criterion_id, score FROM evaluation_criteria
      WHERE run_id IN (
        SELECT run_id FROM evaluation_runs
         WHERE (CAST($1 AS TEXT) IS NULL OR assessment_id = $1)
           AND (CAST($2 AS TEXT) IS NULL OR tenant_id = $2)
      )`,
    assessmentId || null,
    tenantId || null
  );
}

async function listCalibrationRows(assessmentId, tenantId) {
  return getDb().all(
    `SELECT r.run_id, r.final_score AS ai_score, h.human_score,
            (SELECT AVG(c.confidence) FROM evaluation_criteria c WHERE c.run_id = r.run_id) AS avg_conf
       FROM evaluation_runs r
       JOIN evaluation_human_scores h ON h.run_id = r.run_id
      WHERE (CAST($1 AS TEXT) IS NULL OR r.assessment_id = $1)
        AND (CAST($2 AS TEXT) IS NULL OR r.tenant_id = $2)
        AND r.final_score IS NOT NULL
        AND h.human_score IS NOT NULL
      ORDER BY r.created_at ASC`,
    assessmentId || null,
    tenantId || null
  );
}

async function listReviewedScoreRows(tenantId) {
  return getDb().all(
    `SELECT r.final_score AS ai, h.human_score AS human
       FROM evaluation_runs r
       JOIN evaluation_human_scores h ON h.run_id = r.run_id
      WHERE r.tenant_id = $1 AND r.final_score IS NOT NULL AND h.human_score IS NOT NULL`,
    tenantId || null
  );
}

async function listReliabilityRuns(tenantId) {
  return getDb().all(
    `SELECT verification_status, requires_human_review, final_score
       FROM evaluation_runs WHERE tenant_id = $1`,
    tenantId || null
  );
}

async function getAiLogStats(tenantId) {
  return getDb().get(
    `SELECT COUNT(*) AS calls,
            SUM(COALESCE(cost_usd, 0)) AS cost,
            SUM(CASE WHEN retry_count > 0 THEN 1 ELSE 0 END) AS retried,
            AVG(latency_ms) AS avg_latency
       FROM ai_logs WHERE tenant_id = $1`,
    tenantId || null
  );
}

async function listAiLogLatencies(tenantId) {
  return getDb().all(
    `SELECT latency_ms FROM ai_logs
      WHERE tenant_id = $1 AND latency_ms IS NOT NULL ORDER BY latency_ms ASC`,
    tenantId || null
  );
}

async function listDriftRows(tenantId) {
  return getDb().all(
    `SELECT r.created_at, r.final_score AS ai, h.human_score AS human
       FROM evaluation_runs r
       JOIN evaluation_human_scores h ON h.run_id = r.run_id
      WHERE r.tenant_id = $1
        AND r.final_score IS NOT NULL
        AND h.human_score IS NOT NULL`,
    tenantId || null
  );
}


async function listAssessmentValidityRows(assessmentId, tenantId) {
  return getDb().all(
    `SELECT verification_status, requires_human_review, final_score, input_hash
       FROM evaluation_runs
      WHERE assessment_id = $1 AND tenant_id = $2`,
    assessmentId || null,
    tenantId || null
  );
}

async function listRepeatabilityRows(tenantId, assessmentId = null) {
  return getDb().all(
    `SELECT input_hash, final_score, created_at
       FROM evaluation_runs
      WHERE tenant_id = $1 AND ($2 IS NULL OR assessment_id = $2) AND input_hash IS NOT NULL AND final_score IS NOT NULL
      ORDER BY input_hash, created_at ASC`,
    tenantId || null,
    assessmentId || null
  );
}

module.exports = {
  listEvaluationRuns,
  getEvaluationTrace,
  listAiVsHumanRows,
  getEvaluationRunScore,
  saveHumanScore,
  listRubricComplianceRows,
  listCalibrationRows,
  listReviewedScoreRows,
  listReliabilityRuns,
  getAiLogStats,
  listAiLogLatencies,
  listDriftRows,
  listRepeatabilityRows,
  listAssessmentValidityRows,
};
