const crypto = require("node:crypto");
const { getDb } = require("./database");
const pricing = require("./ai/pricing");
const {
  createTenantUser,
} = require("./auth-service");

/**
 * Demo-data seeding for Lisan.ai.
 *
 * Provides idempotent, tenant-scoped dummy data so every menu can be
 * presented nicely during demos:
 *   - Teacher demo: classes + students + memberships + assessments +
 *     evaluated submissions (with a complaint) → feeds Dashboard, Penilaian,
 *     Kelas, Siswa, Monitoring, Komplain.
 *   - Admin demo: everything the teacher gets, plus observability telemetry
 *     (ai_logs), research data (evaluation runs + criteria + human scores +
 *     approvals), and API keys → feeds Observabilitas, Riset, Akun, API Keys.
 */

function uid(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

/**
 * Tenant-scoped slug so demo users get unique emails even though the users
 * table enforces a GLOBAL unique email (demo accounts must not collide across
 * tenants).
 */
function tenantSlug(tenantId) {
  return crypto.createHash("sha256").update(tenantId).digest("hex").slice(0, 8);
}

/**
 * Track every row the demo seed creates so it can be rolled back precisely
 * ("hapus data dummy saja"), leaving original/organic data untouched.
 */
async function ensureDemoSeedTable(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS demo_seeds (
      tenant_id TEXT NOT NULL,
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, table_name, row_id)
    );
  `);
}

async function recordSeed(db, tenantId, tableName, rowId) {
  if (rowId == null) return;
  await db.run(
    `INSERT INTO demo_seeds (tenant_id, table_name, row_id, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    tenantId,
    tableName,
    rowId,
    new Date().toISOString()
  );
}

