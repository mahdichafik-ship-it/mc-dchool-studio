import { strict as assert } from "node:assert";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import express from "express";
import test, { after, before } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  captureFilesTable,
  capturesTable,
  classesTable,
  db,
  desktopConnectionsTable,
  groupCaptureFilesTable,
  groupCapturesTable,
  groupMembersTable,
  groupsTable,
  pool,
  projectAssignmentsTable,
  projectsTable,
  studentPhotosTable,
  studentsTable,
  studioMembersTable,
  studiosTable,
} from "@workspace/db";
import desktopRouter from "../src/routes/desktop";
import photosRouter from "../src/routes/photos";
import { createDesktopToken } from "../src/lib/desktopAuth";
import { clearGoogleDriveFolderCacheForTests, setPlatformDriveRequesterForTests, type DriveRequester } from "../src/lib/googleDriveBackup";

const userId = `class-roster-follow-up-${process.pid}-${Date.now()}`;
const desktopCredentials = createDesktopToken();
const jpegBytes = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AX//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AX//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z",
  "base64",
);

let server: Server;
let baseUrl: string;
let studioId: number;
let memberId: number;
let projectId: number;
let firstClassId: number;
let secondClassId: number;
let studentId: number;
let captureId: number;
let captureFileId: number;
let groupId: number;
let groupCaptureId: number;
let groupCaptureFileId: number;
let mockDriveId = 1;

const mockDriveRequester: DriveRequester = async (requestPath, options = {}) => {
  const method = options.method ?? "GET";
  if (requestPath.startsWith("/drive/v3/about?") && method === "GET") {
    return Response.json({ user: { permissionId: "class-roster-follow-up" } });
  }
  if (requestPath.startsWith("/drive/v3/files?") && method === "GET") {
    return Response.json({ files: [] });
  }
  if (requestPath.startsWith("/drive/v3/files?") && method === "POST") {
    const metadata = JSON.parse(String(options.body));
    return Response.json({ id: `follow-up-folder-${mockDriveId++}`, name: metadata.name });
  }
  if (requestPath.startsWith("/upload/drive/v3/files?") && method === "POST") {
    return new Response(null, {
      headers: { location: `https://class-roster-follow-up.invalid/${mockDriveId++}` },
    });
  }
  if (requestPath.startsWith("https://class-roster-follow-up.invalid/") && method === "PUT") {
    return Response.json({ id: `follow-up-file-${mockDriveId++}` });
  }
  return Response.json({ error: "Unexpected mocked Drive request" }, { status: 500 });
};

const app = express();
app.use(express.json());
const authHandler = Object.assign(
  () => ({
    tokenType: "session_token",
    userId,
    sessionClaims: { userId },
  }),
  { [Symbol.for("@clerk/express.auth")]: true },
);
app.use((req, _res, next) => {
  (req as any).auth = authHandler;
  next();
});
app.use("/api/desktop", desktopRouter);
app.use("/api/projects/:projectId/students", photosRouter);

function desktopHeaders() {
  return {
    Authorization: `Bearer ${desktopCredentials.token}`,
    "Content-Type": "application/json",
  };
}

async function createClass(className: string) {
  return fetch(`${baseUrl}/api/desktop/projects/${projectId}/classes`, {
    method: "POST",
    headers: desktopHeaders(),
    body: JSON.stringify({ className }),
  });
}

