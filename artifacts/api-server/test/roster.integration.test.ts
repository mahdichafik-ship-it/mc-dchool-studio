import { strict as assert } from "node:assert";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test, { after, before } from "node:test";
import express from "express";
import { and, eq } from "drizzle-orm";
import {
  classesTable,
  db,
  groupMembersTable,
  groupsTable,
  pool,
  projectsTable,
  studentPhotosTable,
  studentsTable,
  studioMembersTable,
  studiosTable,
} from "@workspace/db";
import importRouter from "../src/routes/import";

process.env.CLERK_SECRET_KEY = "";

const suffix = `${process.pid}-${Date.now()}`;
const ownerUserId = `roster-owner-${suffix}`;
const outsiderUserId = `roster-outsider-${suffix}`;
let server: Server;
let baseUrl: string;
let schoolProjectId: number;
let corporateProjectId: number;
let foreignProjectId: number;
let schoolClassId: number;
let destinationClassId: number;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const requestUserId = req.header("x-test-user") ?? ownerUserId;
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
app.use("/api/projects/:projectId/import", importRouter);

type ImportResult = {
  classesCreated: number;
  studentsCreated: number;
  studentsUpdated: number;
  studentsMoved: number;
  studentsSkipped: number;
  conflicts: number;
};

function sheet(
  className: string,
  rows: string[][],
  options: {
    id?: boolean;
    email?: boolean;
    secondaryEmail?: boolean;
    phone?: boolean;
    optional?: boolean;
  } = {},
) {
  const headers = ["First", "Last"];
  if (options.id) headers.push("Roster ID");
  if (options.email) headers.push("Primary Email");
  if (options.secondaryEmail) headers.push("Secondary Email");
  if (options.phone) headers.push("Phone");
  if (options.optional) headers.push("Title", "Office", "Session");
  return {
    sheetName: className,
    className,
    firstNameColumn: "First",
    lastNameColumn: "Last",
    studentIdColumn: options.id ? "Roster ID" : null,
    emailColumn: options.email ? "Primary Email" : null,
    secondaryEmailColumn: options.secondaryEmail ? "Secondary Email" : null,
    phoneColumn: options.phone ? "Phone" : null,
    jobTitleColumn: options.optional ? "Title" : null,
    officeLocationColumn: options.optional ? "Office" : null,
    photoSessionColumn: options.optional ? "Session" : null,
    headers,
    rows,
  };
}

