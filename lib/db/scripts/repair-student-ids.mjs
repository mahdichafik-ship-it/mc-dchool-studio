import pg from "pg";
import { randomBytes } from "node:crypto";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const normalize = (value) => value.normalize("NFKC").trim().toLocaleLowerCase();
const newId = () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = randomBytes(16);
  let result = "";
  for (let i = 0; i < 7; i += 1) result += alphabet[bytes[i] % alphabet.length];
  return result;
};

/**
 * Development/pre-publish repair for the Release 9 project-scoped identity
 * index. The lowest database id is the canonical row; later duplicates are
 * assigned fresh IDs. No row or capture identity is changed.
 */
async function main() {
  const client = await pool.connect();
  let reassigned = 0;
  let duplicateGroups = 0;
  let affectedProjects = new Set();
  try {
    await client.query("BEGIN");
    const table = await client.query("SELECT to_regclass('public.students') AS name");
    if (!table.rows[0]?.name) {
      await client.query("COMMIT");
      console.info(JSON.stringify({
        event: "student_id_repair",
        status: "skipped",
        reason: "students_table_missing",
        duplicateGroups: 0,
        reassigned: 0,
        affectedProjects: 0,
      }));
      return;
    }
    // Block concurrent inserts/updates until duplicate repair and unique-index
    // installation commit together. Drizzle push then only verifies the schema.
    await client.query("LOCK TABLE students IN SHARE ROW EXCLUSIVE MODE");
    const { rows } = await client.query(
      `SELECT id, project_id, generated_student_id
       FROM students
       ORDER BY project_id ASC, id ASC
       FOR UPDATE`,
    );
    const usedByProject = new Map();
    const countedGroups = new Set();
    for (const row of rows) {
      const key = normalize(row.generated_student_id);
      const used = usedByProject.get(row.project_id) ?? new Set();
      if (!used.has(key)) {
        used.add(key);
        usedByProject.set(row.project_id, used);
        continue;
      }

      const groupKey = `${row.project_id}\u0000${key}`;
      if (!countedGroups.has(groupKey)) {
        countedGroups.add(groupKey);
        duplicateGroups += 1;
      }
      affectedProjects.add(row.project_id);
      let replacement;
      do replacement = newId(); while (used.has(normalize(replacement)));
      used.add(normalize(replacement));
      await client.query(
        "UPDATE students SET generated_student_id = $1, updated_at = NOW() WHERE id = $2",
        [replacement, row.id],
      );
      reassigned += 1;
    }
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS students_project_generated_student_id_ci
       ON students (project_id, lower(generated_student_id))`,
    );
    await client.query("COMMIT");
    console.info(JSON.stringify({
      event: "student_id_repair",
      status: "complete",
      duplicateGroups,
      reassigned,
      affectedProjects: affectedProjects.size,
    }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(JSON.stringify({
      event: "student_id_repair",
      status: "failed",
      error: error instanceof Error ? error.name : "unknown",
    }));
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();