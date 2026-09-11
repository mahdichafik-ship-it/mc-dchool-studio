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
    ['projects', 'finished_at', 'TEXT'],
    ['projects', 'project_type', "TEXT NOT NULL DEFAULT 'school'"],
  ] as const) {
    ensureColumn(sqlite, ...migration)
  }
  sqlite.exec("UPDATE projects SET project_type = 'school' WHERE project_type IS NULL OR project_type NOT IN ('school', 'corporate')")
}

/**
 * Add the capture/file model alongside the legacy photos table.
 *
 * Existing photo rows are intentionally retained. The INSERT OR IGNORE
 * statements give each of them a stable compatibility capture and JPEG file
 * record without moving bytes or changing the current gallery/upload paths.
 */
export function ensureCaptureTables(sqlite: SqliteSchemaDatabase): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cloud_id INTEGER,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      is_default_class_group INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(group_id, student_id)
    );
    CREATE TABLE IF NOT EXISTS group_captures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      capture_key TEXT NOT NULL UNIQUE,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      base_filename TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      pairing_status TEXT NOT NULL DEFAULT 'pending',
      rating INTEGER NOT NULL DEFAULT 0,
      review_sync_pending INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS group_capture_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      capture_id INTEGER NOT NULL REFERENCES group_captures(id) ON DELETE CASCADE,
      file_role TEXT NOT NULL,
      file_format TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      source_path TEXT,
      file_size INTEGER,
      upload_status TEXT,
      file_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(capture_id, file_role)
    );
    CREATE TABLE IF NOT EXISTS captures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      capture_key TEXT NOT NULL UNIQUE,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
      class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
      group_id TEXT,
      base_filename TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      sequence INTEGER,
      favorite INTEGER NOT NULL DEFAULT 0,
      rejected INTEGER NOT NULL DEFAULT 0,
      selected INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      shoot_session_id TEXT,
      camera_serial TEXT,
      assignment_locked INTEGER NOT NULL DEFAULT 0,
      pairing_status TEXT NOT NULL DEFAULT 'pending',
      legacy_photo_id INTEGER REFERENCES photos(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS image_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      capture_id INTEGER NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
      file_role TEXT NOT NULL,
      file_format TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      source_path TEXT,
      file_size INTEGER,
      checksum TEXT,
      import_time TEXT NOT NULL,
      upload_status TEXT,
      file_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(capture_id, file_role)
    );

    CREATE TABLE IF NOT EXISTS qr_markers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      source_path TEXT NOT NULL UNIQUE,
      captured_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_captures_project ON captures(project_id);
    CREATE INDEX IF NOT EXISTS idx_captures_student ON captures(student_id);
    CREATE INDEX IF NOT EXISTS idx_captures_pairing ON captures(project_id, base_filename, pairing_status);
    CREATE INDEX IF NOT EXISTS idx_image_files_capture ON image_files(capture_id);
    CREATE INDEX IF NOT EXISTS idx_image_files_checksum ON image_files(checksum);
    CREATE INDEX IF NOT EXISTS idx_image_files_source ON image_files(source_path);
    CREATE INDEX IF NOT EXISTS idx_qr_markers_student ON qr_markers(student_id, captured_at);
    CREATE INDEX IF NOT EXISTS idx_qr_markers_project ON qr_markers(project_id);
    CREATE INDEX IF NOT EXISTS idx_groups_project ON groups(project_id);
    CREATE INDEX IF NOT EXISTS idx_groups_class ON groups(class_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_group_members_unique ON group_members(group_id, student_id);
    CREATE INDEX IF NOT EXISTS idx_group_members_student ON group_members(student_id);
    CREATE INDEX IF NOT EXISTS idx_group_captures_group ON group_captures(group_id);
    CREATE INDEX IF NOT EXISTS idx_group_captures_project ON group_captures(project_id);
    CREATE INDEX IF NOT EXISTS idx_group_capture_files_capture ON group_capture_files(capture_id);
  `)
  // This column was added after groups shipped; run it after CREATE TABLE so
  // fresh databases and existing installations follow the same path.
  ensureColumn(sqlite, 'groups', 'membership_dirty', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(sqlite, 'captures', 'rating', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(sqlite, 'captures', 'color_label', "TEXT NOT NULL DEFAULT 'none'")
  ensureColumn(sqlite, 'captures', 'review_sync_pending', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(sqlite, 'group_capture_files', 'gallery_ready', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(sqlite, 'group_captures', 'rating', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(sqlite, 'group_captures', 'review_sync_pending', 'INTEGER NOT NULL DEFAULT 0')

  sqlite.exec(`
    INSERT OR IGNORE INTO captures (
      capture_key, project_id, student_id, class_id, base_filename, captured_at,
      assignment_locked, pairing_status, legacy_photo_id, created_at, updated_at
    )
    SELECT
      'legacy-photo:' || p.id,
      p.project_id,
      p.student_id,
      (SELECT s.class_id FROM students s WHERE s.id = p.student_id),
      CASE
        WHEN instr(p.file_name, '.') > 0
        THEN substr(p.file_name, 1, instr(p.file_name, '.') - 1)
        ELSE p.file_name
      END,
      p.captured_at,
      1,
      CASE
        WHEN p.is_matched = 1 THEN 'jpeg_only'
        ELSE 'unpaired'
      END,
      p.id,
      p.created_at,
      p.created_at
    FROM photos p;

    INSERT OR IGNORE INTO image_files (
      capture_id, file_role, file_format, original_filename, stored_path,
      source_path, import_time, upload_status, file_url, created_at
    )
    SELECT
      c.id,
      'JPEG',
      CASE
        WHEN lower(p.file_name) LIKE '%.jpeg' THEN 'JPEG'
        ELSE 'JPG'
      END,
      p.file_name,
      p.file_path,
      p.file_path,
      p.created_at,
      p.upload_status,
      p.file_url,
      p.created_at
    FROM photos p
    JOIN captures c ON c.legacy_photo_id = p.id
    WHERE NOT EXISTS (
      SELECT 1 FROM image_files f
      WHERE f.capture_id = c.id AND f.file_role = 'JPEG'
    );
  `)
}