const { parseLearningOutcomes, questionLearningOutcomesMap } = require("./harness/learning-outcome-alignment");
const { buildLearningOutcomeTrajectory } = require("./competency-trajectory");

function parsePayload(value) {
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

function evidenceCoverage(submission, questionScores) {
  const explicit = Number(submission?.evidenceQuality?.overallCoverage ?? submission?.evidenceCoverage);
  if (Number.isFinite(explicit)) return Math.max(0, Math.min(1, explicit));
  const total = questionScores.length;
  if (!total) return 0;
  return questionScores.filter((qs) =>
    (Array.isArray(qs?.evidence) && qs.evidence.length > 0) ||
    String(qs?.answer || "").trim() ||
    String(qs?.probing?.answer || "").trim()
  ).length / total;
}

function recordsForSubmission(submission, assessment) {
  const outcomes = parseLearningOutcomes(assessment?.outcomes ?? assessment?.learningOutcomes ?? assessment?.learningOutcome);
  const questionMap = questionLearningOutcomesMap(assessment?.questions || [], outcomes);
  const scores = Array.isArray(submission?.questionScores) ? submission.questionScores : [];
  const groups = new Map();

  scores.forEach((qs, index) => {
    const score = Number(qs?.score);
    const los = questionMap.get(index) || [];
    if (!los.length || !Number.isFinite(score)) return;
    los.forEach((lo) => {
      const key = `${lo.id}::${String(lo.text || "").trim().toLowerCase()}`;
      const bucket = groups.get(key) || {
        learningOutcomeId: lo.id,
        learningOutcome: lo.text,
        scores: [],
        evidenceCount: 0,
        probingCount: 0,
      };
      bucket.scores.push(Math.max(0, Math.min(100, score)));
      bucket.evidenceCount += Array.isArray(qs?.evidence) ? qs.evidence.length : 0;
      if (String(qs?.probing?.answer || "").trim()) {
        bucket.evidenceCount += 1;
        bucket.probingCount += 1;
      }
      groups.set(key, bucket);
    });
  });

  return [...groups.values()].map((group) => ({
    learningOutcomeId: group.learningOutcomeId,
    learningOutcome: group.learningOutcome,
    assessmentId: submission.assessmentId,
    submittedAt: submission.submittedAt,
    score: Math.round(group.scores.reduce((sum, value) => sum + value, 0) / group.scores.length),
    evidenceCoverage: evidenceCoverage(submission, scores),
    evidenceCount: group.evidenceCount,
    probingCount: group.probingCount,
    evidenceGain: Number(submission?.evidenceQuality?.impact?.evidenceGain || 0) || 0,
  }));
}

function parseHistory(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function materializeSubmission(db, tenantId, studentId, submission) {
  if (!studentId || !submission?.assessmentId) return;
  const assessmentRow = await db.get(
    "SELECT payload FROM assessments WHERE id = ? AND tenant_id = ?",
    submission.assessmentId,
    tenantId,
  );
  if (!assessmentRow) return;

  const records = recordsForSubmission(submission, parsePayload(assessmentRow.payload));
  const now = new Date().toISOString();

  for (const record of records) {
    const existing = await db.get(
      "SELECT * FROM student_competency_state WHERE tenant_id = ? AND student_id = ? AND learning_outcome_id = ? AND learning_outcome = ?",
      tenantId, studentId, record.learningOutcomeId, record.learningOutcome,
    );
    const previous = parseHistory(existing?.history);
    const filtered = previous.filter((snapshot) => snapshot.assessmentId !== record.assessmentId);
    const history = [...filtered, record].sort((a, b) => Date.parse(a.submittedAt || "") - Date.parse(b.submittedAt || "")).slice(-30);
    const trajectory = buildLearningOutcomeTrajectory(record.learningOutcomeId, record.learningOutcome, history);
    await db.run(
      `INSERT INTO student_competency_state
       (tenant_id, student_id, learning_outcome_id, learning_outcome, latest_score, latest_submitted_at, snapshot_count, history, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, student_id, learning_outcome_id, learning_outcome) DO UPDATE SET
         latest_score = excluded.latest_score, latest_submitted_at = excluded.latest_submitted_at,
         snapshot_count = excluded.snapshot_count, history = excluded.history, updated_at = excluded.updated_at`,
      tenantId, studentId, record.learningOutcomeId, record.learningOutcome,
      trajectory.latest?.score ?? 0, trajectory.latest?.submittedAt || record.submittedAt || null,
      Number(existing?.snapshot_count || 0) + (existing && filtered.length < previous.length ? 0 : 1),
      JSON.stringify(trajectory.history), now,
    );
  }
}

function stateToTrajectory(row) {
  const history = parseHistory(row.history);
  return buildLearningOutcomeTrajectory(row.learning_outcome_id, row.learning_outcome, history);
}

module.exports = { materializeSubmission, recordsForSubmission, stateToTrajectory };