before(async () => {
  clearGoogleDriveFolderCacheForTests();
  setPlatformDriveRequesterForTests(mockDriveRequester);
  const [studio] = await db.insert(studiosTable).values({
    name: "Class roster follow-up studio",
    createdByUserId: userId,
  }).returning({ id: studiosTable.id });
  studioId = studio.id;

  const [member] = await db.insert(studioMembersTable).values({
    studioId,
    userId,
    email: `${userId}@member.local`,
    role: "photographer",
  }).returning({ id: studioMembersTable.id });
  memberId = member.id;

  const [project] = await db.insert(projectsTable).values({
    userId,
    studioId,
    schoolName: "Class roster follow-up school",
  }).returning({ id: projectsTable.id });
  projectId = project.id;
  await db.insert(projectAssignmentsTable).values({ projectId, memberId });
  await db.insert(desktopConnectionsTable).values({
    studioId,
    memberId,
    deviceName: "Follow-up desktop",
    tokenHash: desktopCredentials.tokenHash,
    tokenPrefix: desktopCredentials.tokenPrefix,
  });

  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  setPlatformDriveRequesterForTests();
  clearGoogleDriveFolderCacheForTests();
  if (server) {
    server.close();
    await once(server, "close");
  }
  if (studioId) {
    await db.delete(studiosTable).where(eq(studiosTable.id, studioId));
  }
  await pool.end();
});

test("online class creation is retry-safe and creates one default group", async () => {
  const first = await createClass("  Grade 4B  ");
  assert.equal(first.status, 201);
  const firstBody = await first.json() as { id: number; className: string };
  firstClassId = firstBody.id;
  assert.equal(firstBody.className, "Grade 4B");

  const replay = await createClass("grade 4b");
  assert.equal(replay.status, 200);
  const replayBody = await replay.json() as { id: number; className: string };
  assert.equal(replayBody.id, firstClassId);

  const classes = await db.select().from(classesTable).where(eq(classesTable.projectId, projectId));
  const defaultGroups = await db.select().from(groupsTable).where(and(
    eq(groupsTable.projectId, projectId),
    eq(groupsTable.classId, firstClassId),
    eq(groupsTable.isDefaultClassGroup, true),
  ));
  assert.equal(classes.length, 1, "reconnecting an offline-created class must not duplicate the cloud class");
  assert.equal(defaultGroups.length, 1, "the class must have exactly one default group");
});

