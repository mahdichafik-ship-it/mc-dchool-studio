import { strict as assert } from "node:assert";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test, { after, before } from "node:test";
import express from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  classesTable,
  db,
  desktopConnectionsTable,
  projectAssignmentsTable,
  pool,
  projectsTable,
  studentsTable,
  studioMembersTable,
  studiosTable,
} from "@workspace/db";
import importRouter from "../src/routes/import";
import studentsRouter from "../src/routes/students";
import desktopRouter from "../src/routes/desktop";
import { createDesktopToken } from "../src/lib/desktopAuth";

process.env.CLERK_SECRET_KEY = "";

const suffix = `${process.pid}-${Date.now()}`;
const userId = `students-api-${suffix}`;
let server: Server;
let baseUrl: string;
let projectId: number;
let classId: number;
let importedClassId: number;
let foreignClassId: number;
let foreignProjectId: number;
const desktopCredentials = createDesktopToken();

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const requestUserId = req.header("x-test-user") ?? userId;
  const authHandler = Object.assign(
    () => ({
      tokenType: "session_token",
      userId: requestUserId,
      sessionClaims: { userId: requestUserId },
    }),
    { [Symbol.for("@clerk/express.auth")]: true },
  );
  (req as any).auth = authHandler;
  next();
});
app.use("/api/projects/:projectId/students", studentsRouter);
app.use("/api/projects/:projectId/import", importRouter);
app.use("/api/desktop", desktopRouter);

async function request(pathname: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-test-user", userId);
  return fetch(`${baseUrl}${pathname}`, { ...init, headers });
}

before(async () => {
  const [studio] = await db
    .insert(studiosTable)
    .values({ name: `Students API studio ${suffix}`, createdByUserId: userId })
    .returning({ id: studiosTable.id });
  await db.insert(studioMembersTable).values({
    studioId: studio.id,
    userId,
    email: `${userId}@member.local`,
    role: "owner",
  });
  const [project] = await db
    .insert(projectsTable)
    .values({
      userId,
      studioId: studio.id,
      schoolName: `Students API project ${suffix}`,
    })
    .returning({ id: projectsTable.id });
  projectId = project.id;
  const [cls] = await db
    .insert(classesTable)
    .values({ projectId, className: `Class ${suffix}` })
    .returning({ id: classesTable.id });
  classId = cls.id;
  await db.insert(projectAssignmentsTable).values({
    projectId,
    memberId: (await db
      .select({ id: studioMembersTable.id })
      .from(studioMembersTable)
      .where(eq(studioMembersTable.userId, userId)))[0].id,
  });
  const memberId = (await db
    .select({ id: studioMembersTable.id })
    .from(studioMembersTable)
    .where(eq(studioMembersTable.userId, userId)))[0].id;
  await db.insert(desktopConnectionsTable).values({
    studioId: studio.id,
    memberId,
    deviceName: "Identity test desktop",
    tokenHash: desktopCredentials.tokenHash,
    tokenPrefix: desktopCredentials.tokenPrefix,
  });
  const [foreignProject] = await db
    .insert(projectsTable)
    .values({
      userId,
      studioId: studio.id,
      schoolName: `Foreign students project ${suffix}`,
    })
    .returning({ id: projectsTable.id });
  const [foreignClass] = await db
    .insert(classesTable)
    .values({ projectId: foreignProject.id, className: `Foreign class ${suffix}` })
    .returning({ id: classesTable.id });
  foreignProjectId = foreignProject.id;
  foreignClassId = foreignClass.id;

  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await db.delete(studiosTable).where(eq(studiosTable.createdByUserId, userId));
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await pool.end();
});

