import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { readFile, readdir, rm } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import express from "express";
import { and, eq } from "drizzle-orm";
import {
  classesTable,
  db,
  desktopConnectionsTable,
  pool,
  projectAssignmentsTable,
  projectsTable,
  studentPhotosTable,
  studentsTable,
  studioMembersTable,
  studiosTable,
} from "@workspace/db";
import photosRouter, { recoverPhotoDeleteBackups } from "../src/routes/photos";
import desktopRouter from "../src/routes/desktop";
import { createDesktopToken } from "../src/lib/desktopAuth";

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
let studioId: number;
let memberId: number;
let otherMemberId: number;
let adminMemberId: number;
let hiddenProjectId: number;
let uploadedPhotoId: number | undefined;
let uploadedFilePath: string | undefined;
const desktopCredentials = createDesktopToken();
const otherDesktopCredentials = createDesktopToken();
const adminDesktopCredentials = createDesktopToken();

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
app.use("/api/desktop", desktopRouter);

before(async () => {
  const [studio] = await db
    .insert(studiosTable)
    .values({ name: "Photo flow integration studio", createdByUserId: userId })
    .returning({ id: studiosTable.id });
  studioId = studio.id;

  const [member] = await db
    .insert(studioMembersTable)
    .values({
      studioId,
      userId,
      email: `${userId}@member.local`,
      role: "photographer",
    })
    .returning({ id: studioMembersTable.id });
  memberId = member.id;

  const [otherMember] = await db
    .insert(studioMembersTable)
    .values({
      studioId,
      userId: `${userId}-other`,
      email: `${userId}-other@member.local`,
      role: "photographer",
    })
    .returning({ id: studioMembersTable.id });
  otherMemberId = otherMember.id;

  const [adminMember] = await db
    .insert(studioMembersTable)
    .values({
      studioId,
      userId: `${userId}-admin`,
      email: `${userId}-admin@member.local`,
      role: "admin",
    })
    .returning({ id: studioMembersTable.id });
  adminMemberId = adminMember.id;

  const [project] = await db
    .insert(projectsTable)
    .values({
      userId,
      studioId,
      schoolName: "Photo flow integration school",
    })
    .returning({ id: projectsTable.id });
  projectId = project.id;
  await db.insert(projectAssignmentsTable).values([
    { projectId, memberId },
    { projectId, memberId: otherMemberId },
  ]);

  const [hiddenProject] = await db
    .insert(projectsTable)
    .values({
      userId,
      studioId,
      schoolName: "Hidden integration project",
    })
    .returning({ id: projectsTable.id });
  hiddenProjectId = hiddenProject.id;

  await db.insert(desktopConnectionsTable).values([
    {
      studioId,
      memberId,
      deviceName: "Integration desktop",
      tokenHash: desktopCredentials.tokenHash,
      tokenPrefix: desktopCredentials.tokenPrefix,
    },
    {
      studioId,
      memberId: otherMemberId,
      deviceName: "Other integration desktop",
      tokenHash: otherDesktopCredentials.tokenHash,
      tokenPrefix: otherDesktopCredentials.tokenPrefix,
    },
    {
      studioId,
      memberId: adminMemberId,
      deviceName: "Admin integration desktop",
      tokenHash: adminDesktopCredentials.tokenHash,
      tokenPrefix: adminDesktopCredentials.tokenPrefix,
    },
  ]);

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
  if (studioId) {
    await db.delete(studiosTable).where(eq(studiosTable.id, studioId));
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
      headers: {
        Authorization: `Bearer ${desktopCredentials.token}`,
        "X-MC-Upload-Id": "1",
      },
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

  const retryForm = new (globalThis as any).FormData();
  retryForm.append(
    "photo",
    new (globalThis as any).Blob([jpegBytes], { type: "image/jpeg" }),
    "integration-portrait.jpg",
  );
  retryForm.append("capturedAt", "2026-08-22T12:34:56.000Z");
  const retryResponse = await fetch(
    `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${desktopCredentials.token}`,
        "X-MC-Upload-Id": "1",
      },
      body: retryForm,
    },
  );
  assert.equal(retryResponse.status, 200);
  const retried = (await retryResponse.json()) as PhotoResponse;
  assert.equal(retried.id, uploaded.id, "retry should return the original server photo");

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

test("preserves the uploaded photo when the database delete fails", async () => {
  const form = new (globalThis as any).FormData();
  form.append(
    "photo",
    new (globalThis as any).Blob([jpegBytes], { type: "image/jpeg" }),
    "database-failure-portrait.jpg",
  );

  const uploadResponse = await fetch(
    `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${desktopCredentials.token}` },
      body: form,
    },
  );
  assert.equal(uploadResponse.status, 201);
  const uploaded = (await uploadResponse.json()) as PhotoResponse;
  const filePath = path.resolve(process.cwd(), uploaded.fileUrl.replace(/^\//, ""));
  assert(fs.existsSync(filePath), "the uploaded photo should exist before the failure");

  const triggerName = `photo_delete_failure_${process.pid}_${Date.now()}`;
  const functionName = `${triggerName}_function`;
  await pool.query(`
    CREATE FUNCTION ${functionName}() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'intentional photo delete failure';
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    CREATE TRIGGER ${triggerName}
    BEFORE DELETE ON student_photos
    FOR EACH ROW EXECUTE FUNCTION ${functionName}()
  `);

  try {
    const deleteResponse = await fetch(
      `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos/${uploaded.id}`,
      { method: "DELETE" },
    );
    assert.equal(deleteResponse.status, 500);
    assert(fs.existsSync(filePath), "a failed database delete must keep the photo file");
    assert.deepEqual(await readFile(filePath), jpegBytes);

    const [storedPhoto] = await db
      .select()
      .from(studentPhotosTable)
      .where(eq(studentPhotosTable.id, uploaded.id));
    assert(storedPhoto, "a failed database delete must keep the photo row");
    assert.equal(storedPhoto.fileUrl, uploaded.fileUrl);
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON student_photos`);
    await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    await db.delete(studentPhotosTable).where(eq(studentPhotosTable.id, uploaded.id));
    await rm(filePath, { force: true });
  }
});

async function uploadFailureTestPhoto(fileName: string): Promise<{
  uploaded: PhotoResponse;
  filePath: string;
}> {
  const form = new (globalThis as any).FormData();
  form.append(
    "photo",
    new (globalThis as any).Blob([jpegBytes], { type: "image/jpeg" }),
    fileName,
  );
  const response = await fetch(
    `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${desktopCredentials.token}` },
      body: form,
    },
  );
  assert.equal(response.status, 201);
  const uploaded = (await response.json()) as PhotoResponse;
  return {
    uploaded,
    filePath: path.resolve(process.cwd(), uploaded.fileUrl.replace(/^\//, "")),
  };
}

async function reservePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function startProductionServer(): Promise<{
  child: ChildProcess;
  output: () => string;
}> {
  const port = await reservePort();
  const child = spawn(process.execPath, [path.resolve(process.cwd(), "dist/index.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  const healthUrl = `http://127.0.0.1:${port}/api/healthz`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Production server exited before becoming ready:\n${output}`);
    }

    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return { child, output: () => output };
      }
    } catch {
      // The child may still be recovering the deletion backups or binding its port.
    }
    await wait(50);
  }

  child.kill("SIGTERM");
  throw new Error(`Production server did not become ready:\n${output}`);
}

