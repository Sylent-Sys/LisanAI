const { validateAssessmentIntegrity } = require("../assessment-integrity");

function writableError(message, status) { return Object.assign(new Error(message), { status }); }

function normalizeClassIds(assessment) {
  const raw = Array.isArray(assessment?.classIds)
    ? assessment.classIds
    : (assessment?.classId ? [assessment.classId] : []);
  return [...new Set(raw.map((id) => String(id || "").trim()).filter(Boolean))];
}

async function getWritableAssessment(db, auth, assessmentId) {
  const assessment = await db.get("SELECT * FROM assessments WHERE id = ? AND tenant_id = ?", assessmentId, auth.tenant.id);
  if (!assessment) throw writableError("Assessment tidak ditemukan", 404);
  if (auth.user.role === "teacher" && assessment.teacher_id !== auth.user.id) throw writableError("Guru hanya boleh mengubah assessment miliknya", 403);
  return assessment;
}

async function assertCanWriteAssessment(db, auth, assessment) {
  const classIds = normalizeClassIds(assessment);
  if (!classIds.length) throw writableError("Assessment wajib punya minimal satu kelas tujuan", 400);

  const placeholders = classIds.map(() => "?").join(",");
  const classes = await db.all(
    `SELECT id, teacher_id FROM classes WHERE tenant_id = ? AND id IN (${placeholders})`,
    auth.tenant.id,
    ...classIds,
  );
  if (classes.length !== classIds.length) throw writableError("Salah satu kelas tujuan tidak ditemukan", 404);
  if (auth.user.role === "teacher" && classes.some((classroom) => classroom.teacher_id !== auth.user.id)) {
    throw writableError("Guru hanya boleh menerbitkan assessment ke kelas miliknya", 403);
  }
  return classIds;
}

async function syncAssessmentClasses(db, tenantId, assessmentId, classIds, status, assignedAt) {
  await db.run("DELETE FROM assessment_classes WHERE tenant_id = ? AND assessment_id = ?", tenantId, assessmentId);
  for (const classId of classIds) {
    await db.run(
      `INSERT INTO assessment_classes (tenant_id, assessment_id, class_id, status, assigned_at)
       VALUES (?, ?, ?, ?, ?)`,
      tenantId, assessmentId, classId, status || "published", assignedAt || new Date().toISOString(),
    );
  }
}

async function enrichAssessments(db, auth, rows) {
  const assessments = [];
  for (const row of rows) {
    const payload = JSON.parse(row.payload);
    const assignments = auth.user.role === "student"
      ? await db.all(
        `SELECT ac.class_id, ac.status, ac.assigned_at, c.name, c.join_code
         FROM assessment_classes ac
         JOIN class_memberships cm ON cm.class_id = ac.class_id
           AND cm.tenant_id = ac.tenant_id AND cm.student_id = ? AND cm.status = 'approved'
         JOIN classes c ON c.id = ac.class_id AND c.tenant_id = ac.tenant_id
         WHERE ac.tenant_id = ? AND ac.assessment_id = ?
         ORDER BY c.name`,
        auth.user.id, auth.tenant.id, payload.id,
      )
      : await db.all(
        `SELECT ac.class_id, ac.status, ac.assigned_at, c.name, c.join_code
         FROM assessment_classes ac
         JOIN classes c ON c.id = ac.class_id AND c.tenant_id = ac.tenant_id
         WHERE ac.tenant_id = ? AND ac.assessment_id = ?
         ORDER BY c.name`,
        auth.tenant.id, payload.id,
      );

    if (!assignments.length && auth.user.role === "student") continue;

    payload.classIds = assignments.map((item) => item.class_id);
    payload.classAssignments = assignments.map((item) => ({
      classId: item.class_id,
      className: item.name,
      classCode: item.join_code,
      status: item.status,
      assignedAt: item.assigned_at,
    }));
    payload.classCodes = payload.classAssignments.map((item) => item.classCode).filter(Boolean);
    payload.classId = payload.classId || payload.classIds[0] || "";
    payload.availableClassIds = payload.classIds;
    assessments.push({ payload: JSON.stringify(payload) });
  }
  return assessments;
}

