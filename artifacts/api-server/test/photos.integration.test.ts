import { strict as assert } from "node:assert";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { readFile, rm } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import express from "express";
import { and, eq } from "drizzle-orm";
import {
  classesTable,
  db,
  pool,
  projectsTable,
  studentPhotosTable,
  studentsTable,
} from "@workspace/db";
import photosRouter from "../src/routes/photos";

const uploadKey = "integration-photo-upload-key";
const userId = `photo-flow-test-${process.pid}-${Date.now()}`;
const jpegBytes = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AX//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AX//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z",
  "base64",
);

type PhotoResponse = {
  id: number;
  projectId: number;
  studentId: number;
  fileName: string;
  fileUrl: string;
  mimeType: string;
  capturedAt: string | null;
  createdAt: string;
};

let server: Server;
let baseUrl: string;
let projectId: number;
let studentId: number;
let classId: number;
let uploadedPhotoId: number | undefined;
let uploadedFilePath: string | undefined;

const app = express();
const authHandler = Object.assign(
  () => ({
    tokenType: "session_token",
    userId,
    sessionClaims: { userId },
  }),
  { [Symbol.for("@clerk/express.auth")]: true },
);

// The real requireAuth middleware is used by the router. This supplies the
// same request contract as clerkMiddleware without needing a live Clerk token.
app.use((req, _res, next) => {
  (req as any).auth = authHandler;
  next();
});
app.use("/api/projects/:projectId/students", photosRouter);

before(async () => {
  process.env.PHOTO_UPLOAD_KEY = uploadKey;

  const [project] = await db
    .insert(projectsTable)
    .values({
      userId,
      schoolName: "Photo flow integration school",
    })
    .returning({ id: projectsTable.id });
  projectId = project.id;

  const [studentClass] = await db
    .insert(classesTable)
    .values({
      projectId,
      className: "Integration class",
    })
    .returning({ id: classesTable.id });
  classId = studentClass.id;

  const [student] = await db
    .insert(studentsTable)
    .values({
      projectId,
      classId,
      firstName: "Integration",
      lastName: "Student",
      generatedStudentId: `INT${String(process.pid).slice(-4)}${Date.now()
        .toString()
        .slice(-4)}`,
    })
    .returning({ id: studentsTable.id });
  studentId = student.id;

  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (uploadedFilePath) {
    await rm(uploadedFilePath, { force: true });
  }
  if (projectId) {
    await db.delete(projectsTable).where(eq(projectsTable.id, projectId));
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await pool.end();
});

test("preserves a photo through upload, delivery, and deletion", async () => {
  const form = new (globalThis as any).FormData();
  form.append(
    "photo",
    new (globalThis as any).Blob([jpegBytes], { type: "image/jpeg" }),
    "integration-portrait.jpg",
  );
  form.append("capturedAt", "2026-08-22T12:34:56.000Z");

  const uploadResponse = await fetch(
    `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${uploadKey}` },
      body: form,
    },
  );
  assert.equal(uploadResponse.status, 201);
  const uploaded = (await uploadResponse.json()) as PhotoResponse;
  uploadedPhotoId = uploaded.id;

  assert.equal(uploaded.projectId, projectId);
  assert.equal(uploaded.studentId, studentId);
  assert.equal(uploaded.fileName, "integration-portrait.jpg");
  assert.equal(uploaded.mimeType, "image/jpeg");
  assert.equal(uploaded.capturedAt, "2026-08-22T12:34:56.000Z");

  const [storedPhoto] = await db
    .select()
    .from(studentPhotosTable)
    .where(eq(studentPhotosTable.id, uploaded.id));
  assert(storedPhoto, "upload should create a student_photos row");
  assert.equal(storedPhoto.fileUrl, uploaded.fileUrl);

  uploadedFilePath = path.resolve(process.cwd(), uploaded.fileUrl.replace(/^\//, ""));
  assert(fs.existsSync(uploadedFilePath), "upload should create the photo on disk");
  assert.deepEqual(await readFile(uploadedFilePath), jpegBytes);

  const listResponse = await fetch(
    `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos`,
  );
  assert.equal(listResponse.status, 200);
  const listedPhotos = (await listResponse.json()) as PhotoResponse[];
  assert.equal(listedPhotos.length, 1);
  assert.deepEqual(listedPhotos[0], uploaded);
  const listedFilePath = path.resolve(
    process.cwd(),
    listedPhotos[0].fileUrl.replace(/^\//, ""),
  );
  assert(fs.existsSync(listedFilePath), "GET fileUrl should resolve on disk");

  const fileResponse = await fetch(
    `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos/${uploaded.id}/file`,
  );
  assert.equal(fileResponse.status, 200);
  assert.equal(fileResponse.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(
    Buffer.from(await fileResponse.arrayBuffer()),
    jpegBytes,
    "GET file endpoint should deliver the uploaded JPEG",
  );

  const deleteResponse = await fetch(
    `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos/${uploaded.id}`,
    { method: "DELETE" },
  );
  assert.equal(deleteResponse.status, 204);
  assert(!fs.existsSync(uploadedFilePath), "DELETE should remove the photo file");

  const [deletedPhoto] = await db
    .select({ id: studentPhotosTable.id })
    .from(studentPhotosTable)
    .where(
      and(
        eq(studentPhotosTable.id, uploaded.id),
        eq(studentPhotosTable.projectId, projectId),
      ),
    );
  assert.equal(deletedPhoto, undefined, "DELETE should remove the database row");
  uploadedPhotoId = undefined;
  uploadedFilePath = undefined;
});