function hashKey(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

const STUDENT_NAMES = [
  "Ahmad Fauzi",
  "Siti Rahma",
  "Budi Santoso",
  "Dewi Lestari",
  "Rizky Pratama",
  "Nur Aisyah",
  "Andi Saputra",
  "Maya Putri",
  "Fajar Nugroho",
  "Intan Permata",
];

const ASSESSMENT_TEMPLATES = [
  {
    topic: "Perkenalan Diri dalam Bahasa Inggris",
    outcomes:
      "Siswa mampu memperkenalkan diri, menyebutkan asal dan hobi, serta merespons sapaan dalam bahasa Inggris dasar.",
    rubric:
      "Kejelasan komunikasi: 40% · Kosa kata: 30% · Struktur kalimat: 30%",
    difficulty: "Pemula",
    examples: "Introduce yourself to the class.",
    questions: [
      {
        id: "q-demo-intro-1",
        prompt: "Please tell us your name and where you are from.",
        focus: "introduce yourself",
        outcome: "Siswa dapat menyebutkan nama dan asal dalam bahasa Inggris.",
        rubric: "Kosa kata: 50%, kejelasan: 50%",
        ideal: "My name is Budi and I am from Jakarta.",
      },
      {
        id: "q-demo-intro-2",
        prompt: "What are your hobbies? Why do you like them?",
        focus: "hobbies",
        outcome: "Siswa dapat menyebutkan hobi dan alasan menyukainya.",
        rubric: "Kelancaran: 40%, alasan: 60%",
        ideal: "My hobbies are reading and swimming because they make me relaxed.",
      },
      {
        id: "q-demo-intro-3",
        prompt: "Describe your best friend in three sentences.",
        focus: "describing",
        outcome: "Siswa dapat menggambarkan orang lain secara sederhana.",
        rubric: "Deskripsi: 50%, struktur: 50%",
        ideal: "My best friend is kind. He likes football. We study together every day.",
      },
    ],
    scoreBands: [
      { score: 92, answer: "My name is Budi, I am from Jakarta. I love reading and swimming because they relax me. My best friend is friendly, he plays football, and we study together every day.", strengths: ["Kosa kata beragam", "Struktur kalimat benar", "Alasan disampaikan jelas"], gaps: [] },
      { score: 78, answer: "My name is Siti. I from Bandung. My hobby is reading and swim because fun. My friend very kind.", strengths: ["Informasi utama tersampaikan", "Fokus pertanyaan terjawab"], gaps: ["Grammar 'I from' → 'I am from'", "Kalimat belum lengkap"] },
      { score: 84, answer: "I am Ahmad from Surabaya. I enjoy cycling because it makes me healthy. My best friend is funny and clever, we play together after school.", strengths: ["Alasan logis", "Kalimat lengkap"], gaps: ["Pemakaian kata sambung bisa bervariasi"] },
    ],
  },
  {
    topic: "Fotosintesis dan Aliran Energi",
    outcomes:
      "Siswa mampu menjelaskan proses fotosintesis, peran cahaya, serta hubungannya dengan aliran energi dalam ekosistem.",
    rubric:
      "Ketepatan konsep: 40% · Penalaran sebab-akibat: 30% · Contoh relevan: 20% · Kejelasan: 10%",
    difficulty: "Menengah",
    examples: "Mengapa cahaya penting dalam fotosintesis?",
    questions: [
      {
        id: "q-demo-fot-1",
        prompt: "Jelaskan proses fotosintesis secara singkat.",
        focus: "fotosintesis",
        outcome: "Siswa mampu menjelaskan reaksi fotosintesis.",
        rubric: "Ketepatan konsep: 50%, kelengkapan: 50%",
        ideal: "Fotosintesis adalah proses tumbuhan mengubah cahaya, air, dan CO2 menjadi glukosa dan oksigen.",
      },
      {
        id: "q-demo-fot-2",
        prompt: "Mengapa cahaya matahari penting bagi proses fotosintesis?",
        focus: "cahaya",
        outcome: "Siswa mampu menjelaskan peran cahaya sebagai sumber energi.",
        rubric: "Konsep: 50%, alasan: 50%",
        ideal: "Cahaya menyediakan energi yang diperlukan untuk mengubah air dan CO2 menjadi glukosa.",
      },
      {
        id: "q-demo-fot-3",
        prompt: "Apa dampaknya bagi ekosistem jika tumbuhan tidak bisa berfotosintesis? Jelaskan.",
        focus: "ekosistem",
        outcome: "Siswa mampu mengaitkan fotosintesis dengan rantai makanan.",
        rubric: "Kausalitas: 60%, contoh: 40%",
        ideal: "Hewan herbivora tidak punya makanan, lalu karnivora ikut terdampak, sehingga rantai makanan runtuh.",
      },
    ],
    scoreBands: [
      { score: 90, answer: "Fotosintesis mengubah cahaya, air, dan karbondioksida menjadi glukosa dan oksigen. Cahaya adalah sumber energi utama proses itu. Jika tidak ada, tumbuhan tak bisa membuat makanan, herbivora kelaparan, lalu karnivora ikut terdampak, jadi ekosistem terganggu.", strengths: ["Konsep tepat dan lengkap", "Hubungan sebab-akibat runtut", "Contoh ekosistem nyata"], gaps: [] },
      { score: 68, answer: "Fotosintesis itu proses tumbuhan bikin makanan pakai cahaya. Cahaya penting karena bikin glukosa. Kalau tidak ada, tumbuhan mati dan hewan tidak makan.", strengths: ["Konsep inti dikenali", "Peran cahaya disebut"], gaps: ["Perlu menyebut air dan CO2", "Alasan sebab-akibat diperdalam"] },
      { score: 75, answer: "Fotosintesis butuh cahaya, air, dan CO2 menghasikan oksigen. Cahaya penting sebagai sumber tenaga. Jika tumbuhan tak fotosintesis, hewan pemakan tumbuhan tidak dapat makanan sehingga ekosistem terganggu.", strengths: ["Reaktan disebutkan", "Dampak ekosistem benar"], gaps: ["Contoh konkret bisa ditambah"] },
    ],
  },
  {
    topic: "Debat: Dampak Media Sosial",
    outcomes:
      "Siswa mampu menyampaikan pendapat secara logis dan menyanggah argumen dengan santun.",
    rubric:
      "Logika argumen: 45% · Kesantunan: 35% · Kosa kata: 20%",
    difficulty: "Lanjut",
    examples: "Apa pendapatmu tentang penggunaan media sosial di kalangan remaja?",
    questions: [
      {
        id: "q-demo-debat-1",
        prompt: "Sampaikan pendapat utama Anda tentang penggunaan media sosial pada remaja.",
        focus: "opini",
        outcome: "Siswa mampu menyampaikan pendapat disertai alasan.",
        rubric: "Logika: 60%, kesantunan: 40%",
        ideal: "Menurut saya media sosial bermanfaat jika digunakan bijak, karena memperluas wawasan dan koneksi.",
      },
      {
        id: "q-demo-debat-2",
        prompt: "Bagaimana cara mencegah dampak negatif media sosial?",
        focus: "solusi",
        outcome: "Siswa mampu mengusulkan solusi yang relevan.",
        rubric: "Solusi relevan: 50%, alasan: 50%",
        ideal: "Orang tua perlu mengawasi durasi pemakaian dan mendampingi anak memilih konten yang mendidik.",
      },
      {
        id: "q-demo-debat-3",
        prompt: "Sanggah pendapat bahwa media sosial selalu membawa mudarat bagi pelajar.",
        focus: "sanggahan",
        outcome: "Siswa mampu menyanggah secara santun dan logis.",
        rubric: "Sanggahan logis: 60%, kesantunan: 40%",
        ideal: "Dengan hormat, saya kurang setuju, karena dengan pengawasan media sosial justru bisa menjadi sumber pembelajaran yang efektif.",
      },
    ],
    scoreBands: [
      { score: 88, answer: "Menurut saya media sosial memberi manfaat jika digunakan bijak karena memperluas wawasan dan koneksi. Pencegahannya dengan pengawasan durasi dan pendampingan konten. Dengan hormat saya kurang setuju bahwa selalu mudarat, karena dengan pengawasan justru bisa jadi media belajar.", strengths: ["Pendapat jelas", "Solusi relevan", "Sanggahan santun"], gaps: [] },
      { score: 72, answer: "Media sosial ada baik buruknya. Perlu diawasi orang tua. Saya tidak setuju selalu mudarat, bisa untuk belajar juga.", strengths: ["Pendapat seimbang", "Sanggahan muncul"], gaps: ["Perlu memperkuat alasan", "Gunakan bahasa lebih formal"] },
      { score: 80, answer: "Media sosial bermanfaat untuk belajar dan bersosialisasi jika dipakai dengan bijak. Dampak negatif dicegah dengan membatasi waktu dan memilih konten mendidik. Saya kurang setuju media sosial selalu merugikan karena faktanya bisa menjadi alat pembelajaran yang efektif.", strengths: ["Argumen terstruktur", "Kesantunan baik"], gaps: ["Kosa kata bisa diperkaya"] },
    ],
  },
];

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function ensureClass(db, tenantId, teacherId) {
  const existing = await db.get(
    "SELECT * FROM classes WHERE tenant_id = ? AND teacher_id = ? AND name = ?",
    tenantId,
    teacherId,
    "Kelas Demo X-A"
  );
  if (existing) {
    await recordSeed(db, tenantId, "classes", existing.id);
    return existing;
  }

  const classroom = {
    id: uid("class"),
    name: "Kelas Demo X-A",
    joinCode: crypto.randomBytes(4).toString("hex").toUpperCase(),
    createdAt: isoDaysAgo(30),
  };
  await db.run(
    `INSERT INTO classes (id, tenant_id, teacher_id, name, join_code, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    classroom.id,
    tenantId,
    teacherId,
    classroom.name,
    classroom.joinCode,
    classroom.createdAt
  );
  await recordSeed(db, tenantId, "classes", classroom.id);
  return classroom;
}

async function ensureStudents(db, tenantId, classroomId, count = 6) {
  const tag = tenantSlug(tenantId);
  let existing = await db.all(
    `SELECT cm.*, u.name AS student_name, u.email AS student_email
       FROM class_memberships cm
       JOIN users u ON u.id = cm.student_id
      WHERE cm.tenant_id = ? AND cm.class_id = ? AND cm.status = 'approved'
      ORDER BY cm.requested_at ASC`,
    tenantId,
    classroomId
  );
  existing = existing.map((m) => ({
    id: m.id,
    studentId: m.student_id,
    studentName: m.student_name,
    studentEmail: m.student_email,
  }));

  for (let i = existing.length; i < count; i += 1) {
    const name = STUDENT_NAMES[i % STUDENT_NAMES.length];
    const slug = name.toLowerCase().replace(/[^a-z]+/g, ".");
    const email = `${slug}.${tag}.demo@lisan.ai`;
    let user = await db.get("SELECT id FROM users WHERE tenant_id = ? AND email = ?", tenantId, email);
    let studentId;
    if (user) {
      studentId = user.id;
      await recordSeed(db, tenantId, "users", studentId);
    } else {
      try {
        const created = await createTenantUser(tenantId, {
          name,
          email,
          password: "password123",
          role: "student",
        });
        studentId = created.id;
        await recordSeed(db, tenantId, "users", studentId);
      } catch (err) {
        if (err && /Email sudah terdaftar/i.test(err.message || "")) {
          const row = await db.get("SELECT id FROM users WHERE email = ?", email);
          studentId = row.id;
          await recordSeed(db, tenantId, "users", studentId);
        } else {
          throw err;
        }
      }
    }

    // Ensure membership (approved). Check any existing row to avoid violating
    // the UNIQUE (class_id, student_id) constraint.
    const membershipRow = await db.get(
      "SELECT id FROM class_memberships WHERE class_id = ? AND student_id = ?",
      classroomId,
      studentId
    );
    const membershipId = membershipRow
      ? membershipRow.id
      : `member-${crypto.randomBytes(8).toString("hex")}`;
    await db.run(
      `INSERT INTO class_memberships
         (id, tenant_id, class_id, student_id, status, requested_at, approved_at)
       VALUES (?, ?, ?, ?, 'approved', ?, ?)
       ON CONFLICT (class_id, student_id) DO UPDATE SET id = excluded.id, tenant_id = excluded.tenant_id,
         status = excluded.status, requested_at = excluded.requested_at, approved_at = excluded.approved_at`,
      membershipId,
      tenantId,
      classroomId,
      studentId,
      isoDaysAgo(29 - i),
      isoDaysAgo(28 - i)
    );
    await recordSeed(db, tenantId, "class_memberships", membershipId);
    existing.push({ id: membershipId, studentId, studentName: name, studentEmail: email });
  }

  return existing.slice(0, count);
}

async function ensureAssessments(db, tenantId, teacherId, classroomId, students) {
  const created = [];
  for (let i = 0; i < ASSESSMENT_TEMPLATES.length; i += 1) {
    const template = ASSESSMENT_TEMPLATES[i];
    let assessment = await db.get(
      "SELECT * FROM assessments WHERE tenant_id = ? AND topic = ? AND teacher_id = ?",
      tenantId,
      template.topic,
      teacherId
    );
    if (!assessment) {
      const questionCount = template.questions.length;
      const payload = {
        id: uid("assess"),
        classId: classroomId,
        topic: template.topic,
        outcomes: template.outcomes,
        rubric: template.rubric,
        difficulty: template.difficulty,
        examples: template.examples,
        questions: template.questions,
        status: "published",
        count: questionCount,
        timeLimit: 0,
        oralExamEnabled: true,
        disableManualTyping: false,
        allowRetakes: false,
        maxAttempts: 1,
        createdAt: isoDaysAgo(20 - i * 6),
      };
      await db.run(
        `INSERT INTO assessments (id, tenant_id, class_id, teacher_id, status, topic, difficulty, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        payload.id,
        tenantId,
        classroomId,
        teacherId,
        "published",
        payload.topic,
        payload.difficulty,
        JSON.stringify(payload),
        payload.createdAt
      );
      assessment = { id: payload.id, topic: payload.topic, payloadJson: JSON.stringify(payload) };
      await recordSeed(db, tenantId, "assessments", payload.id);
    } else {
      await recordSeed(db, tenantId, "assessments", assessment.id);
    }
    created.push(assessment);
  }
  return created;
}