test("new student can be photographed, reviewed, uploaded, and moved without losing records", async () => {
  const second = await createClass("Grade 4C");
  assert.equal(second.status, 201);
  secondClassId = (await second.json() as { id: number }).id;

  const addStudent = await fetch(`${baseUrl}/api/desktop/projects/${projectId}/students`, {
    method: "POST",
    headers: desktopHeaders(),
    body: JSON.stringify({
      classId: firstClassId,
      firstName: "New",
      lastName: "Person",
      generatedStudentId: "NEW1234",
    }),
  });
  assert.equal(addStudent.status, 201);
  studentId = (await addStudent.json() as { id: number }).id;

  const batchKey = `class-roster-batch-${Date.now()}`;
  const startBatch = await fetch(`${baseUrl}/api/desktop/projects/${projectId}/capture-batches`, {
    method: "POST",
    headers: desktopHeaders(),
    body: JSON.stringify({ batchKey, expectedFileCount: 1 }),
  });
  assert.equal(startBatch.status, 201);

  const form = new FormData();
  form.append("file", new Blob([jpegBytes], { type: "image/jpeg" }), "new-person.jpg");
  form.append("captureKey", `new-person-capture-${Date.now()}`);
  form.append("fileRole", "JPEG");
  form.append("rating", "5");
  form.append("colorLabel", "none");
  const upload = await fetch(`${baseUrl}/api/projects/${projectId}/students/${studentId}/captures`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${desktopCredentials.token}`,
      "X-MC-Upload-Id": `new-person-upload-${Date.now()}`,
      "X-MC-Capture-Batch": batchKey,
    },
    body: form,
  });
  assert.equal(upload.status, 201);
  const uploaded = await upload.json() as { captureId: number; file: { id: number } };
  captureId = uploaded.captureId;
  captureFileId = uploaded.file.id;

  const [capturedPortrait] = await db.select().from(studentPhotosTable).where(and(
    eq(studentPhotosTable.projectId, projectId),
    eq(studentPhotosTable.studentId, studentId),
    eq(studentPhotosTable.fileName, "new-person.jpg"),
  ));
  assert.equal(capturedPortrait?.rating, 5);
  assert.equal(capturedPortrait?.shareWithParents, true);

  await db.update(capturesTable).set({
    rating: 5,
    favorite: true,
    rejected: false,
    selected: true,
  }).where(eq(capturesTable.id, captureId));
  await db.update(captureFilesTable).set({
    fileUrl: "/uploads/follow-up/new-person.jpg",
  }).where(eq(captureFilesTable.id, captureFileId));
  const [legacyPhoto] = await db.insert(studentPhotosTable).values({
    projectId,
    studentId,
    fileName: "legacy-review.jpg",
    fileUrl: "/uploads/follow-up/legacy-review.jpg",
    mimeType: "image/jpeg",
    rating: 4,
    shareWithParents: true,
  }).returning({ id: studentPhotosTable.id });

  const [group] = await db.insert(groupsTable).values({
    projectId,
    classId: firstClassId,
    name: "Historical class picture",
    isDefaultClassGroup: false,
  }).returning({ id: groupsTable.id });
  groupId = group.id;
  await db.insert(groupMembersTable).values({ groupId, studentId });
  const [groupCapture] = await db.insert(groupCapturesTable).values({
    projectId,
    groupId,
    captureKey: `historical-group-${Date.now()}`,
    baseFilename: "historical-group",
    pairingStatus: "jpeg_only",
    reviewStatus: "approved",
    rating: 5,
  }).returning({ id: groupCapturesTable.id });
  groupCaptureId = groupCapture.id;
  const [groupFile] = await db.insert(groupCaptureFilesTable).values({
    captureId: groupCaptureId,
    fileRole: "JPEG",
    fileFormat: "jpg",
    originalFilename: "historical-group.jpg",
    fileUrl: "/uploads/follow-up/historical-group.jpg",
    mimeType: "image/jpeg",
  }).returning({ id: groupCaptureFilesTable.id });
  groupCaptureFileId = groupFile.id;

  const move = await fetch(`${baseUrl}/api/desktop/projects/${projectId}/students/${studentId}`, {
    method: "PATCH",
    headers: desktopHeaders(),
    body: JSON.stringify({ classId: secondClassId }),
  });
  assert.equal(move.status, 200);
  const moved = await move.json() as { classId: number; className: string };
  assert.equal(moved.classId, secondClassId);
  assert.equal(moved.className, "Grade 4C");

  const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, studentId));
  const [capture] = await db.select().from(capturesTable).where(eq(capturesTable.id, captureId));
  const [captureFile] = await db.select().from(captureFilesTable).where(eq(captureFilesTable.id, captureFileId));
  const [photo] = await db.select().from(studentPhotosTable).where(eq(studentPhotosTable.id, legacyPhoto.id));
  const [membership] = await db.select().from(groupMembersTable).where(and(
    eq(groupMembersTable.groupId, groupId),
    eq(groupMembersTable.studentId, studentId),
  ));
  const [historicalCapture] = await db.select().from(groupCapturesTable).where(eq(groupCapturesTable.id, groupCaptureId));
  const [historicalFile] = await db.select().from(groupCaptureFilesTable).where(eq(groupCaptureFilesTable.id, groupCaptureFileId));

  assert.equal(student.classId, secondClassId);
  assert.equal(capture?.rating, 5);
  assert.equal(capture?.favorite, true);
  assert.equal(capture?.selected, true);
  assert.equal(captureFile?.fileUrl, "/uploads/follow-up/new-person.jpg");
  assert.equal(photo?.rating, 4);
  assert.equal(photo?.shareWithParents, true);
  assert(membership, "historical group membership must survive a class move");
  assert.equal(historicalCapture?.reviewStatus, "approved");
  assert.equal(historicalFile?.fileUrl, "/uploads/follow-up/historical-group.jpg");
});