test("creates, lists, and updates contact/profile fields without changing QR data", async () => {
  const createResponse = await request(`/api/projects/${projectId}/students`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      classId,
      firstName: "  Ada ",
      lastName: "Lovelace",
      generatedStudentId: "  ADA-1 ",
      email: " guardian@example.com ",
      secondaryEmail: " secondary@example.com ",
      phone: " 555-0100 ",
      jobTitle: " Engineer ",
      officeLocation: " HQ ",
      photoSession: " Morning ",
      captureNotes: " Glasses off ",
    }),
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json() as Record<string, unknown>;
  assert.equal(created.email, "guardian@example.com");
  assert.equal(created.secondaryEmail, "secondary@example.com");
  assert.equal(created.jobTitle, "Engineer");
  assert.equal(created.officeLocation, "HQ");
  assert.equal(created.photoSession, "Morning");
  assert.equal(created.captureNotes, "Glasses off");
  const studentId = created.id as number;

  await db.update(studentsTable).set({ simpleQr: "simple-qr", jsonQr: "json-qr" }).where(eq(studentsTable.id, studentId));
  const patchResponse = await request(`/api/projects/${projectId}/students/${studentId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      classId,
      firstName: "Ada",
      lastName: "Lovelace",
      generatedStudentId: "ADA-1",
      email: "guardian@example.com",
      phone: "555-0100",
      secondaryEmail: " updated@example.com ",
      jobTitle: " ",
      officeLocation: " Remote ",
      photoSession: " ",
      captureNotes: " Face camera ",
    }),
  });
  assert.equal(patchResponse.status, 200);
  const updated = await patchResponse.json() as Record<string, unknown>;
  assert.equal(updated.secondaryEmail, "updated@example.com");
  assert.equal(updated.jobTitle, null);
  assert.equal(updated.officeLocation, "Remote");
  assert.equal(updated.photoSession, null);
  assert.equal(updated.captureNotes, "Face camera");
  assert.equal(updated.simpleQr, "simple-qr");
  assert.equal(updated.jsonQr, "json-qr");

  const invalidPatchResponse = await request(`/api/projects/${projectId}/students/${studentId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secondaryEmail: "not-an-email" }),
  });
  assert.equal(invalidPatchResponse.status, 400);

  const listResponse = await request(`/api/projects/${projectId}/students`);
  assert.equal(listResponse.status, 200);
  const listed = await listResponse.json() as Array<Record<string, unknown>>;
  assert.equal(listed.find((student) => student.id === studentId)?.secondaryEmail, "updated@example.com");
});

test("normalizes blank contact values and rejects invalid primary or secondary emails", async () => {
  const blankResponse = await request(`/api/projects/${projectId}/students`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ classId, firstName: "Blank", lastName: "Fields", email: " ", secondaryEmail: " " }),
  });
  assert.equal(blankResponse.status, 201);
  const blank = await blankResponse.json() as Record<string, unknown>;
  assert.equal(blank.email, null);
  assert.equal(blank.secondaryEmail, null);

  const invalidPrimary = await request(`/api/projects/${projectId}/students`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ classId, firstName: "Invalid", lastName: "Primary", email: "not-an-email" }),
  });
  assert.equal(invalidPrimary.status, 400);

  const invalidSecondary = await request(`/api/projects/${projectId}/students`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ classId, firstName: "Invalid", lastName: "Secondary", secondaryEmail: "not-an-email" }),
  });
  assert.equal(invalidSecondary.status, 400);
});