/**
 * Create a full submission payload for a student + assessment + score band.
 * Include questionScores, criteria, insight, and (optionally) a complaint.
 */
function buildSubmission(assessmentPayload, studentName, band, opts = {}) {
  const { status = "EVALUATED", verification = null, complaint = null } = opts;
  const questionScores = assessmentPayload.questions.map((q, idx) => {
    const base = band.questionScores && band.questionScores[idx];
    const score = base ? base.score : Math.round(band.score * (0.8 + 0.2 * ((idx % 3) / 2)));
    const answer = base ? base.answer : band.answer;
    const qs = {
      question: q.prompt,
      focus: q.focus,
      answer,
      audio: null,
      duration: 40 + idx * 5,
      score,
      matched: base && base.strengths ? [] : [],
      strengths: base ? (base.strengths || []) : (band.strengths || []),
      gaps: base ? (base.gaps || []) : (band.gaps || []),
    };
    if (complaint && complaint.index === idx) {
      qs.complaint = {
        reason: complaint.reason,
        status: "pending",
        submittedAt: isoDaysAgo(1),
      };
    }
    return qs;
  });

  const finalScore = band.score;

  const criteria = assessmentPayload.rubric
    .split(/\n|·/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, idx) => {
      const m = line.match(/^([^:]+):\s*(\d+)%/);
      return {
        criterionId: `demo_criterion_${idx + 1}_${Math.round(Number(m ? m[2] : 20) * 4) / 5}`,
        criterion: m ? m[1].trim() : line,
        score: Math.round(finalScore * (0.7 + (0.3 * ((idx % 2) + 1)) / 2)),
        weight: m ? Number(m[2]) / 100 : 0.25,
      };
    });

  return {
    id: uid("sub"),
    assessmentId: assessmentPayload.id,
    assessmentTitle: assessmentPayload.topic,
    classId: assessmentPayload.classId,
    studentName,
    submittedAt: isoDaysAgo(Math.max(1, (20 - band.ageDays) % 20 || 2)),
    finalScore,
    questionScores,
    feedback: band.feedback
      || (finalScore >= 85
        ? "Pemahaman sangat baik. Pertahankan dan kembangkan menjadi argumen yang lebih kritis."
        : finalScore >= 70
          ? "Pemahaman sudah solid. Perkuat dengan contoh yang lebih spesifik."
          : "Dasar pemahaman mulai terlihat. Fokus pada istilah kunci dan alasan sebab-akibat."),
    status,
    verification,
    criteria,
    evaluationRunId: opts.evaluationRunId || null,
    evaluationId: opts.evaluationId || null,
    evaluationSource: "ai",
    insight:
      "Konsep inti dikuasai, namun perlu penguatan pada hubungan sebab-akibat dan penggunaan istilah kunci secara konsisten.",
  };
}