async function saveAssessment(db, auth, assessment) {
  const classIds = await assertCanWriteAssessment(db, auth, assessment);
  validateAssessmentIntegrity(assessment);
  const primaryClassId = classIds[0];
  const payload = { ...assessment, classId: primaryClassId, classIds };
  // Upsert instead of INSERT OR REPLACE: REPLACE deletes the old row first,
  // which cascaded to the assessment's attempts and submissions.
  await db.run(`INSERT INTO assessments (id, tenant_id, class_id, teacher_id, status, topic, difficulty, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET tenant_id = excluded.tenant_id, class_id = excluded.class_id,
       teacher_id = excluded.teacher_id, status = excluded.status, topic = excluded.topic,
       difficulty = excluded.difficulty, payload = excluded.payload, created_at = excluded.created_at`, payload.id, auth.tenant.id, primaryClassId, auth.user.id,
    payload.status || "published", payload.topic, payload.difficulty, JSON.stringify(payload), payload.createdAt);
  await syncAssessmentClasses(db, auth.tenant.id, payload.id, classIds, payload.status || "published", payload.createdAt);
  return payload;
}

async function updateAssessment(db, auth, assessmentId, patch) {
  const existing = await getWritableAssessment(db, auth, assessmentId);
  const payload = JSON.parse(existing.payload);
  const requestedClassIds = patch?.classIds || (patch?.classId ? [patch.classId] : null);
  const next = {
    ...payload,
    ...patch,
    id: payload.id,
    classId: requestedClassIds ? requestedClassIds[0] : (payload.classId || existing.class_id),
    classIds: requestedClassIds ? [...new Set(requestedClassIds.filter(Boolean))] : normalizeClassIds(payload),
    updatedAt: new Date().toISOString(),
  };
  await assertCanWriteAssessment(db, auth, next);
  validateAssessmentIntegrity(next);
  await db.run(`UPDATE assessments SET class_id = ?, status = ?, topic = ?, difficulty = ?, payload = ? WHERE id = ? AND tenant_id = ?`,
    next.classId, next.status || "published", next.topic, next.difficulty, JSON.stringify(next), assessmentId, auth.tenant.id);
  await syncAssessmentClasses(db, auth.tenant.id, assessmentId, next.classIds, next.status || "published", payload.createdAt || new Date().toISOString());
  return next;
}

async function deleteAssessment(db, auth, assessmentId) {
  await getWritableAssessment(db, auth, assessmentId);
  await db.run("DELETE FROM assessment_classes WHERE assessment_id = ? AND tenant_id = ?", assessmentId, auth.tenant.id);
  await db.run("DELETE FROM assessments WHERE id = ? AND tenant_id = ?", assessmentId, auth.tenant.id);
}

async function getVisibleAssessments(db, auth) {
  let rows;
  if (auth.user.role === "student") {
    // EXISTS instead of SELECT DISTINCT: one row per assessment, and
    // PostgreSQL rejects DISTINCT with an ORDER BY column outside the select list.
    rows = await db.all(
      `SELECT a.payload
       FROM assessments a
       WHERE a.tenant_id = ? AND COALESCE(a.status, 'published') = 'published'
         AND EXISTS (
           SELECT 1
           FROM assessment_classes ac
           JOIN class_memberships cm ON cm.class_id = ac.class_id AND cm.tenant_id = ac.tenant_id
           WHERE ac.assessment_id = a.id AND ac.tenant_id = a.tenant_id
             AND cm.student_id = ? AND cm.status = 'approved' AND ac.status = 'published'
         )
       ORDER BY a.created_at DESC`,
      auth.tenant.id, auth.user.id,
    );
  } else if (auth.user.role === "teacher") {
    rows = await db.all("SELECT payload FROM assessments WHERE tenant_id = ? AND teacher_id = ? ORDER BY created_at DESC", auth.tenant.id, auth.user.id);
  } else {
    rows = await db.all("SELECT payload FROM assessments WHERE tenant_id = ? ORDER BY created_at DESC", auth.tenant.id);
  }
  return enrichAssessments(db, auth, rows);
}

function sanitizeAssessmentForRole(assessment, isStudentView) {
  if (!isStudentView || !Array.isArray(assessment.questions)) return assessment;
  return { ...assessment, questions: assessment.questions.map((question) => { const { ideal, ...rest } = question || {}; return rest; }) };
}

module.exports = {
  saveAssessment, updateAssessment, deleteAssessment, getVisibleAssessments,
  getWritableAssessment, assertCanWriteAssessment, sanitizeAssessmentForRole,
  validateAssessmentIntegrity, normalizeClassIds,
};