import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { getPhotoSystemLayout, getProjectStorageLayout } from "../src/main/lib/storageLayout.ts";
import { formatStudentFolderName } from "../src/main/lib/photoFileNaming.ts";
import { safeProjectFolderName } from "../src/main/lib/retirement.ts";
import {
  addGroupFilesForMembers,
  buildPixiesetCsv,
  isPixiesetApprovedCapture,
  safeCollectionName,
} from "../src/main/ipc/pixiesetExport.ts";

const desktopRoot = join(process.cwd(), "src");
const projectsSource = readFileSync(join(desktopRoot, "main", "ipc", "projects.ts"), "utf8");
const uploadSource = readFileSync(join(desktopRoot, "main", "ipc", "upload.ts"), "utf8");
const rendererSource = readFileSync(join(desktopRoot, "renderer", "src", "App.tsx"), "utf8");
const projectViewSource = readFileSync(join(desktopRoot, "renderer", "src", "pages", "ProjectView.tsx"), "utf8");

function handlerBetween(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert(startIndex >= 0, `missing source marker: ${start}`);
  assert(endIndex > startIndex, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("photographer-created classes use the normal folder, group, and cloud identity path", () => {
  const createHandler = handlerBetween(projectsSource, "ipcMain.handle(\n    'classes:create'", "ipcMain.handle(\n    'students:create'");
  const moveHandler = handlerBetween(projectsSource, "ipcMain.handle(\n    'students:move'", "ipcMain.handle(\n    'students:list'");
  assert.match(createHandler, /classesTable/);
  assert.match(createHandler, /prepareProjectFolders/);
  assert.match(createHandler, /reconcileDefaultGroups/);
  assert.match(createHandler, /syncClassCloudIdentity/);
  assert.match(moveHandler, /\.set\(\{ classId: destination\.id, updatedAt:/);
  assert.match(moveHandler, /prepareProjectFolders/);
  assert.match(moveHandler, /reconcileDefaultGroups/);
  assert.match(moveHandler, /syncStudentCloudIdentity/);
  assert.doesNotMatch(moveHandler, /delete\(groupMembersTable|update\(capturesTable|delete\(capturesTable|update\(studentPhotosTable/);
});

test("offline/reconnect and renderer contracts keep classes usable for normal capture", () => {
  assert.match(uploadSource, /createCloudClass/);
  assert.match(uploadSource, /method: 'PATCH'/);
  assert.match(uploadSource, /retryPendingRosterCloudIdentities/);
  assert.match(
    uploadSource,
    /const students = db\.select\(\{ id: studentsTable\.id, projectId: studentsTable\.projectId \}\)[\s\S]*?\.where\(isNull\(studentsTable\.cloudId\)\)/,
  );
  assert.match(uploadSource, /pendingRosterIdentityRetry/);
  assert.match(uploadSource, /for \(const student of students\)/);
  assert.match(uploadSource, /cloudStudent\.classId !== cloudClass\.id/);
  assert.match(rendererSource, /onAddClass/);
  assert.match(projectViewSource, /MoveStudentDialog/);
  assert.match(projectViewSource, /students:move/);
});

test("created class and moved student retain ordinary folder and Pixieset-compatible identity", () => {
  const photoLayout = getPhotoSystemLayout("/tmp/volume-capture-follow-up");
  const projectLayout = getProjectStorageLayout(photoLayout, 42, "Grade / 4B");
  assert.equal(projectLayout.root, join(photoLayout.jobs, "Grade _ 4B-42"));
  assert.equal(formatStudentFolderName("New", "Person", "NEW1234"), "New_Person_NEW1234");
  assert.equal(safeProjectFolderName("Grade / 4B"), "Grade _ 4B");

  assert.equal(isPixiesetApprovedCapture({ rating: 5, rejected: false }), true);
  assert.equal(isPixiesetApprovedCapture({ rating: 0, rejected: false }), false);
  assert.equal(
    safeCollectionName("Grade 4B", "New", "Person", "NEW1234"),
    "Grade 4B - New Person",
  );
  assert.match(
    buildPixiesetCsv([{
      collectionName: "Grade 4B - New-Person",
      email: "parent@example.com",
      firstName: "New",
      lastName: "Person",
    }]),
    /Grade 4B - New-Person,parent@example\.com,New,Person/,
  );
  const groupFiles = new Map<number, string[]>();
  addGroupFilesForMembers(groupFiles, [42], ["historical-group.jpg"]);
  assert.deepEqual(groupFiles.get(42), ["historical-group.jpg"]);
});