async function request(projectId: number, body: unknown, userId = ownerUserId) {
  return fetch(`${baseUrl}/api/projects/${projectId}/import/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": userId },
    body: JSON.stringify(body),
  });
}

async function confirm(projectId: number, sheets: unknown[], userId = ownerUserId) {
  const response = await request(projectId, { sheets }, userId);
  const body = await response.json() as ImportResult & { error?: string };
  return { response, body };
}

async function oneStudent(projectId: number, firstName: string, lastName: string) {
  const [student] = await db.select().from(studentsTable)
    .where(and(eq(studentsTable.projectId, projectId), eq(studentsTable.firstName, firstName), eq(studentsTable.lastName, lastName)));
  return student;
}

before(async () => {
  const [studio] = await db.insert(studiosTable)
    .values({ name: `Roster test studio ${suffix}`, createdByUserId: ownerUserId })
    .returning({ id: studiosTable.id });
  await db.insert(studioMembersTable).values({
    studioId: studio.id,
    userId: ownerUserId,
    email: `${ownerUserId}@member.local`,
    role: "owner",
  });
  const projects = await db.insert(projectsTable).values([
    { userId: ownerUserId, studioId: studio.id, projectType: "school", schoolName: `Roster school ${suffix}` },
    { userId: ownerUserId, studioId: studio.id, projectType: "corporate", schoolName: `Roster corporate ${suffix}` },
    { userId: `foreign-${suffix}`, studioId: studio.id, projectType: "school", schoolName: `Roster foreign ${suffix}` },
  ]).returning({ id: projectsTable.id });
  schoolProjectId = projects[0].id;
  corporateProjectId = projects[1].id;
  foreignProjectId = projects[2].id;
  const classes = await db.insert(classesTable).values([
    { projectId: schoolProjectId, className: "  Grade 1 Élite " },
    { projectId: schoolProjectId, className: "Grade 2" },
  ]).returning({ id: classesTable.id });
  schoolClassId = classes[0].id;
  destinationClassId = classes[1].id;

  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await db.delete(studiosTable).where(eq(studiosTable.createdByUserId, ownerUserId));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await pool.end();
});

test("repeat roster is idempotent and preserves database, QR, photo, group, and cloud identity", async () => {
  const initial = await confirm(schoolProjectId, [
    sheet("Photo Class", [["Alice", "Roster", "AL-1", "alice@example.com"]], { id: true, email: true }),
  ]);
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.studentsCreated, 1);
  const created = await oneStudent(schoolProjectId, "Alice", "Roster");
  assert(created);

  const [group] = await db.insert(groupsTable).values({
    projectId: schoolProjectId,
    classId: created.classId,
    name: `Cloud group ${suffix}`,
    clientGroupId: `cloud-${suffix}`,
  }).returning({ id: groupsTable.id });
  await db.insert(groupMembersTable).values({ groupId: group.id, studentId: created.id });
  const [photo] = await db.insert(studentPhotosTable).values({
    projectId: schoolProjectId,
    studentId: created.id,
    fileName: "alice.jpg",
    fileUrl: "/photos/alice.jpg",
    durableObjectPath: `cloud/object/${suffix}`,
    clientUploadId: `upload-${suffix}`,
  }).returning({ id: studentPhotosTable.id });
  await db.update(studentsTable).set({ simpleQr: "qr-simple", jsonQr: "qr-json" })
    .where(eq(studentsTable.id, created.id));

  const repeated = await confirm(schoolProjectId, [
    sheet("Photo Class", [["Alice", "Roster", "AL-1", "alice@example.com"]], { id: true, email: true }),
  ]);
  assert.equal(repeated.response.status, 200);
  assert.deepEqual(
    {
      created: repeated.body.studentsCreated,
      updated: repeated.body.studentsUpdated,
      moved: repeated.body.studentsMoved,
      skipped: repeated.body.studentsSkipped,
    },
    { created: 0, updated: 0, moved: 0, skipped: 1 },
  );
  const persisted = await oneStudent(schoolProjectId, "Alice", "Roster");
  assert.equal(persisted.id, created.id);
  assert.equal(persisted.generatedStudentId, "AL-1");
  assert.equal(persisted.simpleQr, "qr-simple");
  assert.equal(persisted.jsonQr, "qr-json");
  assert.equal((await db.select().from(studentPhotosTable).where(eq(studentPhotosTable.id, photo.id))).length, 1);
  assert.equal((await db.select().from(groupMembersTable).where(and(eq(groupMembersTable.groupId, group.id), eq(groupMembersTable.studentId, created.id)))).length, 1);
  assert.equal((await db.select().from(groupsTable).where(eq(groupsTable.clientGroupId, `cloud-${suffix}`))).length, 1);
});

test("stable ID updates and moves a school row without replacing its identity", async () => {
  const initial = await confirm(schoolProjectId, [
    sheet("Move Class", [["Move", "Me", "MOVE-1", "move@example.com"]], { id: true, email: true }),
  ]);
  assert.equal(initial.body.studentsCreated, 1);
  const created = await oneStudent(schoolProjectId, "Move", "Me");
  assert(created);
  await db.update(studentsTable).set({ simpleQr: "move-qr" }).where(eq(studentsTable.id, created.id));

  const changed = await confirm(schoolProjectId, [
    sheet("Moved Department", [["Moved", "Person", " move-1 ", "new@example.com"]], { id: true, email: true }),
  ]);
  assert.equal(changed.response.status, 200);
  assert.equal(changed.body.studentsUpdated, 1);
  assert.equal(changed.body.studentsMoved, 1);
  const updated = await oneStudent(schoolProjectId, "Moved", "Person");
  assert(updated);
  assert.equal(updated.id, created.id);
  assert.equal(updated.generatedStudentId, "MOVE-1");
  assert.equal(updated.email, "new@example.com");
  assert.equal(updated.simpleQr, "move-qr");
  assert.notEqual(updated.classId, created.classId);
});

test("uses unique primary and secondary email fallbacks and does not merge ambiguous matches", async () => {
  await confirm(schoolProjectId, [
    sheet("Fallback Class", [["Primary", "Fallback", "primary@example.com"]], { email: true }),
    sheet("Fallback Class", [["Secondary", "Fallback", "secondary@example.com"]], { secondaryEmail: true }),
  ]);
  const primary = await oneStudent(schoolProjectId, "Primary", "Fallback");
  const secondary = await oneStudent(schoolProjectId, "Secondary", "Fallback");
  assert(primary && secondary);

  const primaryMatch = await confirm(schoolProjectId, [
    sheet("Fallback Class", [["Primary Renamed", "Fallback", "PRIMARY@example.com"]], { email: true }),
  ]);
  assert.equal(primaryMatch.body.studentsUpdated, 1);
  const secondaryMatch = await confirm(schoolProjectId, [
    sheet("Fallback Class", [["Secondary Renamed", "Fallback", "secondary@example.com"]], { secondaryEmail: true }),
  ]);
  assert.equal(secondaryMatch.body.studentsUpdated, 1);

  const [ambiguousOne, ambiguousTwo] = await db.insert(studentsTable).values([
    {
      projectId: schoolProjectId,
      classId: primary.classId,
      firstName: "Ambiguous",
      lastName: "One",
      generatedStudentId: `AMB-1-${suffix}`,
      email: "duplicate@example.com",
    },
    {
      projectId: schoolProjectId,
      classId: primary.classId,
      firstName: "Ambiguous",
      lastName: "Two",
      generatedStudentId: `AMB-2-${suffix}`,
      email: "duplicate@example.com",
    },
  ]).returning({ id: studentsTable.id });
  assert(ambiguousOne && ambiguousTwo);
  const ambiguous = await confirm(schoolProjectId, [
    sheet("Fallback Class", [["New", "Person", "duplicate@example.com"]], { email: true }),
  ]);
  assert.equal(ambiguous.body.conflicts, 1);
  assert.equal((await db.select().from(studentsTable).where(and(eq(studentsTable.projectId, schoolProjectId), eq(studentsTable.firstName, "New")))).length, 0);

  const [nameClass] = await db.insert(classesTable).values({
    projectId: schoolProjectId,
    className: "Name Ambiguity",
  }).returning({ id: classesTable.id });
  await db.insert(studentsTable).values([
    {
      projectId: schoolProjectId,
      classId: nameClass.id,
      firstName: "Same",
      lastName: "Name",
      generatedStudentId: `NAME-1-${suffix}`,
    },
    {
      projectId: schoolProjectId,
      classId: nameClass.id,
      firstName: "same",
      lastName: "NAME",
      generatedStudentId: `NAME-2-${suffix}`,
    },
  ]);
  const nameConflict = await confirm(schoolProjectId, [sheet("Name Ambiguity", [[" SAME ", " name "]] )]);
  assert.equal(nameConflict.body.conflicts, 1);
});

test("treats email ownership across both slots as ambiguous and preflights new duplicates", async () => {
  const [crossSlotClass] = await db.insert(classesTable).values({
    projectId: schoolProjectId,
    className: `Cross-slot ${suffix}`,
  }).returning({ id: classesTable.id });
  const [ownerA, ownerB] = await db.insert(studentsTable).values([
    {
      projectId: schoolProjectId,
      classId: crossSlotClass.id,
      firstName: "Slot",
      lastName: "Primary",
      generatedStudentId: `SLOT-A-${suffix}`,
      email: "shared-slot@example.com",
    },
    {
      projectId: schoolProjectId,
      classId: crossSlotClass.id,
      firstName: "Slot",
      lastName: "Secondary",
      generatedStudentId: `SLOT-B-${suffix}`,
      secondaryEmail: "shared-slot@example.com",
    },
  ]).returning({ id: studentsTable.id });
  assert(ownerA && ownerB);

  const incomingPrimary = await confirm(schoolProjectId, [
    sheet(`Cross-slot ${suffix}`, [["Primary", "Attempt", "SHARED-SLOT@EXAMPLE.COM"]], { email: true }),
  ]);
  const incomingSecondary = await confirm(schoolProjectId, [
    sheet(`Cross-slot ${suffix}`, [["Secondary", "Attempt", "shared-slot@example.com"]], { secondaryEmail: true }),
  ]);
  assert.equal(incomingPrimary.body.conflicts, 1);
  assert.equal(incomingSecondary.body.conflicts, 1);
  assert.equal((await db.select().from(studentsTable).where(eq(studentsTable.firstName, "Attempt"))).length, 0);

  const crossOwner = await confirm(schoolProjectId, [
    sheet(`Cross-slot ${suffix}`, [["Both", "Owners", "shared-slot@example.com", "other-owner@example.com"]], { email: true, secondaryEmail: true }),
  ]);
  assert.equal(crossOwner.body.conflicts, 1);
  assert.equal((await db.select().from(studentsTable).where(eq(studentsTable.firstName, "Owners"))).length, 0);

  const identicalRows = await confirm(schoolProjectId, [
    sheet(`New duplicate ${suffix}`, [
      ["New", "Duplicate", "new-identity@example.com"],
      ["New", "Duplicate", "new-identity@example.com"],
    ], { email: true }),
  ]);
  assert.equal(identicalRows.body.studentsCreated, 1);
  assert.equal(identicalRows.body.studentsSkipped, 1);

  const contradictoryRows = await confirm(schoolProjectId, [
    sheet(`Contradictory ${suffix}`, [
      ["Contradiction", "One", "contradictory@example.com"],
      ["Contradiction", "Two", "contradictory@example.com"],
    ], { email: true }),
  ]);
  assert.equal(contradictoryRows.body.conflicts, 2);
  assert.equal((await db.select().from(studentsTable).where(and(
    eq(studentsTable.projectId, schoolProjectId),
    eq(studentsTable.email, "contradictory@example.com"),
  ))).length, 0);
});

test("rejects duplicate stable IDs atomically and reuses normalized classes", async () => {
  const duplicateClass = `Duplicate ${suffix}`;
  const duplicate = await confirm(schoolProjectId, [
    sheet(duplicateClass, [
      ["First", "Duplicate", "DUP-1"],
      ["Second", "Duplicate", " dup-1 "],
    ], { id: true }),
  ]);
  assert.equal(duplicate.response.status, 400);
  assert.match(duplicate.body.error ?? "", /Duplicate Student ID\/Employee ID/);
  assert.equal((await db.select().from(classesTable).where(eq(classesTable.className, duplicateClass))).length, 0);
  assert.equal((await db.select().from(studentsTable).where(and(eq(studentsTable.projectId, schoolProjectId), eq(studentsTable.generatedStudentId, "DUP-1")))).length, 0);

  const normalized = await confirm(schoolProjectId, [
    sheet("grade 1 élite", [["NFC", "Class", "NFC-1"]], { id: true }),
  ]);
  assert.equal(normalized.response.status, 200);
  assert.equal(normalized.body.classesCreated, 0);
  const normalizedClass = await db.select().from(classesTable).where(eq(classesTable.id, schoolClassId));
  assert.equal(normalizedClass.length, 1);
  const imported = await oneStudent(schoolProjectId, "NFC", "Class");
  assert.equal(imported.classId, schoolClassId);
});

test("supports corporate rosters, blank legacy fields, authorization, and project isolation", async () => {
  const corporate = await confirm(corporateProjectId, [
    sheet("Engineering", [["Employee", "Blank", "EMP-1"]], { id: true }),
  ]);
  assert.equal(corporate.response.status, 200);
  const employee = await oneStudent(corporateProjectId, "Employee", "Blank");
  assert(employee);
  assert.equal(employee.email, null);
  assert.equal(employee.secondaryEmail, null);
  assert.equal(employee.jobTitle, null);
  assert.equal(employee.officeLocation, null);
  assert.equal(employee.photoSession, null);
  assert.equal(employee.captureNotes, null);

  const unauthorized = await confirm(corporateProjectId, [
    sheet("Engineering", [["No", "Access", "NO-1"]], { id: true }),
  ], outsiderUserId);
  assert.equal(unauthorized.response.status, 404);

  const school = await confirm(schoolProjectId, [
    sheet("Isolation", [["Shared", "ID", "SHARED-1"]], { id: true }),
  ]);
  const foreign = await confirm(foreignProjectId, [
    sheet("Isolation", [["Foreign", "ID", "SHARED-1"]], { id: true }),
  ]);
  assert.equal(school.body.studentsCreated, 1);
  assert.equal(foreign.body.studentsCreated, 1);
  assert.equal((await db.select().from(studentsTable).where(and(eq(studentsTable.projectId, schoolProjectId), eq(studentsTable.generatedStudentId, "SHARED-1")))).length, 1);
  assert.equal((await db.select().from(studentsTable).where(and(eq(studentsTable.projectId, foreignProjectId), eq(studentsTable.generatedStudentId, "SHARED-1")))).length, 1);
});