/**
 * Persist an evaluation run (harness trace) with criteria, versions, events,
 * a human-approval record, and an optional human score — so the Riset menu
 * (metrics, runs, trace, rubric compliance) has data to present.
 */
async function seedEvaluationRun(db, opts) {
  const {
    tenantId,
    userId,
    assessmentId,
    submission,
    runId,
  } = opts;
  const model = opts.model || "meta-llama/llama-3.1-70b-instruct";
  const harnessVersion = opts.harnessVersion || "1.0.0";
  const promptVersion = opts.promptVersion || "v1";
  const rubricVersion = opts.rubricVersion || "v1";
  const engineVersion = "1.0.0";
  const now = new Date().toISOString();

  const result = {
    evaluationId: uid("eval"),
    assessmentId,
    submissionId: submission.id,
    finalScore: submission.finalScore,
    versioning: {
      modelVersion: model,
      promptVersion,
      rubricVersion,
      harnessVersion,
      engineVersion,
    },
    verification: opts.verification || { valid: true, status: "PASS", issues: [] },
    weighted: {
      detail: submission.criteria.map((c) => ({
        criterionId: c.criterionId,
        label: c.criterion,
        weight: c.weight,
        score: c.score,
        contribution: Math.round(c.score * c.weight * 10) / 10,
      })),
      finalScore: submission.finalScore,
    },
    criteria: submission.criteria.map((c) => ({
      criterionId: c.criterionId,
      score: c.score,
      // Vary confidence by how far the score is from 50 — a real (if simplistic)
      // proxy for model certainty so the calibration dataset has signal.
      confidence: 0.5 + Math.min(0.5, Math.abs(Number(c.score || 50) - 50) / 100),
      rationale: "Skor ditetapkan berdasarkan bukti dari jawaban siswa.",
      evidence: [],
    })),
    risk: opts.risk || null,
    reliability: {
      overallReliability: 0.88,
      dimensions: {
        evidenceGrounding: 0.9,
        criterionCoverage: 0.92,
        rubricAlignment: 0.85,
        scoreConsistency: 0.88,
        outputValidity: 1,
      },
    },
    requiresHumanReview: opts.requiresHumanReview === true ? true : false,
    published: submission.status === "EVALUATED",
  };

  // Direct inserts (mirrors the tables written by persistTrace).
  const contextHash = crypto.createHash("sha256")
    .update(`${tenantId}:${rubricVersion}:${promptVersion}:${assessmentId}`)
    .digest("hex");
  const risk = result.risk || null;
  await db.run(
    `INSERT INTO evaluation_runs
       (run_id, tenant_id, user_id, assessment_id, submission_id, model,
        prompt_version, rubric_version, harness_version, engine_version,
        final_score, verification_valid, verification_status, verification_issues,
        input_hash, rubric_hash, prompt_hash, config_hash, published, requires_human_review,
        context_hash, context_version, risk_score, risk_level, policy_applied, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO NOTHING`,
    runId,
    tenantId,
    userId || null,
    assessmentId,
    submission.id,
    model,
    promptVersion,
    rubricVersion,
    harnessVersion,
    engineVersion,
    submission.finalScore,
    1,
    "PASS",
    JSON.stringify([]),
    crypto.createHash("sha256").update(submission.id).digest("hex").slice(0, 16),
    crypto.createHash("sha256").update(rubricVersion).digest("hex").slice(0, 16),
    crypto.createHash("sha256").update(promptVersion).digest("hex").slice(0, 16),
    crypto.createHash("sha256").update("default").digest("hex").slice(0, 16),
    submission.status === "EVALUATED" ? 1 : 0,
    opts.requiresHumanReview === true ? 1 : 0,
    contextHash,
    `ctx-v1-${contextHash.slice(0, 8)}`,
    risk ? risk.score : null,
    risk ? risk.level : null,
    risk && risk.policy ? JSON.stringify(risk.policy) : null,
    now
  );
  await recordSeed(db, tenantId, "evaluation_runs", runId);
  await recordSeed(db, tenantId, "submissions", submission.id);

  // Persist the stable context durably so the context cache hit-rate survives
  // restarts (P1-1). Same shape the runtime harness persists.
  await db.run(
    `INSERT INTO evaluation_contexts (tenant_id, context_hash, context_version, artifact_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, context_hash) DO UPDATE SET artifact_json = excluded.artifact_json`,
    tenantId,
    contextHash,
    `ctx-v1-${contextHash.slice(0, 8)}`,
    JSON.stringify({ contextHash, contextVersion: `ctx-v1-${contextHash.slice(0, 8)}`, systemPrompt: "demo", rubric: submission.rubric || null }),
    now,
    now
  );
  await recordSeed(db, tenantId, "evaluation_contexts", `${tenantId}:${contextHash}`);

  // Events.
  let seq = 0;
  for (const ev of opts.events || [
    { type: "harness.verify", data: { status: "pass" }, ts: now },
    { type: "harness.synthesize", data: { promptVersion, rubricVersion }, ts: now },
    { type: "harness.evaluate", data: { model }, ts: now },
  ]) {
    seq += 1;
    await db.run(
      "INSERT INTO evaluation_events (run_id, seq, type, data, ts) VALUES (?, ?, ?, ?, ?)",
      runId,
      seq,
      ev.type,
      JSON.stringify(ev.data || {}),
      ev.ts || now
    );
  }

  // Result + versions.
  await db.run(
    `INSERT INTO evaluation_results (run_id, evaluation_id, criteria_json, result_json, weighted_json)
     VALUES (?, ?, ?, ?, ?)`,
    runId,
    result.evaluationId,
    JSON.stringify(result.criteria),
    JSON.stringify(result),
    JSON.stringify(result.weighted)
  );
  await db.run(
    `INSERT INTO evaluation_versions (run_id, model_version, prompt_version, rubric_version, harness_version, engine_version)
     VALUES (?, ?, ?, ?, ?, ?)`,
    runId,
    model,
    promptVersion,
    rubricVersion,
    harnessVersion,
    engineVersion
  );
  for (const c of result.criteria) {
    const weight = result.weighted.detail.find((d) => d.criterionId === c.criterionId)?.weight ?? 0;
    await db.run(
      `INSERT INTO evaluation_criteria (run_id, criterion_id, score, weight, rationale, confidence, evidence_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      runId,
      c.criterionId,
      c.score,
      weight,
      c.rationale || null,
      c.confidence ?? null,
      JSON.stringify(c.evidence || [])
    );
  }

  // Human approval record.
  if (opts.approval) {
    const approval = opts.approval;
    await db.run(
      `INSERT INTO human_approvals
         (run_id, tenant_id, final_score, approval_status, approved_by, approved_at, deadline_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO NOTHING`,
      runId,
      tenantId,
      submission.finalScore,
      approval.status,
      approval.approvedBy || null,
      approval.approvedAt || (approval.status !== "pending" ? now : null),
      approval.deadlineAt || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      now
    );
  }

  // Human score (for AI-vs-human research metrics).
  if (opts.humanScore !== undefined) {
    await db.run(
      `INSERT INTO evaluation_human_scores
         (run_id, human_score, human_feedback, reviewed_at, reviewer_id)
       VALUES (?, ?, ?, ?, ?)`,
      runId,
      opts.humanScore,
      opts.humanFeedback || null,
      now,
      opts.humanReviewerId || null
    );
  }
}

/**
 * Seed observability telemetry (ai_logs) for the admin dashboard.
 */
async function seedAiLogs(db, tenantId, teacherId, studentId) {
  const countRow = await db.get(
    "SELECT COUNT(*) AS c FROM ai_logs WHERE tenant_id = ?",
    tenantId
  );
  if ((countRow?.c || 0) > 0) {
    // Record existing logs so rollback removes exactly them (idempotent).
    const rows = await db.all("SELECT id FROM ai_logs WHERE tenant_id = ?", tenantId);
    for (const row of rows) await recordSeed(db, tenantId, "ai_logs", row.id);
    return;
  }

  const models = [
    "meta-llama/llama-3.1-8b-instruct",
    "google/gemini-2.5-pro",
    "meta-llama/llama-3.1-70b-instruct",
  ];
  const actions = [
    { action: "recommend_assessment_config", tokens: [320, 150], lat: 850, model: 0, daysAgo: 0.2 },
    { action: "generate_questions_with_ai", tokens: [850, 620], lat: 2450, model: 1, daysAgo: 0.4 },
    { action: "improve_questions_with_ai", tokens: [1470, 580], lat: 1850, model: 1, daysAgo: 1 },
    { action: "evaluate_assessment_with_ai", tokens: [2100, 450], lat: 3100, model: 2, daysAgo: 2 },
    { action: "evaluate_assessment_with_ai", tokens: [2100, 480], lat: 2900, model: 2, daysAgo: 3 },
    { action: "generate_questions_with_ai", tokens: [0, 0], lat: 520, model: 1, daysAgo: 0.1, error: "OpenRouter API error: Rate limit reached", retry: 2, cost: 0 },
    { action: "generate_questions_with_ai", tokens: [760, 540], lat: 1980, model: 1, daysAgo: 5 },
    { action: "evaluate_assessment_with_ai", tokens: [1900, 420], lat: 2750, model: 2, daysAgo: 6 },
  ];

  for (let i = 0; i < actions.length; i += 1) {
    const a = actions[i];
    const model = models[a.model];
    const promptTokens = a.tokens[0];
    const completionTokens = a.tokens[1];
    const cacheRead = promptTokens > 0 ? Math.round(promptTokens * 0.65) : 0;
    const cacheCreation = promptTokens > 0 ? Math.round(promptTokens * 0.35) : 0;
    const estSavings = a.error ? 0 : promptTokens > 0 ? Math.round(promptTokens * 0.3) : 0;
    const costUsd = !a.error ? pricing.estimateCostUsd(promptTokens, completionTokens, model) : 0;
    const status = a.error ? "error" : "success";
    const userId = a.action.startsWith("evaluate") ? (studentId || tenantId) : teacherId;
    const logId = uid("log");

    await db.run(
      `INSERT INTO ai_logs
         (id, tenant_id, user_id, action, model, prompt_tokens, completion_tokens,
          total_tokens, latency_ms, status, error_message,
          estimated_prefix_cache_savings, cache_read_input_tokens,
          cache_creation_input_tokens, retry_count, cost_usd, kv_cache_measured, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      logId,
      tenantId,
      userId,
      a.action,
      model,
      promptTokens,
      completionTokens,
      promptTokens + completionTokens,
      a.lat,
      status,
      a.error || null,
      estSavings,
      cacheRead,
      cacheCreation,
      a.retry || 0,
      costUsd,
      promptTokens > 0 ? 1 : 0,
      isoDaysAgo(a.daysAgo)
    );
    await recordSeed(db, tenantId, "ai_logs", logId);
  }
}

/**
 * Seed a few API keys so the API Keys menu has rows.
 */
async function seedApiKeys(db, tenantId, teacherId) {
  const countRow = await db.get(
    "SELECT COUNT(*) AS c FROM api_keys WHERE tenant_id = ?",
    tenantId
  );
  if ((countRow?.c || 0) > 0) {
    // Record the existing demo keys so rollback removes exactly them.
    const rows = await db.all("SELECT id FROM api_keys WHERE tenant_id = ?", tenantId);
    for (const row of rows) await recordSeed(db, tenantId, "api_keys", row.id);
    return;
  }

  const now = new Date().toISOString();
  const keys = [
    { name: "Sistem LMS Eksternal", used: isoDaysAgo(2) },
    { name: "Mobile App Siswa", used: isoDaysAgo(10) },
  ];
  for (const k of keys) {
    const rawKey = `lsk_${crypto.randomBytes(24).toString("base64url")}`;
    const keyId = uid("apikey");
    await db.run(
      `INSERT INTO api_keys (id, tenant_id, name, key_hash, prefix, created_by, created_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      keyId,
      tenantId,
      k.name,
      hashKey(rawKey),
      rawKey.slice(0, 12),
      teacherId || null,
      now,
      k.used,
      null
    );
    await recordSeed(db, tenantId, "api_keys", keyId);
  }
}

/**
 * Main entry: seed demo data scoped to a role target.
 * target: "teacher" | "admin"
 * auth:   { tenant: { id }, user: { id, role } }
 */
async function seedDemoData(auth, target) {
  const db = getDb();
  const tenantId = auth.tenant.id;
  await ensureDemoSeedTable(db);

  // Resolve the demo teacher: for a teacher acting, they are the curator;
  // for an admin acting we create/ensure a dedicated demo teacher.
  let teacherId;
  let teacherName;
  if (auth.user.role === "teacher") {
    teacherId = auth.user.id;
    teacherName = auth.user.name || "Guru Demo";
  } else {
    const teacherEmail = `guru.${tenantSlug(tenantId)}.demo@lisan.ai`;
    const t = await db.get(
      "SELECT * FROM users WHERE tenant_id = ? AND email = ?",
      tenantId,
      teacherEmail
    );
    if (t) {
      teacherId = t.id;
      teacherName = t.name;
      await recordSeed(db, tenantId, "users", teacherId);
    } else {
      const created = await createTenantUser(tenantId, {
        name: "Guru Demo",
        email: teacherEmail,
        password: "password123",
        role: "teacher",
      });
      teacherId = created.id;
      teacherName = created.name;
      await recordSeed(db, tenantId, "users", teacherId);
    }
  }

  const classroom = await ensureClass(db, tenantId, teacherId);
  const students = await ensureStudents(db, tenantId, classroom.id, 6);
  const assessments = await ensureAssessments(db, tenantId, teacherId, classroom.id, students);

  // Build submissions. For each assessment, assign the first students a band
  // (higher performers) and everyone a score. Ensure enough EVALUATED rows for
  // the dashboard aggregates, and add one pending complaint for the Komplain menu.
  const assessmentPayloads = assessments.map((a) => {
    const row = typeof a.payloadJson === "string" ? a : a;
    return JSON.parse(row.payload || row.payloadJson || JSON.stringify(row));
  });

  const existingSubCount = await db.get(
    "SELECT COUNT(*) AS c FROM submissions WHERE tenant_id = ?",
    tenantId
  );
  const alreadySeeded = (existingSubCount?.c || 0) > 0;

  let complaintAdded = false;
  const createdRuns = [];
  if (!alreadySeeded) {
    for (let ai = 0; ai < assessmentPayloads.length; ai += 1) {
      const assessment = assessmentPayloads[ai];
      const template = ASSESSMENT_TEMPLATES[ai % ASSESSMENT_TEMPLATES.length];

      for (let si = 0; si < students.length; si += 1) {
        const student = students[si];
        const band = template.scoreBands[si % template.scoreBands.length];
        const status = "EVALUATED";

        // One pending complaint on an early assessment's submission so the
        // Komplain menu (teacher) has content.
        let complaint = null;
        if (!complaintAdded && ai === 0 && si === 1) {
          complaint = {
            index: 0,
            reason: "Saya merasa skor untuk soal pertama terlalu rendah dari jawaban yang saya berikan.",
          };
          complaintAdded = true;
        }

        const runId = uid("run");
        const submission = buildSubmission(assessment, student.studentName, {
          score: band.score,
          answer: band.answer,
          questionScores: assessment.questions.map((q, qi) => {
            const subBand = template.scoreBands[(si + qi) % template.scoreBands.length];
            return {
              score: Math.max(1, Math.min(100, subBand.score + (qi % 2 === 0 ? 2 : -2))),
              answer: subBand.answer,
              strengths: subBand.strengths || [],
              gaps: subBand.gaps || [],
            };
          }),
          feedback: band.feedback,
        }, {
          status,
          verification: { valid: true, status: "PASS", issues: [] },
          complaint,
          evaluationRunId: runId,
          evaluationId: uid("eval"),
        });

        await saveSubmissionDirect(db, tenantId, student.studentId, submission);

        // Seed an evaluation run so the Riset menu + dashboards have traces.
        await seedEvaluationRun(db, {
          tenantId,
          userId: student.studentId || teacherId,
          assessmentId: assessment.id,
          submission,
          runId,
          approval: {
            status: "pending",
          },
        });

        createdRuns.push({ runId, submission, studentName: student.studentName });
      }
    }
  }

  // Add human scores on ~2/3 of runs so AI-vs-human metrics and confidence
  // calibration (ECE/Brier) become computable. Confidence is stored per
  // criterion; the calibration aggregate averages it. We make the human score
  // agree with AI more often when confidence is high (a realistic but simple
  // relationship) so the reliability diagram is informative.
  if (!alreadySeeded && createdRuns.length) {
    const n = createdRuns.length;
    for (let i = 0; i < n; i += 1) {
      if (i % 3 === 2) continue; // skip ~1/3 to leave some without human review
      const { runId, submission } = createdRuns[i];
      const aiScore = Number(submission.finalScore);
      const confidence = 0.5 + Math.min(0.5, Math.abs(aiScore - 50) / 100);
      // Higher confidence → human more likely to agree (within 5 pts).
      const agree = Math.random() < confidence;
      const humanScore = agree
        ? Math.max(1, Math.min(100, aiScore + (Math.random() < 0.5 ? -1 : 1)))
        : Math.max(1, Math.min(100, aiScore + (Math.random() < 0.5 ? -12 : 12)));
      await db.run(
        `INSERT INTO evaluation_human_scores
           (run_id, human_score, human_feedback, reviewed_at, reviewer_id)
         VALUES (?, ?, ?, ?, ?)`,
        runId,
        humanScore,
        agree
          ? "Skor AI mendekati penilaian manusia; perbedaan kecil pada aspek penalaran."
          : "Penilai manusia memberi deviasi yang lebih besar pada komponen kejelasan.",
        new Date().toISOString(),
        teacherId
      );
    }

    // A pending + auto-approved approval state for varied badges in Riset.
    if (createdRuns.length >= 2) {
      await db.run(
        `UPDATE human_approvals SET approval_status = 'approved', approved_at = ? WHERE run_id = ?`,
        isoDaysAgo(1),
        createdRuns[1].runId
      );
    }
    if (createdRuns.length >= 3) {
      await db.run(
        `UPDATE human_approvals SET approval_status = 'auto_approved', approved_at = ? WHERE run_id = ?`,
        isoDaysAgo(2),
        createdRuns[2].runId
      );
    }
  }

  // Admin-only extras: observability telemetry + API keys.
  let seededObservability = false;
  let seededApiKeys = false;
  if (auth.user.role === "admin" || target === "admin") {
    await seedAiLogs(db, tenantId, teacherId, students[0]?.studentId);
    await seedApiKeys(db, tenantId, teacherId);
    seededObservability = true;
    seededApiKeys = true;
  }

  return {
    target,
    classId: classroom.id,
    studentsAdded: students.length,
    assessmentsAdded: assessments.length,
    teacherId,
    teacherName,
    alreadySeeded,
    submissionsSeeded: alreadySeeded ? 0 : (assessmentPayloads.length * students.length),
    runsCreated: createdRuns.length,
    seededObservability,
    seededApiKeys,
  };
}

async function saveSubmissionDirect(db, tenantId, userId, submission) {
  try {
    await db.run(
      `INSERT INTO submissions (id, tenant_id, assessment_id, student_name, user_id, final_score, payload, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      submission.id,
      tenantId,
      submission.assessmentId,
      submission.studentName,
      userId,
      submission.finalScore,
      JSON.stringify(submission),
      submission.submittedAt
    );
  } catch (err) {
    if (err && /FOREIGN KEY|assessment_id/i.test(String(err.message || ""))) {
      await db.run(
        `INSERT INTO submissions (id, tenant_id, assessment_id, student_name, user_id, final_score, payload, submitted_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
        submission.id,
        tenantId,
        submission.studentName,
        userId,
        submission.finalScore,
        JSON.stringify(submission),
        submission.submittedAt
      );
    } else {
      throw err;
    }
  }
}

module.exports = { seedDemoData, removeDemoData };

/**
 * Rollback ONLY the demo data for a tenant, leaving original/organic data
 * intact. Uses the demo_seeds ledger to target exactly the rows created by
 * seedDemoData, then clears the ledger so the demo can be re-seeded later.
 */
async function removeDemoData(tenantId) {
  const db = getDb();
  await ensureDemoSeedTable(db);

  const seeds = await db.all(
    "SELECT table_name, row_id FROM demo_seeds WHERE tenant_id = ?",
    tenantId
  );

  // Collect ids grouped by table. Order matters for FK dependencies: delete
  // dependent rows first, and rely on ON DELETE CASCADE for the rest.
  const ids = {};
  const collect = (table, rowId) => {
    if (rowId == null) return;
    (ids[table] = ids[table] || []).push(rowId);
  };

  if (!seeds.length) {
    // No ledger from the new seeder. Fall back to detecting demo-named rows
    // (created by an earlier seeder version or scripts/seed-accounts.js) so
    // they can still be rolled back. Kept conservative: only rows clearly
    // belonging to the demo dataset are removed.
    const demoTopicSlugs = ASSESSMENT_TEMPLATES.map((t) => t.topic);
    const demoClass = await db.get(
      "SELECT id FROM classes WHERE tenant_id = ? AND name = 'Kelas Demo X-A'",
      tenantId
    );
    const demoTeacher = await db.get(
      "SELECT id FROM users WHERE tenant_id = ? AND email = ?",
      tenantId,
      `guru.${tenantSlug(tenantId)}.demo@lisan.ai`
    );

    if (demoClass) collect("classes", demoClass.id);
    if (demoTeacher) collect("users", demoTeacher.id);

    // Demo students: users whose email contains the tenant demo tag.
    const demoUsers = await db.all(
      "SELECT id FROM users WHERE tenant_id = ? AND email LIKE ?",
      tenantId,
      `%.${tenantSlug(tenantId)}.demo@lisan.ai`
    );
    for (const u of demoUsers) collect("users", u.id);

    // Demo assessments by topic.
    const demoAssess = await db.all(
      `SELECT id FROM assessments WHERE tenant_id = ? AND topic IN (${demoTopicSlugs.map(() => "?").join(",")})`,
      tenantId,
      ...demoTopicSlugs
    );
    for (const a of demoAssess) collect("assessments", a.id);
    // Demo submissions/classes under the demo class.
    if (demoClass) {
      const demoSubs = await db.all(
        "SELECT id FROM submissions WHERE tenant_id = ? AND assessment_id IN (SELECT id FROM assessments WHERE class_id = ?)",
        tenantId,
        demoClass.id
      );
      for (const s of demoSubs) collect("submissions", s.id);
      const demoMems = await db.all(
        "SELECT id FROM class_memberships WHERE tenant_id = ? AND class_id = ?",
        tenantId,
        demoClass.id
      );
      for (const m of demoMems) collect("class_memberships", m.id);
    }

    // Demo evaluation runs are hard to attribute without a ledger; only the
    // demo class's submissions map to runs via their payload. Reconstruct from
    // submissions that carry an evaluationRunId.
    const subPayloads = await db.all(
      "SELECT id, payload FROM submissions WHERE tenant_id = ? AND assessment_id IN (SELECT id FROM assessments WHERE class_id = ?)",
      tenantId,
      demoClass ? demoClass.id : null
    );
    for (const sp of subPayloads) {
      try {
        const p = JSON.parse(sp.payload || "{}");
        if (p.evaluationRunId) collect("evaluation_runs", p.evaluationRunId);
      } catch { /* skip */ }
    }

    // Demo ai_logs / api_keys only via the ledger (they have no reliable
    // marker); if the ledger is empty they are skipped.
  }

  for (const s of seeds) collect(s.table_name, s.row_id);

  // 1. Delete evaluation-dependent rows (they cascade from runs, but delete
  //    runs explicitly to be safe and fast).
  for (const runId of ids.evaluation_runs || []) {
    // evaluation_results/events/criteria/versions + human_scores + approvals
    // all cascade via ON DELETE CASCADE on run_id; delete the run to trigger it.
    await db.run("DELETE FROM evaluation_runs WHERE run_id = ? AND tenant_id = ?", runId, tenantId);
  }

  // 2. Submissions (deleting an assessment cascades submissions when FK is
  //    referenced, but delete explicit rows to be precise).
  for (const subId of ids.submissions || []) {
    await db.run("DELETE FROM submissions WHERE id = ? AND tenant_id = ?", subId, tenantId);
  }

  // 3. Assessments (own rows; submissions already removed).
  for (const assessId of ids.assessments || []) {
    await db.run("DELETE FROM assessments WHERE id = ? AND tenant_id = ?", assessId, tenantId);
  }

  // 4. Class memberships, then classes, then the demo users.
  for (const memId of ids.class_memberships || []) {
    await db.run("DELETE FROM class_memberships WHERE id = ? AND tenant_id = ?", memId, tenantId);
  }
  for (const classId of ids.classes || []) {
    await db.run("DELETE FROM classes WHERE id = ? AND tenant_id = ?", classId, tenantId);
  }
  for (const userId of ids.users || []) {
    await db.run("DELETE FROM users WHERE id = ? AND tenant_id = ?", userId, tenantId);
  }

  // 5. Observability logs + API keys.
  for (const logId of ids.ai_logs || []) {
    await db.run("DELETE FROM ai_logs WHERE id = ? AND tenant_id = ?", logId, tenantId);
  }
  for (const keyId of ids.api_keys || []) {
    await db.run("DELETE FROM api_keys WHERE id = ? AND tenant_id = ?", keyId, tenantId);
  }

  // 6. Clear the ledger for this tenant.
  await db.run("DELETE FROM demo_seeds WHERE tenant_id = ?", tenantId);

  const removed = seeds.length;
  return { removed, hadDemoData: true };
}