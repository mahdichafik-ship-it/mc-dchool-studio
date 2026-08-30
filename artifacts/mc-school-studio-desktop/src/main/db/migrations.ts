export interface SqliteSchemaDatabase {
  pragma(source: string): unknown
  exec(source: string): void
}

export function ensureColumn(
  sqlite: SqliteSchemaDatabase,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = sqlite.pragma(`table_info(${table})`) as Array<{ name?: unknown }>
  if (columns.some((item) => item.name === column)) return
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

export function ensureLegacyColumns(sqlite: SqliteSchemaDatabase): void {
  for (const migration of [
    ['photos', 'upload_status', 'TEXT'],
    ['photos', 'file_url', 'TEXT'],
    ['projects', 'cloud_id', 'INTEGER'],
    ['classes', 'cloud_id', 'INTEGER'],
    ['students', 'cloud_id', 'INTEGER'],
    ['students', 'email', 'TEXT'],
    ['students', 'phone', 'TEXT'],
  ] as const) {
    ensureColumn(sqlite, ...migration)
  }
}