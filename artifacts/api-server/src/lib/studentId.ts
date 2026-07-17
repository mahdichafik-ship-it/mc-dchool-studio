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
  while (existingIds.has(id) && attempts < 1000) {
    id = generateStudentId();
    attempts++;
  }
  return id;
}
