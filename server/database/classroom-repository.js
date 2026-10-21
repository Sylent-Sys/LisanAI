// A student has one membership row per class (UNIQUE class_id, student_id); a
// new request or approval replaces its values, as INSERT OR REPLACE did.
const MEMBERSHIP_UPSERT_SET = `id = excluded.id, tenant_id = excluded.tenant_id, status = excluded.status,
      requested_at = excluded.requested_at, approved_at = excluded.approved_at`;

async function createClass(db, tenantId, teacherId, classroom) {
  await db.run(`INSERT INTO classes (id, tenant_id, teacher_id, name, join_code, created_at) VALUES (?, ?, ?, ?, ?, ?)`, classroom.id, tenantId, teacherId, classroom.name, classroom.joinCode, classroom.createdAt);
  return classroom;
}

async function getWritableClass(db, auth, classId) {
  const classroom = await db.get("SELECT * FROM classes WHERE id = ? AND tenant_id = ?", classId, auth.tenant.id);
  if (!classroom) throw Object.assign(new Error("Kelas tidak ditemukan"), { status: 404 });
  if (auth.user.role === "teacher" && classroom.teacher_id !== auth.user.id) throw Object.assign(new Error("Guru hanya boleh mengubah kelas miliknya"), { status: 403 });
  return classroom;
}

async function updateClass(db, auth, classId, patch) {
  const classroom = await getWritableClass(db, auth, classId);
  const name = String(patch.name || classroom.name).trim();
  if (!name) throw Object.assign(new Error("Nama kelas wajib diisi"), { status: 400 });
  await db.run("UPDATE classes SET name = ? WHERE id = ? AND tenant_id = ?", name, classId, auth.tenant.id);
  return { ...classroom, name };
}

async function deleteClass(db, auth, classId) {
  await getWritableClass(db, auth, classId);
  await db.run("DELETE FROM assessment_classes WHERE tenant_id = ? AND class_id = ?", auth.tenant.id, classId);
  await db.run("DELETE FROM classes WHERE id = ? AND tenant_id = ?", classId, auth.tenant.id);
}

async function getVisibleClasses(db, auth) {
  if (auth.user.role === "student") return db.all(`SELECT classes.*, class_memberships.status FROM class_memberships JOIN classes ON classes.id = class_memberships.class_id WHERE class_memberships.tenant_id = ? AND class_memberships.student_id = ? ORDER BY classes.created_at DESC`, auth.tenant.id, auth.user.id);
  if (auth.user.role === "teacher") return db.all("SELECT *, 'teacher' AS status FROM classes WHERE tenant_id = ? AND teacher_id = ? ORDER BY created_at DESC", auth.tenant.id, auth.user.id);
  return db.all("SELECT *, 'admin' AS status FROM classes WHERE tenant_id = ? ORDER BY created_at DESC", auth.tenant.id);
}

async function requestJoinClass(db, tenantId, studentId, joinCode, membership) {
  const classroom = await db.get("SELECT * FROM classes WHERE tenant_id = ? AND join_code = ?", tenantId, joinCode);
  if (!classroom) throw Object.assign(new Error("Kode kelas tidak ditemukan"), { status: 404 });
  await db.run(`INSERT INTO class_memberships (id, tenant_id, class_id, student_id, status, requested_at, approved_at) VALUES (?, ?, ?, ?, 'pending', ?, NULL)
    ON CONFLICT (class_id, student_id) DO UPDATE SET ${MEMBERSHIP_UPSERT_SET}`, membership.id, tenantId, classroom.id, studentId, membership.requestedAt);
  return classroom;
}

async function assertTeacherOwnsClass(db, tenantId, teacherId, classId) {
  const classroom = await db.get("SELECT id FROM classes WHERE id = ? AND tenant_id = ? AND teacher_id = ?", classId, tenantId, teacherId);
  if (!classroom) throw Object.assign(new Error("Kelas tidak ditemukan atau tidak milik Anda"), { status: 404 });
  return classroom;
}

async function addApprovedStudent(db, tenantId, classId, studentId, membershipId, now) {
  await db.run(`INSERT INTO class_memberships (id, tenant_id, class_id, student_id, status, requested_at, approved_at) VALUES (?, ?, ?, ?, 'approved', ?, ?)
    ON CONFLICT (class_id, student_id) DO UPDATE SET ${MEMBERSHIP_UPSERT_SET}`, membershipId, tenantId, classId, studentId, now, now);
}

async function clearData(db, tenantId) {
  await db.run("DELETE FROM evaluation_events WHERE run_id IN (SELECT run_id FROM evaluation_runs WHERE tenant_id = ?)", tenantId);
  await db.run("DELETE FROM evaluation_results WHERE run_id IN (SELECT run_id FROM evaluation_runs WHERE tenant_id = ?)", tenantId);
  await db.run("DELETE FROM evaluation_criteria WHERE run_id IN (SELECT run_id FROM evaluation_runs WHERE tenant_id = ?)", tenantId);
  await db.run("DELETE FROM evaluation_versions WHERE run_id IN (SELECT run_id FROM evaluation_runs WHERE tenant_id = ?)", tenantId);
  await db.run("DELETE FROM evaluation_human_scores WHERE run_id IN (SELECT run_id FROM evaluation_runs WHERE tenant_id = ?)", tenantId);
  await db.run("DELETE FROM human_approvals WHERE tenant_id = ?", tenantId);
  await db.run("DELETE FROM evaluation_runs WHERE tenant_id = ?", tenantId);
  await db.run("DELETE FROM ai_logs WHERE tenant_id = ?", tenantId);
  await db.run("DELETE FROM submissions WHERE tenant_id = ?", tenantId);
  await db.run("DELETE FROM assessment_classes WHERE tenant_id = ?", tenantId);
  await db.run("DELETE FROM assessments WHERE tenant_id = ?", tenantId);
  await db.run("DELETE FROM question_bank WHERE tenant_id = ?", tenantId);
}

module.exports = { createClass, updateClass, deleteClass, getWritableClass, getVisibleClasses, requestJoinClass, assertTeacherOwnsClass, addApprovedStudent, clearData };