test("rejects moving a student into a class from another project", async () => {
  const createdResponse = await request(`/api/projects/${projectId}/students`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ classId, firstName: "Project", lastName: "Boundary" }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as { id: number; classId: number };

  const response = await request(`/api/projects/${projectId}/students/${created.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ classId: foreignClassId }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { error: string }).error, "Class not found in this project");

  const [persisted] = await db.select().from(studentsTable).where(eq(studentsTable.id, created.id));
  assert.equal(persisted.classId, classId);
  assert.equal(persisted.projectId, projectId);
});

test("maps import contact columns and leaves omitted legacy fields nullable", async () => {
  const response = await request(`/api/projects/${projectId}/import/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sheets: [{
        sheetName: "Roster",
        className: `Imported ${suffix}`,
        firstNameColumn: "First",
        lastNameColumn: "Last",
        emailColumn: "Guardian",
        secondaryEmailColumn: "Alternate",
        jobTitleColumn: "Title",
        officeLocationColumn: "Office",
        photoSessionColumn: "Session",
        captureNotesColumn: "Capture Notes",
        phoneColumn: "Phone",
        headers: ["First", "Last", "Guardian", "Alternate", "Title", "Office", "Session", "Capture Notes", "Phone"],
        rows: [["  Grace ", "Hopper", " grace@example.com ", " alt@example.com ", " Admiral ", " Room 1 ", " Evening ", " Chin up ", " 555 " ]],
      }],
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json() as { studentsCreated: number };
  assert.equal(result.studentsCreated, 1);

  const [importedClass] = await db
    .select({ id: classesTable.id })
    .from(classesTable)
    .where(eq(classesTable.className, `Imported ${suffix}`));
  importedClassId = importedClass.id;
  const [imported] = await db.select().from(studentsTable).where(eq(studentsTable.classId, importedClassId));
  assert.equal(imported.email, "grace@example.com");
  assert.equal(imported.secondaryEmail, "alt@example.com");
  assert.equal(imported.jobTitle, "Admiral");
  assert.equal(imported.officeLocation, "Room 1");
  assert.equal(imported.photoSession, "Evening");
  assert.equal(imported.captureNotes, "Chin up");

  const legacyResponse = await request(`/api/projects/${projectId}/students`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ classId, firstName: "Legacy", lastName: "Record" }),
  });
  assert.equal(legacyResponse.status, 201);
  const legacy = await legacyResponse.json() as Record<string, unknown>;
  assert.equal(legacy.secondaryEmail, null);
  assert.equal(legacy.jobTitle, null);
  assert.equal(legacy.officeLocation, null);
  assert.equal(legacy.photoSession, null);
  assert.equal(legacy.captureNotes, null);
});

test("rolls back an import when a later row has an invalid email", async () => {
  const className = `Atomic failure ${suffix}`;
  const response = await request(`/api/projects/${projectId}/import/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sheets: [{
        sheetName: "Atomic",
        className,
        firstNameColumn: "First",
        lastNameColumn: "Last",
        emailColumn: "Email",
        headers: ["First", "Last", "Email"],
        rows: [
          ["Earlier", "Valid", "earlier@example.com"],
          ["Later", "Invalid", "not-an-email"],
        ],
      }],
    }),
  });
  assert.equal(response.status, 400);

  const [createdClass] = await db
    .select({ id: classesTable.id })
    .from(classesTable)
    .where(eq(classesTable.className, className));
  assert.equal(createdClass, undefined);
  const importedStudents = await db
    .select({ firstName: studentsTable.firstName, lastName: studentsTable.lastName })
    .from(studentsTable)
    .where(eq(studentsTable.projectId, projectId));
  assert(!importedStudents.some((student) => student.firstName === "Earlier" || student.lastName === "Invalid"));
});

test("enforces case-insensitive project-scoped IDs for create, edit, and concurrent create", async () => {
  const generatedStudentId = `CASE-${suffix}`;
  const firstResponse = await request(`/api/projects/${projectId}/students`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ classId, firstName: "Identity", lastName: "Canonical", generatedStudentId }),
  });
  assert.equal(firstResponse.status, 201);

  const duplicateResponse = await request(`/api/projects/${projectId}/students`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ classId, firstName: "Identity", lastName: "Duplicate", generatedStudentId: generatedStudentId.toLowerCase() }),
  });
  assert.equal(duplicateResponse.status, 409);
  assert.equal((await duplicateResponse.json() as { code: string }).code, "STUDENT_ID_CONFLICT");

  const editableResponse = await request(`/api/projects/${projectId}/students`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ classId, firstName: "Identity", lastName: "Editable", generatedStudentId: `EDIT-${suffix}` }),
  });
  assert.equal(editableResponse.status, 201);
  const editable = await editableResponse.json() as { id: number };
  const editConflict = await request(`/api/projects/${projectId}/students/${editable.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ generatedStudentId: generatedStudentId.toLowerCase() }),
  });
  assert.equal(editConflict.status, 409);
  assert.equal((await editConflict.json() as { code: string }).code, "STUDENT_ID_CONFLICT");

  // PostgreSQL's unique index, not the preflight query, decides the winner.
  const concurrent = await Promise.all([
    request(`/api/projects/${projectId}/students`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ classId, firstName: "Concurrent", lastName: "One", generatedStudentId: `RACE-${suffix}` }),
    }),
    request(`/api/projects/${projectId}/students`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ classId, firstName: "Concurrent", lastName: "Two", generatedStudentId: `race-${suffix}` }),
    }),
  ]);
  assert.deepEqual(concurrent.map((response) => response.status).sort(), [201, 409]);
});