async function stopProductionServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
}

test("recovers interrupted photo deletions before a restarted server accepts requests", async () => {
  const restored = await uploadFailureTestPhoto("restart-restored.jpg");
  const preserved = await uploadFailureTestPhoto("restart-preserved.jpg");
  const deleted = await uploadFailureTestPhoto("restart-deleted.jpg");
  const fixtures = [restored, preserved, deleted];
  const backupDirectories = fixtures.map(({ filePath }, index) =>
    path.join(path.dirname(filePath), `.photo-delete-restart-${index}`),
  );
  const backupPaths = fixtures.map(({ filePath }, index) =>
    path.join(backupDirectories[index], path.basename(filePath)),
  );
  const preservedOriginalBytes = Buffer.from("the surviving original");
  const staleBackupBytes = Buffer.from("stale backup bytes");
  let productionServer: ChildProcess | undefined;

  try {
    // Simulate the process stopping after the backup copy, before its next
    // deletion step, for each possible database/filesystem state.
    await rm(restored.filePath, { force: true });
    await fs.promises.mkdir(backupDirectories[0], { recursive: true });
    await fs.promises.writeFile(backupPaths[0], jpegBytes);

    await fs.promises.writeFile(preserved.filePath, preservedOriginalBytes);
    await fs.promises.mkdir(backupDirectories[1], { recursive: true });
    await fs.promises.writeFile(backupPaths[1], staleBackupBytes);

    await fs.promises.mkdir(backupDirectories[2], { recursive: true });
    await fs.promises.copyFile(deleted.filePath, backupPaths[2]);
    await db.delete(studentPhotosTable).where(eq(studentPhotosTable.id, deleted.uploaded.id));

    const started = await startProductionServer();
    productionServer = started.child;

    const [restoredRow] = await db
      .select({ id: studentPhotosTable.id })
      .from(studentPhotosTable)
      .where(eq(studentPhotosTable.id, restored.uploaded.id));
    const [preservedRow] = await db
      .select({ id: studentPhotosTable.id })
      .from(studentPhotosTable)
      .where(eq(studentPhotosTable.id, preserved.uploaded.id));
    const [deletedRow] = await db
      .select({ id: studentPhotosTable.id })
      .from(studentPhotosTable)
      .where(eq(studentPhotosTable.id, deleted.uploaded.id));

    assert(restoredRow, "a surviving row must remain after restart recovery");
    assert(preservedRow, "a row with a surviving original must remain after restart recovery");
    assert.equal(deletedRow, undefined, "a committed row deletion must remain committed");
    assert.deepEqual(await readFile(restored.filePath), jpegBytes, "missing originals must be restored");
    assert.deepEqual(
      await readFile(preserved.filePath),
      preservedOriginalBytes,
      "recovery must not overwrite a surviving original",
    );
    assert.equal(
      fs.existsSync(deleted.filePath),
      false,
      "an original without a database row must be removed",
    );
    for (const backupDirectory of backupDirectories) {
      assert.equal(
        fs.existsSync(backupDirectory),
        false,
        "successfully reconciled backups must be removed",
      );
    }
  } finally {
    if (productionServer) {
      await stopProductionServer(productionServer);
    }
    for (const fixture of fixtures) {
      await db.delete(studentPhotosTable).where(eq(studentPhotosTable.id, fixture.uploaded.id));
      await rm(fixture.filePath, { force: true });
    }
    for (const backupDirectory of backupDirectories) {
      await rm(backupDirectory, { recursive: true, force: true });
    }
  }
});

