/**
 * Generates a unique 7-character student ID (uppercase letters + numbers).
 * Example: MB972CX
 */
export function generateStudentId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < 7; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Generates a unique student ID that doesn't exist in the given set.
 */
export function generateUniqueStudentId(existingIds: Set<string>): string {
  let id = generateStudentId();
  let attempts = 0;
  const normalized = new Set([...existingIds].map((value) => value.normalize("NFKC").trim().toLocaleLowerCase()));
  while (normalized.has(id.toLocaleLowerCase()) && attempts < 1000) {
    id = generateStudentId();
    attempts++;
  }
  if (normalized.has(id.toLocaleLowerCase())) {
    throw new Error("Could not generate a unique student ID");
  }
  return id;
}

/** Stable comparison key shared by API validation and the database index. */
export function studentIdKey(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

/** PostgreSQL's safe, non-PII collision signal for the roster identity index. */
export function isStudentIdUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (
      candidate.code === "23505"
      && candidate.constraint === "students_project_generated_student_id_ci"
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}
