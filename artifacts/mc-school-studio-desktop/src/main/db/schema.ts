import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'

export const projectsTable = sqliteTable('projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  schoolName: text('school_name').notNull(),
  photoDate: text('photo_date'),
  address: text('address'),
  contactName: text('contact_name'),
  contactEmail: text('contact_email'),
  contactPhone: text('contact_phone'),
  notes: text('notes'),
  watchFolder: text('watch_folder'),
  createdAt: text('created_at').notNull().default(new Date().toISOString()),
  updatedAt: text('updated_at').notNull().default(new Date().toISOString()),
})

export const classesTable = sqliteTable('classes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id')
    .notNull()
    .references(() => projectsTable.id, { onDelete: 'cascade' }),
  className: text('class_name').notNull(),
  createdAt: text('created_at').notNull().default(new Date().toISOString()),
  updatedAt: text('updated_at').notNull().default(new Date().toISOString()),
})

export const studentsTable = sqliteTable('students', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id')
    .notNull()
    .references(() => projectsTable.id, { onDelete: 'cascade' }),
  classId: integer('class_id')
    .notNull()
    .references(() => classesTable.id, { onDelete: 'cascade' }),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  generatedStudentId: text('generated_student_id').notNull(),
  email: text('email'),
  phone: text('phone'),
  simpleQr: text('simple_qr'),
  jsonQr: text('json_qr'),
  createdAt: text('created_at').notNull().default(new Date().toISOString()),
  updatedAt: text('updated_at').notNull().default(new Date().toISOString()),
})

export const photosTable = sqliteTable('photos', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id')
    .notNull()
    .references(() => projectsTable.id, { onDelete: 'cascade' }),
  studentId: integer('student_id')
    .references(() => studentsTable.id, { onDelete: 'set null' }),
  filePath: text('file_path').notNull(),
  fileName: text('file_name').notNull(),
  capturedAt: text('captured_at').notNull(),
  isMatched: integer('is_matched', { mode: 'boolean' }).notNull().default(false),
  // null = not queued, 'pending' = queued, 'uploading' = in progress, 'done' = success, 'error' = failed
  uploadStatus: text('upload_status').$type<'pending' | 'uploading' | 'done' | 'error' | null>(),
  // URL returned by the cloud API after a successful upload
  fileUrl: text('file_url'),
  createdAt: text('created_at').notNull().default(new Date().toISOString()),
})

export const settingsTable = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})
