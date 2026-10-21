// Bound teacher/admin state payloads to the newest submissions so the state
// response cannot grow without limit (each row carries a large JSON payload).
const SUBMISSION_FETCH_LIMIT = 500;
const ATTEMPT_EVALUATION_LEASE_MS = 15 * 60 * 1000;
const { assessmentSnapshotHash, rubricHash, answersHash, hashObject } = require("../security/assessment-integrity");
const crypto = require("node:crypto");
const { isForeignKeyViolation } = require("./client");

function randomId(prefix) { return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`; }

// PostgreSQL has no json_set for TEXT payloads, so the JSON is changed in
// application code under a row lock instead of in SQL.
async function updatePayloadInTransaction(db, whereClauses, whereArgs, mutate) {
  const where = whereClauses.join(" AND ");
  return db.transaction(async (tx) => {
    const row = await tx.get(`SELECT payload FROM submissions WHERE ${where} FOR UPDATE`, ...whereArgs);
    if (!row) return { changes: 0 };
    const payload = JSON.parse(row.payload);
    mutate(payload);
    return tx.run(`UPDATE submissions SET payload = ? WHERE ${where}`, JSON.stringify(payload), ...whereArgs);
  });
}

function attemptError(message, status = 400, code = null) {
  const error = Object.assign(new Error(message), { status });
  if (code) error.code = code;
  return error;
}

function parseAssessment(row) {
  try { return JSON.parse(row?.payload || "{}"); }
  catch { throw attemptError("Data assessment tidak valid", 500); }
}

function buildAttemptSnapshot(assessment) {
  const snapshot = JSON.parse(JSON.stringify(assessment));
  // Student attempt snapshots must never carry teacher-only ideal answers.
  snapshot.questions = (snapshot.questions || []).map((q) => {
    const copy = { ...q };
    delete copy.ideal;
    return copy;
  });
  return snapshot;
}

function attemptDurationSeconds(assessment) {
  const questions = Array.isArray(assessment?.questions) ? assessment.questions : [];
  const perQuestion = Math.max(0, Number(assessment?.timeLimit) || 0);
  if (!perQuestion) return null;
  const timedSegments = questions.reduce((sum, q) => sum + 1 + (q?.probing ? 1 : 0), 0);
  return Math.max(perQuestion, timedSegments * perQuestion);
}

async function getCanonicalAssessmentForStudent(db, tenantId, userId, assessmentId, requestedClassId = null) {
  const row = await db.get(
    "SELECT * FROM assessments WHERE id = ? AND tenant_id = ?",
    assessmentId, tenantId,
  );
  if (!row) throw attemptError("Assessment tidak ditemukan", 404, "ASSESSMENT_NOT_FOUND");
  if (row.status !== "published") throw attemptError("Assessment belum tersedia untuk dikerjakan", 403, "ASSESSMENT_NOT_PUBLISHED");
  const membership = await db.get(
    `SELECT cm.class_id
       FROM assessment_classes ac
       JOIN class_memberships cm ON cm.class_id = ac.class_id
        AND cm.tenant_id = ac.tenant_id AND cm.student_id = ? AND cm.status = 'approved'
      WHERE ac.tenant_id = ? AND ac.assessment_id = ? AND ac.status = 'published'
        AND (CAST(? AS TEXT) IS NULL OR ac.class_id = ?)
      ORDER BY ac.class_id LIMIT 1`,
    userId, tenantId, assessmentId, requestedClassId || null, requestedClassId || null,
  );
  if (!membership) throw attemptError("Siswa belum disetujui di kelas assessment ini", 403, "ASSESSMENT_ACCESS_DENIED");
  const assessment = parseAssessment(row);
  assessment.classId = membership.class_id;
  return { row, assessment };
}

async function createAssessmentAttempt(db, auth, assessmentId, requestedClassId = null, idempotencyKey = null) {
  const { row, assessment } = await getCanonicalAssessmentForStudent(db, auth.tenant.id, auth.user.id, assessmentId, requestedClassId);
  const allowRetakes = assessment.allowRetakes === true;
  const maxAttempts = Math.max(1, Number(assessment.maxAttempts) || 1);
  const existingActive = await db.get(
    `SELECT * FROM assessment_attempts
      WHERE tenant_id = ? AND assessment_id = ? AND user_id = ?
        AND status IN ('STARTED','SUBMITTING')
      ORDER BY attempt_no DESC LIMIT 1`,
    auth.tenant.id, assessmentId, auth.user.id,
  );
  if (existingActive) return formatAttempt(existingActive);

  if (idempotencyKey) {
    const existingKey = await db.get(
      "SELECT * FROM assessment_attempts WHERE tenant_id = ? AND assessment_id = ? AND user_id = ? AND idempotency_key = ?",
      auth.tenant.id, assessmentId, auth.user.id, idempotencyKey,
    );
    if (existingKey) return formatAttempt(existingKey);
  }

  let attemptNo = 1;
  const latest = await db.get(
    "SELECT MAX(attempt_no) AS max_no FROM assessment_attempts WHERE tenant_id = ? AND assessment_id = ? AND user_id = ?",
    auth.tenant.id, assessmentId, auth.user.id,
  );
  attemptNo = Number(latest?.max_no || 0) + 1;
  if (!allowRetakes && attemptNo > maxAttempts) throw attemptError(`Batas percobaan tercapai (${maxAttempts} dari ${maxAttempts})`, 409, "ATTEMPT_LIMIT_REACHED");
  if (allowRetakes === false && attemptNo > maxAttempts) throw attemptError("Batas percobaan tercapai", 409, "ATTEMPT_LIMIT_REACHED");

  // Bind the attempt to the full canonical assessment hash. The persisted
  // student snapshot remains sanitized (without teacher-only ideal answers),
  // but its integrity hash must represent the canonical source used at scoring.
  const snapshot = buildAttemptSnapshot(assessment);
  const assessmentHash = assessmentSnapshotHash(assessment);
  const snapshotRubricHash = rubricHash(snapshot);
  const startedAt = new Date();
  const duration = attemptDurationSeconds(snapshot);
  const deadlineAt = duration == null ? null : new Date(startedAt.getTime() + duration * 1000).toISOString();
  const attemptId = randomId("attempt");

  try {
    await db.run(
      `INSERT INTO assessment_attempts
       (id, tenant_id, assessment_id, user_id, attempt_no, status, assessment_hash, rubric_hash,
        snapshot_json, started_at, deadline_at, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, 'STARTED', ?, ?, ?, ?, ?, ?, ?)`,
      attemptId, auth.tenant.id, assessmentId, auth.user.id, attemptNo, assessmentHash,
      snapshotRubricHash, JSON.stringify(snapshot), startedAt.toISOString(), deadlineAt,
      idempotencyKey || null, startedAt.toISOString(),
    );
  } catch (error) {
    if (String(error.message || "").includes("UNIQUE")) {
      const retry = await db.get(
        "SELECT * FROM assessment_attempts WHERE tenant_id = ? AND assessment_id = ? AND user_id = ? AND status IN ('STARTED','SUBMITTING') ORDER BY attempt_no DESC LIMIT 1",
        auth.tenant.id, assessmentId, auth.user.id,
      );
      if (retry) return formatAttempt(retry);
    }
    throw error;
  }

  return {
    id: attemptId,
    assessmentId,
    attemptNo,
    status: "STARTED",
    startedAt: startedAt.toISOString(),
    deadlineAt,
    assessmentHash,
    rubricHash: snapshotRubricHash,
    assessment: snapshot,
  };
}

function formatAttempt(row) {
  return {
    id: row.id, assessmentId: row.assessment_id, attemptNo: Number(row.attempt_no),
    status: row.status, startedAt: row.started_at, deadlineAt: row.deadline_at,
    assessmentHash: row.assessment_hash, rubricHash: row.rubric_hash,
    submissionId: row.submission_id || null,
  };
}

async function getAssessmentAttempt(db, auth, attemptId) {
  const row = await db.get(
    "SELECT * FROM assessment_attempts WHERE id = ? AND tenant_id = ? AND user_id = ?",
    attemptId, auth.tenant.id, auth.user.id,
  );
  if (!row) throw attemptError("Attempt tidak ditemukan", 404, "ATTEMPT_NOT_FOUND");
  return row;
}

async function beginAttemptEvaluation(db, auth, attemptId, answers, expectedAssessmentId) {
  const row = await getAssessmentAttempt(db, auth, attemptId);
  if (row.assessment_id !== expectedAssessmentId) throw attemptError("Attempt tidak cocok dengan assessment", 409, "ATTEMPT_ASSESSMENT_MISMATCH");
  if (row.status === "FINALIZED" && row.submission_id) {
    const existing = await db.get("SELECT payload FROM submissions WHERE id = ? AND tenant_id = ?", row.submission_id, auth.tenant.id);
    if (existing) return { attempt: row, existingSubmission: JSON.parse(existing.payload) };
  }
  if (row.status === "SUBMITTING") {
    const leaseStarted = row.evaluation_started_at ? Date.parse(row.evaluation_started_at) : NaN;
    const leaseExpired = !Number.isFinite(leaseStarted) || Date.now() - leaseStarted > ATTEMPT_EVALUATION_LEASE_MS;
    if (!leaseExpired) throw attemptError("Attempt sedang diproses oleh evaluasi lain", 409, "ATTEMPT_EVALUATION_IN_PROGRESS");
    if (row.deadline_at && Date.now() > Date.parse(row.deadline_at)) {
      await db.run("UPDATE assessment_attempts SET status = 'EXPIRED' WHERE id = ? AND status = 'SUBMITTING'", attemptId);
      throw attemptError("Waktu assessment telah habis", 409, "ATTEMPT_EXPIRED");
    }
    await db.run("UPDATE assessment_attempts SET status = 'STARTED', evaluation_started_at = NULL WHERE id = ? AND status = 'SUBMITTING'", attemptId);
  }
  if (row.status === "EXPIRED") throw attemptError("Attempt sudah kedaluwarsa", 409, "ATTEMPT_EXPIRED");
  if (row.status === "CANCELLED") throw attemptError("Attempt sudah dibatalkan", 409, "ATTEMPT_CANCELLED");
  if (row.deadline_at && Date.now() > Date.parse(row.deadline_at)) {
    await db.run("UPDATE assessment_attempts SET status = 'EXPIRED' WHERE id = ? AND status IN ('STARTED','SUBMITTING')", attemptId);
    throw attemptError("Waktu assessment telah habis", 409, "ATTEMPT_EXPIRED");
  }
  if (!["STARTED", "SUBMITTING"].includes(row.status)) throw attemptError("Status attempt tidak dapat dievaluasi", 409, "ATTEMPT_INVALID_STATE");
  const evaluationStartedAt = new Date().toISOString();
  const claimed = await db.run(
    "UPDATE assessment_attempts SET status = 'SUBMITTING', evaluation_started_at = ? WHERE id = ? AND status = 'STARTED'",
    evaluationStartedAt, attemptId,
  );
  if (!claimed.changes) throw attemptError("Attempt sedang diproses oleh evaluasi lain", 409, "ATTEMPT_EVALUATION_IN_PROGRESS");
  return { attempt: { ...row, status: "SUBMITTING", evaluation_started_at: evaluationStartedAt } };
}

async function releaseAttemptEvaluation(db, auth, attemptId) {
  await db.run(
    "UPDATE assessment_attempts SET status = 'STARTED', evaluation_started_at = NULL WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'SUBMITTING'",
    attemptId, auth.tenant.id, auth.user.id,
  );
}

async function finalizeAssessmentAttempt(db, auth, attemptId, submission, hashes = {}) {
  const row = await getAssessmentAttempt(db, auth, attemptId);
  if (row.status === "FINALIZED" && row.submission_id) {
    const existing = await db.get("SELECT payload FROM submissions WHERE id = ? AND tenant_id = ?", row.submission_id, auth.tenant.id);
    return existing ? JSON.parse(existing.payload) : submission;
  }
  if (hashes.evaluationHash) {
    const run = await db.get(
      "SELECT attempt_id, assessment_hash, answer_hash, attempt_rubric_hash, evaluation_hash FROM evaluation_runs WHERE run_id = ? AND tenant_id = ?",
      submission.evaluationRunId || null, auth.tenant.id,
    );
    if (!run || run.attempt_id !== attemptId ||
        run.assessment_hash !== (hashes.assessmentHash || row.assessment_hash) ||
        run.answer_hash !== hashes.answerHash ||
        run.attempt_rubric_hash !== (hashes.rubricHash || row.rubric_hash) ||
        run.evaluation_hash !== hashes.evaluationHash) {
      throw attemptError("Evaluation trace tidak konsisten dengan submission", 409, "EVALUATION_INTEGRITY_MISMATCH");
    }
  }
  const now = new Date().toISOString();
  await db.run(
    `UPDATE assessment_attempts
       SET status = 'FINALIZED', submitted_at = ?, submission_id = ?, evaluation_started_at = NULL
     WHERE id = ? AND tenant_id = ? AND user_id = ? AND status IN ('STARTED','SUBMITTING')`,
    now, submission.id, attemptId, auth.tenant.id, auth.user.id,
  );
  await db.run(
    `UPDATE submissions
       SET attempt_id = ?, assessment_hash = ?, rubric_hash = ?, submission_hash = ?, evaluation_status = ?
     WHERE id = ? AND tenant_id = ?`,
    attemptId, hashes.assessmentHash || row.assessment_hash, hashes.rubricHash || row.rubric_hash,
    hashes.submissionHash || hashObject(submission), submission.status || "EVALUATED",
    submission.id, auth.tenant.id,
  );
  return submission;
}
const { materializeSubmission } = require("../competency-materializer");

async function refreshCompetencyState(db, tenantId, studentId, submission) {
  if (!studentId || !submission?.assessmentId) return;
  try {
    await materializeSubmission(db, tenantId, studentId, submission);
  } catch (error) {
    // Submission persistence must remain successful even if the derived
    // competency projection temporarily fails. The next competency read can
    // rebuild the projection from canonical submission data.
    console.warn("[competency-materializer] materialization skipped:", error.message);
  }
}

async function assertCanSubmitAssessment(db, tenantId, userId, assessmentId, requestedClassId = null) {
  // A missing assessmentId is legitimate for flows where submissions are not
  // bound to an assessment (see migration 010_submissions_nullable_assessment).
  if (assessmentId == null) return;
  const assessment = await db.get("SELECT id, class_id, status, payload FROM assessments WHERE id = ? AND tenant_id = ?", assessmentId, tenantId);
  if (!assessment) throw Object.assign(new Error("Assessment tidak ditemukan"), { status: 404 });
  if (assessment.status !== "published") throw Object.assign(new Error("Assessment belum tersedia untuk dikerjakan"), { status: 403 });
  const membership = await db.get(
    `SELECT cm.id, cm.class_id
     FROM assessment_classes ac
     JOIN class_memberships cm ON cm.class_id = ac.class_id
       AND cm.tenant_id = ac.tenant_id AND cm.student_id = ? AND cm.status = 'approved'
     WHERE ac.tenant_id = ? AND ac.assessment_id = ? AND ac.status = 'published'
       AND (CAST(? AS TEXT) IS NULL OR ac.class_id = ?)
     ORDER BY ac.class_id
     LIMIT 1`,
    userId, tenantId, assessmentId, requestedClassId || null, requestedClassId || null,
  );
  if (!membership) throw Object.assign(new Error("Siswa belum disetujui di kelas assessment ini"), { status: 403 });
  const payload = JSON.parse(assessment.payload);
  if (payload.allowRetakes === true) return;
  const maxAttempts = Math.max(1, Number(payload.maxAttempts) || 1);
  const existing = await db.get("SELECT COUNT(*) AS cnt FROM submissions WHERE tenant_id = ? AND assessment_id = ? AND user_id = ?", tenantId, assessmentId, userId);
  if (Number(existing?.cnt || 0) >= maxAttempts) throw Object.assign(new Error(`Batas percobaan tercapai (${maxAttempts} dari ${maxAttempts})`), { status: 409 });
  return membership.class_id;
}

async function saveSubmission(db, tenantId, userId, submission, bypassCheck = false) {
  if (userId && !bypassCheck) {
    const classId = await assertCanSubmitAssessment(db, tenantId, userId, submission.assessmentId, submission.classId || null);
    if (classId) submission = { ...submission, classId };
  }
  // Upsert keeps the attempt binding columns (attempt_id, hashes,
  // evaluation_status) that INSERT OR REPLACE used to reset to NULL on re-save.
  const insert = (assessmentId) => db.run(`INSERT INTO submissions (id, tenant_id, assessment_id, student_name, user_id, final_score, payload, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET tenant_id = excluded.tenant_id, assessment_id = excluded.assessment_id,
         student_name = excluded.student_name, user_id = excluded.user_id, final_score = excluded.final_score,
         payload = excluded.payload, submitted_at = excluded.submitted_at`, submission.id, tenantId, assessmentId, submission.studentName, userId, submission.finalScore, JSON.stringify(submission), submission.submittedAt);
  try { await insert(submission.assessmentId); }
  catch (err) {
    if (!isForeignKeyViolation(err)) throw err;
    // Only a submission that never referenced an assessment may fall back to a
    // NULL assessment_id. A provided-but-missing assessment must not silently
    // create an orphan row that bypasses attempt limits and teacher queries.
    if (submission.assessmentId == null) {
      await insert(null);
      return submission;
    }
    throw Object.assign(new Error("Assessment tidak ditemukan"), { status: 404 });
  }
  await refreshCompetencyState(db, tenantId, userId, submission);
  return submission;
}

async function getVisibleSubmissions(db, auth) {
  if (auth.user.role === "student") return db.all("SELECT payload FROM submissions WHERE tenant_id = ? AND user_id = ? ORDER BY submitted_at ASC", auth.tenant.id, auth.user.id);
  if (auth.user.role === "teacher") return db.all(`SELECT s.payload FROM (SELECT s.payload, s.submitted_at FROM submissions s JOIN assessments a ON a.id = s.assessment_id WHERE s.tenant_id = ? AND a.tenant_id = ? AND a.teacher_id = ? ORDER BY s.submitted_at DESC LIMIT ${SUBMISSION_FETCH_LIMIT}) s ORDER BY s.submitted_at ASC`, auth.tenant.id, auth.tenant.id, auth.user.id);
  return db.all(`SELECT payload FROM (SELECT payload, submitted_at FROM submissions WHERE tenant_id = ? ORDER BY submitted_at DESC LIMIT ${SUBMISSION_FETCH_LIMIT}) s ORDER BY submitted_at ASC`, auth.tenant.id);
}

async function getSubmissionDetail(db, auth, submissionId) {
  const row = await db.get("SELECT * FROM submissions WHERE id = ? AND tenant_id = ?", submissionId, auth.tenant.id);
  if (!row) throw Object.assign(new Error("Submission tidak ditemukan"), { status: 404 });
  if (auth.user.role === "student") {
    if (!row.user_id || row.user_id !== auth.user.id) throw Object.assign(new Error("Siswa hanya dapat buka submission miliknya"), { status: 403 });
  } else if (auth.user.role === "teacher") {
    const classroom = row.assessment_id ? await db.get(
      `SELECT c.teacher_id
       FROM assessment_classes ac
       JOIN classes c ON c.id = ac.class_id AND c.tenant_id = ac.tenant_id
       WHERE ac.tenant_id = ? AND ac.assessment_id = ? AND ac.class_id = COALESCE(?, ac.class_id)
         AND c.teacher_id = ? LIMIT 1`,
      auth.tenant.id, row.assessment_id, (() => { try { return JSON.parse(row.payload || "{}").classId || null; } catch { return null; } })(), auth.user.id,
    ) : null;
    if (!classroom || classroom.teacher_id !== auth.user.id) throw Object.assign(new Error("Guru hanya bisa buka submission miliknya"), { status: 403 });
  }
  return JSON.parse(row.payload);
}

async function getSubmissionForUpdate(db, auth, submissionId) {
  const row = await db.get("SELECT * FROM submissions WHERE id = ? AND tenant_id = ?", submissionId, auth.tenant.id);
  if (!row) throw Object.assign(new Error("Submission tidak ditemukan"), { status: 404 });
  if (auth.user.role === "teacher") {
    const assessment = row.assessment_id ? await db.get("SELECT id FROM assessments WHERE id = ? AND tenant_id = ?", row.assessment_id, auth.tenant.id) : null;
    if (!assessment) throw Object.assign(new Error("Assessment tidak ditemukan"), { status: 404 });
    let submissionClassId = null;
    try { submissionClassId = JSON.parse(row.payload || "{}").classId || null; } catch {}
    const classroom = await db.get(
      `SELECT c.teacher_id FROM assessment_classes ac
       JOIN classes c ON c.id = ac.class_id AND c.tenant_id = ac.tenant_id
       WHERE ac.tenant_id = ? AND ac.assessment_id = ? AND ac.class_id = COALESCE(?, ac.class_id)
       LIMIT 1`,
      auth.tenant.id, assessment.id, submissionClassId,
    );
    if (!classroom || classroom.teacher_id !== auth.user.id) throw Object.assign(new Error("Guru hanya boleh mengoreksi kelas miliknya"), { status: 403 });
  }
  return row;
}

async function getStudentSubmission(db, auth, submissionId) {
  const row = await db.get("SELECT * FROM submissions WHERE id = ? AND tenant_id = ? AND user_id = ?", submissionId, auth.tenant.id, auth.user.id);
  if (!row) throw Object.assign(new Error("Submission tidak ditemukan"), { status: 404 });
  return row;
}

async function saveComplaint(db, auth, submissionId, questionIndex, reason) {
  const row = await getStudentSubmission(db, auth, submissionId);
  let submission;
  try { submission = JSON.parse(row.payload); } catch { throw Object.assign(new Error("Data submission tidak valid"), { status: 500 }); }
  const qs = submission.questionScores?.[questionIndex];
  if (!qs) throw Object.assign(new Error("Soal tidak ditemukan"), { status: 400 });
  qs.complaint = { reason: String(reason).trim(), status: "pending", submittedAt: new Date().toISOString() };
  await saveSubmission(db, auth.tenant.id, auth.user.id, submission, true);
  return submission;
}

async function updateSubmissionAudio(db, tenantId, submissionId, { index, kind }, audio, options = {}) {
  const clauses = ["id = ?", "tenant_id = ?"];
  const args = [submissionId, tenantId];
  if (options.userId) {
    clauses.push("user_id = ?");
    args.push(options.userId);
  }
  if (db.dialect === "postgres") {
    const result = await updatePayloadInTransaction(db, clauses, args, (payload) => {
      const entry = payload?.questionScores?.[Number(index)];
      if (!entry || typeof entry !== "object") return;
      if (kind === "probing") {
        const probing = entry.probing && typeof entry.probing === "object" ? entry.probing : {};
        entry.probing = { ...probing, audio };
      } else {
        entry.audio = audio;
      }
    });
    if (!result.changes) throw Object.assign(new Error("Submission tidak ditemukan"), { status: 404 });
    return;
  }
  let sql;
  let params;
  if (kind === "probing") {
    const probingPath = "'$.questionScores[' || CAST(? AS INTEGER) || '].probing'";
    sql = `UPDATE submissions SET payload = json_set(payload, ${probingPath}, json_set(COALESCE(json_extract(payload, ${probingPath}), json('{}')), '$.audio', ?)) WHERE ${clauses.join(" AND ")}`;
    params = [index, index, audio, ...args];
  } else {
    sql = `UPDATE submissions SET payload = json_set(payload, '$.questionScores[' || CAST(? AS INTEGER) || '].audio', ?) WHERE ${clauses.join(" AND ")}`;
    params = [index, audio, ...args];
  }
  const result = await db.run(sql, ...params);
  if (!result.changes) throw Object.assign(new Error("Submission tidak ditemukan"), { status: 404 });
}

async function updateSubmissionFeedback(db, tenantId, submissionId, fields) {
  if (db.dialect === "postgres") {
    const result = await updatePayloadInTransaction(db, ["id = ?", "tenant_id = ?"], [submissionId, tenantId], (payload) => {
      payload.evidenceFeedback = fields.evidenceFeedback ?? null;
      payload.evidenceQuality = fields.evidenceQuality ?? null;
      payload.competencyState = fields.competencyState ?? null;
      payload.scoreState = fields.scoreState ?? null;
    });
    if (!result.changes) throw Object.assign(new Error("Submission tidak ditemukan"), { status: 404 });
    return;
  }
  const result = await db.run(
    `UPDATE submissions SET payload = json_set(payload, '$.evidenceFeedback', json(?), '$.evidenceQuality', json(?), '$.competencyState', json(?), '$.scoreState', ?) WHERE id = ? AND tenant_id = ?`,
    JSON.stringify(fields.evidenceFeedback),
    JSON.stringify(fields.evidenceQuality),
    JSON.stringify(fields.competencyState),
    fields.scoreState,
    submissionId,
    tenantId
  );
  if (!result.changes) throw Object.assign(new Error("Submission tidak ditemukan"), { status: 404 });
  const row = await db.get("SELECT user_id, payload FROM submissions WHERE id = ? AND tenant_id = ?", submissionId, tenantId);
  if (!row?.user_id) return;
  await refreshCompetencyState(db, tenantId, row.user_id, JSON.parse(row.payload || "{}"));
}

function stripSubmissionAudio(submission) {
  if (!submission || typeof submission !== "object") return submission;
  const { audio: rootAudio, ...rest } = submission; const out = { ...rest };
  if (rootAudio !== undefined) out.hasAudio = true;
  if (Array.isArray(out.questionScores)) out.questionScores = out.questionScores.map((item) => {
    if (!item || item.audio === undefined) return item;
    const { audio, ...itemRest } = item; void audio; return { ...itemRest, hasAudio: true };
  });
  return out;
}

module.exports = { saveSubmission, assertCanSubmitAssessment, getVisibleSubmissions, getSubmissionDetail, getSubmissionForUpdate, saveComplaint, stripSubmissionAudio, updateSubmissionAudio, updateSubmissionFeedback, createAssessmentAttempt, getAssessmentAttempt, beginAttemptEvaluation, releaseAttemptEvaluation, finalizeAssessmentAttempt, getCanonicalAssessmentForStudent, assessmentSnapshotHash, rubricHash, answersHash };