test("restores the photo row when removing its file fails", async () => {
  const { uploaded, filePath } = await uploadFailureTestPhoto("unlink-failure.jpg");
  const originalUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = ((target: fs.PathLike) => {
    if (path.resolve(String(target)) === filePath) {
      throw new Error("intentional unlink failure");
    }
    return originalUnlinkSync(target);
  }) as typeof fs.unlinkSync;

  try {
    const response = await fetch(
      `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos/${uploaded.id}`,
      { method: "DELETE" },
    );
    assert.equal(response.status, 500);
    const [storedPhoto] = await db
      .select()
      .from(studentPhotosTable)
      .where(eq(studentPhotosTable.id, uploaded.id));
    assert(storedPhoto, "the photo row should be restored after unlink fails");
    assert.deepEqual(await readFile(filePath), jpegBytes);
  } finally {
    fs.unlinkSync = originalUnlinkSync;
    await db.delete(studentPhotosTable).where(eq(studentPhotosTable.id, uploaded.id));
    await rm(filePath, { force: true });
  }
});

test("keeps a durable backup when restoring the deleted row fails", async () => {
  const { uploaded, filePath } = await uploadFailureTestPhoto("restore-failure.jpg");
  const originalUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = ((target: fs.PathLike) => {
    if (path.resolve(String(target)) === filePath) {
      throw new Error("intentional unlink failure");
    }
    return originalUnlinkSync(target);
  }) as typeof fs.unlinkSync;
  const triggerName = `photo_restore_failure_${process.pid}_${Date.now()}`;
  const functionName = `${triggerName}_function`;
  await pool.query(`
    CREATE FUNCTION ${functionName}() RETURNS trigger AS $$
    BEGIN
      IF NEW.id = ${uploaded.id} THEN
        RAISE EXCEPTION 'intentional photo restore failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    CREATE TRIGGER ${triggerName}
    BEFORE INSERT ON student_photos
    FOR EACH ROW EXECUTE FUNCTION ${functionName}()
  `);

  const parentDirectory = path.dirname(filePath);
  try {
    const response = await fetch(
      `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos/${uploaded.id}`,
      { method: "DELETE" },
    );
    assert.equal(response.status, 500);
    assert.deepEqual(await readFile(filePath), jpegBytes, "the original remains readable");
    const backupDirectories = (await readdir(parentDirectory))
      .filter((entry) => entry.startsWith(".photo-delete-"));
    assert(backupDirectories.length > 0, "failed compensation must retain a recovery backup");
    const backupPath = path.join(parentDirectory, backupDirectories[0], path.basename(filePath));
    assert.deepEqual(await readFile(backupPath), jpegBytes);
  } finally {
    fs.unlinkSync = originalUnlinkSync;
    await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON student_photos`);
    await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    await db.insert(studentPhotosTable).values({
      id: uploaded.id,
      projectId: uploaded.projectId,
      studentId: uploaded.studentId,
      fileName: uploaded.fileName,
      fileUrl: uploaded.fileUrl,
      mimeType: uploaded.mimeType,
      capturedAt: uploaded.capturedAt,
      createdAt: new Date(uploaded.createdAt),
    }).onConflictDoNothing();
    await db.delete(studentPhotosTable).where(eq(studentPhotosTable.id, uploaded.id));
    for (const entry of await readdir(parentDirectory)) {
      if (entry.startsWith(".photo-delete-")) {
        await rm(path.join(parentDirectory, entry), { recursive: true, force: true });
      }
    }
    await rm(filePath, { force: true });
  }
});

test("finishes deletion when only backup cleanup fails", async () => {
  const { uploaded, filePath } = await uploadFailureTestPhoto("cleanup-failure.jpg");
  const originalRmSync = fs.rmSync;
  let blockedBackupDirectory: string | undefined;
  fs.rmSync = ((target: fs.PathLike, options?: fs.RmDirOptions) => {
    if (path.basename(String(target)).startsWith(".photo-delete-")) {
      blockedBackupDirectory = String(target);
      throw new Error("intentional backup cleanup failure");
    }
    return originalRmSync(target, options);
  }) as typeof fs.rmSync;

  try {
    const response = await fetch(
      `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos/${uploaded.id}`,
      { method: "DELETE" },
    );
    assert.equal(response.status, 204);
    assert.equal(fs.existsSync(filePath), false);
    const [storedPhoto] = await db
      .select({ id: studentPhotosTable.id })
      .from(studentPhotosTable)
      .where(eq(studentPhotosTable.id, uploaded.id));
    assert.equal(storedPhoto, undefined);
    assert(blockedBackupDirectory && fs.existsSync(blockedBackupDirectory));
    assert.deepEqual(
      await readFile(path.join(blockedBackupDirectory, path.basename(filePath))),
      jpegBytes,
    );
  } finally {
    fs.rmSync = originalRmSync;
    if (blockedBackupDirectory) {
      await rm(blockedBackupDirectory, { recursive: true, force: true });
    }
    await db.delete(studentPhotosTable).where(eq(studentPhotosTable.id, uploaded.id));
    await rm(filePath, { force: true });
  }
});

test("restores a photo after a process stops with only its deletion backup", async () => {
  const { uploaded, filePath } = await uploadFailureTestPhoto("interrupted-delete.jpg");
  const backupDirectory = path.join(path.dirname(filePath), ".photo-delete-interrupted");
  const backupPath = path.join(backupDirectory, path.basename(filePath));
  await rm(filePath, { force: true });
  await fs.promises.mkdir(backupDirectory, { recursive: true });
  await fs.promises.writeFile(backupPath, jpegBytes);

  try {
    await recoverPhotoDeleteBackups();
    assert.deepEqual(await readFile(filePath), jpegBytes, "recovery must preserve uploaded bytes");
    assert.equal(fs.existsSync(backupDirectory), false, "a recovered backup should be removed");
    const [storedPhoto] = await db
      .select({ id: studentPhotosTable.id })
      .from(studentPhotosTable)
      .where(eq(studentPhotosTable.id, uploaded.id));
    assert(storedPhoto, "recovery must retain the database row");
  } finally {
    await db.delete(studentPhotosTable).where(eq(studentPhotosTable.id, uploaded.id));
    await rm(filePath, { force: true });
    await rm(backupDirectory, { recursive: true, force: true });
  }
});

test("does not overwrite a valid original when an interrupted backup is stale", async () => {
  const { uploaded, filePath } = await uploadFailureTestPhoto("valid-original-delete.jpg");
  const backupDirectory = path.join(path.dirname(filePath), ".photo-delete-stale");
  const backupPath = path.join(backupDirectory, path.basename(filePath));
  const validOriginalBytes = Buffer.from("valid-original");
  const staleBackupBytes = Buffer.from("stale-backup");
  await fs.promises.writeFile(filePath, validOriginalBytes);
  await fs.promises.mkdir(backupDirectory, { recursive: true });
  await fs.promises.writeFile(backupPath, staleBackupBytes);

  try {
    await recoverPhotoDeleteBackups();
    assert.deepEqual(await readFile(filePath), validOriginalBytes);
    assert.notDeepEqual(await readFile(filePath), staleBackupBytes);
    assert.equal(fs.existsSync(backupDirectory), false, "a stale backup should be cleaned");
  } finally {
    await db.delete(studentPhotosTable).where(eq(studentPhotosTable.id, uploaded.id));
    await rm(filePath, { force: true });
    await rm(backupDirectory, { recursive: true, force: true });
  }
});

test("alerts once and preserves an ambiguous deletion backup for manual recovery", async () => {
  const { uploaded, filePath } = await uploadFailureTestPhoto("ambiguous-delete.jpg");
  const backupDirectory = path.join(path.dirname(filePath), ".photo-delete-ambiguous");
  const backupPath = path.join(backupDirectory, path.basename(filePath));
  const extraPath = path.join(backupDirectory, "unexpected-extra-file");
  const alertMarkerPath = path.join(backupDirectory, ".photo-delete-recovery-alerted");
  await fs.promises.mkdir(backupDirectory, { recursive: true });
  await fs.promises.copyFile(filePath, backupPath);
  await fs.promises.writeFile(extraPath, "not a photo backup");

  try {
    await recoverPhotoDeleteBackups();
    await recoverPhotoDeleteBackups();

    assert(fs.existsSync(backupPath), "an ambiguous backup must remain available");
    assert(fs.existsSync(extraPath), "ambiguous backup contents must remain untouched");
    assert(fs.existsSync(alertMarkerPath), "an unsafe recovery alert must be persisted");
    assert(fs.existsSync(filePath), "the original must remain untouched for manual recovery");
    const [storedPhoto] = await db
      .select({ id: studentPhotosTable.id })
      .from(studentPhotosTable)
      .where(eq(studentPhotosTable.id, uploaded.id));
    assert(storedPhoto, "an ambiguous backup must not change the database row");
  } finally {
    await db.delete(studentPhotosTable).where(eq(studentPhotosTable.id, uploaded.id));
    await rm(filePath, { force: true });
    await rm(backupDirectory, { recursive: true, force: true });
  }
});

test("cleans an interrupted deletion after its database row is gone", async () => {
  const { uploaded, filePath } = await uploadFailureTestPhoto("committed-delete.jpg");
  const backupDirectory = path.join(path.dirname(filePath), ".photo-delete-committed");
  const backupPath = path.join(backupDirectory, path.basename(filePath));
  await fs.promises.mkdir(backupDirectory, { recursive: true });
  await fs.promises.copyFile(filePath, backupPath);
  await db.delete(studentPhotosTable).where(eq(studentPhotosTable.id, uploaded.id));

  try {
    await recoverPhotoDeleteBackups();
    assert.equal(fs.existsSync(filePath), false, "a deleted row permits orphan cleanup");
    assert.equal(fs.existsSync(backupDirectory), false, "the orphaned backup should be cleaned");
  } finally {
    await db.delete(studentPhotosTable).where(eq(studentPhotosTable.id, uploaded.id));
    await rm(filePath, { force: true });
    await rm(backupDirectory, { recursive: true, force: true });
  }
});

test("limits photographer desktops to assignments, gives admins studio access, and revokes only one connection", async () => {
  const listResponse = await fetch(`${baseUrl}/api/desktop/projects`, {
    headers: { Authorization: `Bearer ${desktopCredentials.token}` },
  });
  assert.equal(listResponse.status, 200);
  const projects = await listResponse.json() as { id: number }[];
  assert(projects.some((project) => project.id === projectId), "assigned project should be listed");
  assert(!projects.some((project) => project.id === hiddenProjectId), "unassigned project must not be listed");

  const bundleResponse = await fetch(`${baseUrl}/api/desktop/projects/${hiddenProjectId}/bundle`, {
    headers: { Authorization: `Bearer ${desktopCredentials.token}` },
  });
  assert.equal(bundleResponse.status, 404, "unassigned project bundle must be hidden");

  const adminListResponse = await fetch(`${baseUrl}/api/desktop/projects`, {
    headers: { Authorization: `Bearer ${adminDesktopCredentials.token}` },
  });
  assert.equal(adminListResponse.status, 200);
  const adminProjects = await adminListResponse.json() as { id: number }[];
  assert.deepEqual(
    adminProjects.map((project) => project.id).sort((a, b) => a - b),
    [projectId, hiddenProjectId].sort((a, b) => a - b),
    "an admin desktop should see every project in its studio without assignments",
  );

  const adminBundleResponse = await fetch(`${baseUrl}/api/desktop/projects/${projectId}/bundle`, {
    headers: { Authorization: `Bearer ${adminDesktopCredentials.token}` },
  });
  assert.equal(adminBundleResponse.status, 200, "an admin desktop should download an unassigned studio bundle");

  const adminUpload = new (globalThis as any).FormData();
  adminUpload.append(
    "photo",
    new (globalThis as any).Blob([jpegBytes], { type: "image/jpeg" }),
    "admin-studio-upload.jpg",
  );
  const adminUploadResponse = await fetch(
    `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${adminDesktopCredentials.token}` },
      body: adminUpload,
    },
  );
  assert.equal(adminUploadResponse.status, 201, "an admin desktop should upload to any project in its studio");
  const adminUploaded = await adminUploadResponse.json() as PhotoResponse;
  await db.delete(studentPhotosTable).where(eq(studentPhotosTable.id, adminUploaded.id));
  await rm(path.resolve(process.cwd(), adminUploaded.fileUrl.replace(/^\//, "")), { force: true });

  await db
    .update(desktopConnectionsTable)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(and(
      eq(desktopConnectionsTable.memberId, memberId),
      eq(desktopConnectionsTable.tokenHash, desktopCredentials.tokenHash),
    ));

  const revokedResponse = await fetch(`${baseUrl}/api/desktop/projects`, {
    headers: { Authorization: `Bearer ${desktopCredentials.token}` },
  });
  assert.equal(revokedResponse.status, 401);

  const otherConnectionResponse = await fetch(`${baseUrl}/api/desktop/projects`, {
    headers: { Authorization: `Bearer ${otherDesktopCredentials.token}` },
  });
  assert.equal(otherConnectionResponse.status, 200, "revoking one device must not interrupt another");
});

test("rejects encoded traversal identifiers before writing an upload", async () => {
  const form = new (globalThis as any).FormData();
  form.append(
    "photo",
    new (globalThis as any).Blob([jpegBytes], { type: "image/jpeg" }),
    "traversal-attempt.jpg",
  );

  const response = await fetch(
    `${baseUrl}/api/projects/%2E%2E%2Foutside/students/${studentId}/photos`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${otherDesktopCredentials.token}` },
      body: form,
    },
  );
  assert.equal(response.status, 400);
  assert(!fs.existsSync(path.resolve(process.cwd(), "uploads", "outside")), "invalid identifiers must not create an upload directory");
});