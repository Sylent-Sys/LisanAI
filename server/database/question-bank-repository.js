const crypto = require("node:crypto");

function cryptoRandom() { return crypto.randomUUID().replace(/-/g, ""); }

async function saveQuestionToBank(db, auth, question) {
  const id = cryptoRandom(); const now = new Date().toISOString();
  await db.run(`INSERT INTO question_bank (id, tenant_id, teacher_id, topic, difficulty, prompt, focus, outcome, learning_outcome_ids, learning_outcome_id, rubric, ideal, criteria, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, auth.tenant.id, auth.user.id,
    String(question.topic || "").trim(), String(question.difficulty || "").trim(), String(question.prompt || "").trim(),
    String(question.focus || "").trim(), String(question.outcome || "").trim(),
    JSON.stringify(Array.isArray(question.learningOutcomeIds) ? question.learningOutcomeIds : (question.learningOutcomeId ? [question.learningOutcomeId] : [])),
    String(question.learningOutcomeId || "").trim(),
    String(question.rubric || "").trim(),
    String(question.ideal || "").trim(), JSON.stringify(Array.isArray(question.criteria) ? question.criteria : []), now, now);
  return { id };
}

async function listQuestionBank(db, auth, filter = {}) {
  const { topic, difficulty } = filter; let sql = "SELECT * FROM question_bank WHERE tenant_id = ? AND teacher_id = ?";
  const params = [auth.tenant.id, auth.user.id];
  // LOWER() on both sides: SQLite LIKE ignores ASCII case, PostgreSQL LIKE does not.
  if (topic) { sql += " AND LOWER(topic) LIKE LOWER(?)"; params.push(`%${topic}%`); }
  if (difficulty) { sql += " AND difficulty = ?"; params.push(difficulty); }
  sql += " ORDER BY created_at DESC";
  const rows = await db.all(sql, ...params);
  return rows.map((r) => ({
    id: r.id, topic: r.topic, difficulty: r.difficulty, prompt: r.prompt, focus: r.focus, outcome: r.outcome,
    learningOutcomeIds: (() => { try { return JSON.parse(r.learning_outcome_ids || "[]"); } catch { return r.learning_outcome_id ? [r.learning_outcome_id] : []; } })(),
    learningOutcomeId: r.learning_outcome_id || "",
    rubric: r.rubric, ideal: r.ideal, criteria: JSON.parse(r.criteria || "[]"), createdAt: r.created_at, updatedAt: r.updated_at
  }));
}

async function deleteQuestionFromBank(db, auth, questionId) {
  await db.run("DELETE FROM question_bank WHERE id = ? AND tenant_id = ? AND teacher_id = ?", questionId, auth.tenant.id, auth.user.id);
}

module.exports = { saveQuestionToBank, listQuestionBank, deleteQuestionFromBank };
