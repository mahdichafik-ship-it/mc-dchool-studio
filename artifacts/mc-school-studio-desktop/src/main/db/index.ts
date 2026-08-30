import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import * as schema from './schema'
import { ensureLegacyColumns } from './migrations'

let _db: ReturnType<typeof drizzle> | null = null

export function getDb() {
  if (_db) return _db

  const userDataPath = app.getPath('userData')
  mkdirSync(userDataPath, { recursive: true })

  const dbPath = join(userDataPath, 'mc-school-studio.db')
  const sqlite = new Database(dbPath)

  // Enable WAL mode for better performance
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  _db = drizzle(sqlite, { schema })

  // Create tables if they don't exist
  initializeSchema(sqlite)

  return _db
}

function initializeSchema(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cloud_id INTEGER,
      school_name TEXT NOT NULL,
      photo_date TEXT,
      address TEXT,
      contact_name TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      notes TEXT,
      watch_folder TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cloud_id INTEGER,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      class_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cloud_id INTEGER,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      generated_student_id TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      simple_qr TEXT,
      json_qr TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
      file_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      is_matched INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_students_project ON students(project_id);
    CREATE INDEX IF NOT EXISTS idx_students_generated_id ON students(generated_student_id);
    CREATE INDEX IF NOT EXISTS idx_photos_student ON photos(student_id);
    CREATE INDEX IF NOT EXISTS idx_photos_project ON photos(project_id);
  `)

  // Upgrade databases created by older desktop releases without replacing
  // projects, rosters, or captured photos.
  ensureLegacyColumns(sqlite)

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_projects_cloud_id ON projects(cloud_id);
    CREATE INDEX IF NOT EXISTS idx_classes_cloud_id ON classes(project_id, cloud_id);
    CREATE INDEX IF NOT EXISTS idx_students_cloud_id ON students(project_id, cloud_id);
  `)
}

export function getPhotosDir(): string {
  const homeDir = app.getPath('home')
  const configured = _db?.select().from(schema.settingsTable).where(eq(schema.settingsTable.key, 'storage_root')).get()?.value
  const dir = configured || join(homeDir, 'MC School Studio', 'photos')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function setPhotosDir(dir: string): void {
  const clean = dir.trim()
  if (!clean) return
  const db = getDb()
  const existing = db.select().from(schema.settingsTable).where(eq(schema.settingsTable.key, 'storage_root')).get()
  if (existing) db.update(schema.settingsTable).set({ value: clean }).where(eq(schema.settingsTable.key, 'storage_root')).run()
  else db.insert(schema.settingsTable).values({ key: 'storage_root', value: clean }).run()
  mkdirSync(clean, { recursive: true })
}
