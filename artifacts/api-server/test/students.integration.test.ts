import { strict as assert } from "node:assert";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test, { after, before } from "node:test";
import express from "express";
import { eq } from "drizzle-orm";
import {
  classesTable,
  db,
  pool,
  projectsTable,
  studentsTable,
  studioMembersTable,
  studiosTable,
} from "@workspace/db";
import importRouter from "../src/routes/import";
import studentsRouter from "../src/routes/students";

process.env.CLERK_SECRET_KEY = "";

const suffix = `${process.pid}-${Date.now()}`;
const userId = `students-api-${suffix}`;
let server: Server;
let baseUrl: string;
let projectId: number;
let classId: number;
let importedClassId: number;

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
    }),
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json() as Record<string, unknown>;
  assert.equal(created.email, "guardian@example.com");
  assert.equal(created.secondaryEmail, "secondary@example.com");
  assert.equal(created.jobTitle, "Engineer");
  assert.equal(created.officeLocation, "HQ");
  assert.equal(created.photoSession, "Morning");
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
    }),
  });
  assert.equal(patchResponse.status, 200);
  const updated = await patchResponse.json() as Record<string, unknown>;
  assert.equal(updated.secondaryEmail, "updated@example.com");
  assert.equal(updated.jobTitle, null);
  assert.equal(updated.officeLocation, "Remote");
  assert.equal(updated.photoSession, null);
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
        phoneColumn: "Phone",
        headers: ["First", "Last", "Guardian", "Alternate", "Title", "Office", "Session", "Phone"],
        rows: [["  Grace ", "Hopper", " grace@example.com ", " alt@example.com ", " Admiral ", " Room 1 ", " Evening ", " 555 " ]],
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