test("allows the same case-insensitive ID in a different project", async () => {
  const generatedStudentId = `CROSS-${suffix}`;
  const firstResponse = await request(`/api/projects/${projectId}/students`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ classId, firstName: "Cross", lastName: "School", generatedStudentId }),
  });
  assert.equal(firstResponse.status, 201);
  const secondResponse = await request(`/api/projects/${foreignProjectId}/students`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ classId: foreignClassId, firstName: "Cross", lastName: "Corporate", generatedStudentId: generatedStudentId.toLowerCase() }),
  });
  assert.equal(secondResponse.status, 201);
});

test("keeps one row when concurrent imports race on the same ID", async () => {
  const generatedStudentId = `IMPORT-${suffix}`;
  const body = (firstName: string) => ({
    sheets: [{
      sheetName: `Import race ${firstName}`,
      className: `Import race ${suffix}`,
      firstNameColumn: "First",
      lastNameColumn: "Last",
      studentIdColumn: "Roster ID",
      headers: ["First", "Last", "Roster ID"],
      rows: [[firstName, "Import", generatedStudentId]],
    }],
  });
  const [first, second] = await Promise.all([
    request(`/api/projects/${projectId}/import/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body("One")),
    }),
    request(`/api/projects/${projectId}/import/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body("Two")),
    }),
  ]);
  const statuses = [first.status, second.status].sort((left, right) => left - right);
  // If one transaction inserts before the other reads, the second import
  // legitimately reconciles the stable ID and returns 200. If both preflight
  // before either insert commits, the unique index rejects one with 409.
  assert.ok(
    statuses.join(",") === "200,200" || statuses.join(",") === "200,409",
    `unexpected concurrent import statuses: ${statuses.join(",")}`,
  );
  const conflict = [first, second].find((response) => response.status === 409);
  if (conflict) {
    assert.equal((await conflict.json() as { code: string }).code, "STUDENT_ID_CONFLICT");
  }
  const matchingStudents = await db
    .select({ id: studentsTable.id })
    .from(studentsTable)
    .where(and(
      eq(studentsTable.projectId, projectId),
      sql`lower(${studentsTable.generatedStudentId}) = lower(${generatedStudentId})`,
    ));
  assert.equal(matchingStudents.length, 1);
});

test("returns a safe conflict for a desktop late-student ID collision", async () => {
  const generatedStudentId = `DESKTOP-${suffix}`.slice(0, 7);
  const first = await request(`/api/projects/${projectId}/students`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ classId, firstName: "Desktop", lastName: "Existing", generatedStudentId }),
  });
  assert.equal(first.status, 201);
  const response = await fetch(`${baseUrl}/api/desktop/projects/${projectId}/students`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${desktopCredentials.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      classId,
      firstName: "Desktop",
      lastName: "Late",
      generatedStudentId: generatedStudentId.toLowerCase(),
    }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { code: string }).code, "STUDENT_ID_CONFLICT");

  const retryResponse = await fetch(`${baseUrl}/api/desktop/projects/${projectId}/students`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${desktopCredentials.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      classId,
      firstName: "Desktop",
      lastName: "Existing",
      generatedStudentId: generatedStudentId.toLowerCase(),
    }),
  });
  assert.equal(retryResponse.status, 200);
  // An exact late-student retry is idempotent, including case-only changes.
  const retry = await retryResponse.json() as { generatedStudentId: string };
  assert.equal(retry.generatedStudentId, generatedStudentId);
});