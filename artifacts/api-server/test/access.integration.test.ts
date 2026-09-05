import { strict as assert } from "node:assert";
import { once } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import test, { after, before } from "node:test";
import express from "express";
import { eq } from "drizzle-orm";
import {
  classesTable,
  db,
  desktopConnectionsTable,
  pool,
  projectAssignmentsTable,
  projectsTable,
  studentPhotosTable,
  studioInvitesTable,
  studioMembersTable,
  studiosTable,
  studentsTable,
} from "@workspace/db";
import dashboardRouter from "../src/routes/dashboard";
import exportRouter from "../src/routes/export";
import classesRouter from "../src/routes/classes";
import photosRouter from "../src/routes/photos";
import projectsRouter from "../src/routes/projects";
import studentsRouter from "../src/routes/students";
import teamRouter from "../src/routes/team";
import desktopRouter from "../src/routes/desktop";
import { createDesktopToken } from "../src/lib/desktopAuth";

// The route keeps real Clerk authentication middleware via requireAuth. This
// test only supplies Clerk's branded request contract, so no live account is
// contacted and no staff session is reused.
process.env.CLERK_SECRET_KEY = "";

const suffix = `${process.pid}-${Date.now()}`;
const ownerUserId = `access-owner-${suffix}`;
const platformOwnerUserId = `access-platform-owner-${suffix}`;
const adminUserId = `access-admin-${suffix}`;
const assistantUserId = `access-assistant-${suffix}`;
const photographerUserId = `access-photographer-${suffix}`;
const viewerUserId = `access-viewer-${suffix}`;
const pendingUserId = `access-pending-${suffix}`;
const removedUserId = `access-removed-${suffix}`;
const pendingEmail = `${pendingUserId}@member.local`;
process.env.PLATFORM_OWNER_USER_ID = platformOwnerUserId;

let server: Server;
let baseUrl: string;
let studioId: number;
let otherStudioId: number;
let ownerMemberId: number;
let platformOwnerMemberId: number;
let adminMemberId: number;
let assignedProjectId: number;
let unassignedProjectId: number;
let crossStudioProjectId: number;
let crossStudioStudentId: number;
let assignedStudentId: number;
let readablePhotoId: number;
let deletablePhotoId: number;
let photoDirectory: string;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const userId = req.header("x-test-user") ?? ownerUserId;
  const authHandler = Object.assign(
    () => ({
      tokenType: "session_token",
      userId,
      sessionClaims: { userId },
    }),
    { [Symbol.for("@clerk/express.auth")]: true },
  );
  (req as any).auth = authHandler;
  next();
});
app.use("/api/dashboard", dashboardRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/projects/:projectId/classes", classesRouter);
app.use("/api/projects/:projectId/students", studentsRouter);
app.use("/api/projects/:projectId/export", exportRouter);
app.use("/api/projects/:projectId/students", photosRouter);
app.use("/api/team", teamRouter);
app.use("/api/desktop", desktopRouter);

async function request(userId: string, pathname: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-test-user", userId);
  return fetch(`${baseUrl}${pathname}`, { ...init, headers });
}

async function readJson<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

before(async () => {
  const [studio] = await db
    .insert(studiosTable)
    .values({ name: `Access matrix studio ${suffix}`, createdByUserId: ownerUserId })
    .returning({ id: studiosTable.id });
  studioId = studio.id;

  const memberRows = await db
    .insert(studioMembersTable)
    .values([
      { studioId, userId: ownerUserId, email: `${ownerUserId}@member.local`, role: "owner" },
      { studioId, userId: platformOwnerUserId, email: `${platformOwnerUserId}@member.local`, role: "owner" },
      { studioId, userId: adminUserId, email: `${adminUserId}@member.local`, role: "admin" },
      { studioId, userId: assistantUserId, email: `${assistantUserId}@member.local`, role: "assistant" },
      { studioId, userId: photographerUserId, email: `${photographerUserId}@member.local`, role: "photographer" },
      { studioId, userId: viewerUserId, email: `${viewerUserId}@member.local`, role: "viewer" },
      { studioId, userId: removedUserId, email: `${removedUserId}@member.local`, role: "photographer", status: "removed" },
    ])
    .returning({ id: studioMembersTable.id, userId: studioMembersTable.userId });
  await db.insert(studioInvitesTable).values({
    studioId,
    email: pendingEmail,
    role: "viewer",
    code: `pending-${suffix}`,
    status: "pending",
  });

  const [assignedProject] = await db
    .insert(projectsTable)
    .values({ userId: removedUserId, studioId, schoolName: `Assigned School ${suffix}` })
    .returning({ id: projectsTable.id });
  assignedProjectId = assignedProject.id;

  const [unassignedProject] = await db
    .insert(projectsTable)
    .values({ userId: ownerUserId, studioId, schoolName: `Unassigned School ${suffix}` })
    .returning({ id: projectsTable.id });
  unassignedProjectId = unassignedProject.id;

  const [otherStudio] = await db
    .insert(studiosTable)
    .values({ name: `Other access studio ${suffix}`, createdByUserId: `other-owner-${suffix}` })
    .returning({ id: studiosTable.id });
  otherStudioId = otherStudio.id;
  const [crossStudioProject] = await db
    .insert(projectsTable)
    .values({
      userId: `other-owner-${suffix}`,
      studioId: otherStudioId,
      schoolName: `Cross-studio School ${suffix}`,
    })
    .returning({ id: projectsTable.id });
  crossStudioProjectId = crossStudioProject.id;

  const [crossStudioClass] = await db
    .insert(classesTable)
    .values({ projectId: crossStudioProjectId, className: `Cross-studio Class ${suffix}` })
    .returning({ id: classesTable.id });
  const [crossStudioStudent] = await db
    .insert(studentsTable)
    .values({
      projectId: crossStudioProjectId,
      classId: crossStudioClass.id,
      firstName: "Cross",
      lastName: "Studio",
      generatedStudentId: `CROSS${String(process.pid).slice(-3)}${Date.now().toString().slice(-4)}`,
    })
    .returning({ id: studentsTable.id });
  crossStudioStudentId = crossStudioStudent.id;

  const [studentClass] = await db
    .insert(classesTable)
    .values({ projectId: assignedProjectId, className: `Access Test Class ${suffix}` })
    .returning({ id: classesTable.id });
  const [student] = await db
    .insert(studentsTable)
    .values({
      projectId: assignedProjectId,
      classId: studentClass.id,
      firstName: "Access",
      lastName: "Test",
      generatedStudentId: `ACC${String(process.pid).slice(-3)}${Date.now().toString().slice(-4)}`,
    })
    .returning({ id: studentsTable.id });
  assignedStudentId = student.id;
  photoDirectory = path.resolve(process.cwd(), "uploads", "access-tests", suffix);
  await mkdir(photoDirectory, { recursive: true });
  const readableFileUrl = `/uploads/access-tests/${suffix}/readable.jpg`;
  const deletableFileUrl = `/uploads/access-tests/${suffix}/deletable.jpg`;
  await Promise.all([
    writeFile(path.join(photoDirectory, "readable.jpg"), Buffer.from("readable access-test photo")),
    writeFile(path.join(photoDirectory, "deletable.jpg"), Buffer.from("deletable access-test photo")),
  ]);
  const insertedPhotos = await db
    .insert(studentPhotosTable)
    .values([
      { projectId: assignedProjectId, studentId: assignedStudentId, fileName: "readable.jpg", fileUrl: readableFileUrl, mimeType: "image/jpeg" },
      { projectId: assignedProjectId, studentId: assignedStudentId, fileName: "deletable.jpg", fileUrl: deletableFileUrl, mimeType: "image/jpeg" },
    ])
    .returning({ id: studentPhotosTable.id, fileName: studentPhotosTable.fileName });
  readablePhotoId = insertedPhotos.find((photo) => photo.fileName === "readable.jpg")!.id;
  deletablePhotoId = insertedPhotos.find((photo) => photo.fileName === "deletable.jpg")!.id;

  const membersByUserId = new Map(memberRows.map((member) => [member.userId, member.id]));
  ownerMemberId = membersByUserId.get(ownerUserId)!;
  platformOwnerMemberId = membersByUserId.get(platformOwnerUserId)!;
  adminMemberId = membersByUserId.get(adminUserId)!;
  await db.insert(projectAssignmentsTable).values([
    { projectId: assignedProjectId, memberId: membersByUserId.get(assistantUserId)! },
    { projectId: assignedProjectId, memberId: membersByUserId.get(photographerUserId)! },
    { projectId: assignedProjectId, memberId: membersByUserId.get(viewerUserId)! },
  ]);

  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (otherStudioId) {
    await db.delete(studiosTable).where(eq(studiosTable.id, otherStudioId));
  }
  if (studioId) {
    await db.delete(studiosTable).where(eq(studiosTable.id, studioId));
  }
  if (photoDirectory) {
    await rm(photoDirectory, { recursive: true, force: true });
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await pool.end();
});

test("keeps project lists and dashboard counts within each role's assignment boundary", async () => {
  const expectations = [
    { name: "owner", userId: ownerUserId, projectIds: [assignedProjectId, unassignedProjectId], counts: [2, 1] },
    { name: "admin", userId: adminUserId, projectIds: [assignedProjectId, unassignedProjectId], counts: [2, 1] },
    { name: "assistant", userId: assistantUserId, projectIds: [assignedProjectId], counts: [1, 1] },
    { name: "photographer", userId: photographerUserId, projectIds: [assignedProjectId], counts: [1, 1] },
    { name: "viewer", userId: viewerUserId, projectIds: [assignedProjectId], counts: [1, 1] },
    { name: "removed member", userId: removedUserId, projectIds: [], counts: [0, 0] },
  ];

  for (const expectation of expectations) {
    const projectResponse = await request(expectation.userId, "/api/projects");
    assert.equal(projectResponse.status, 200, `${expectation.name} project list should respond`);
    const projects = await readJson<{ id: number }[]>(projectResponse);
    assert.deepEqual(
      projects.map((project) => project.id).sort((a, b) => a - b),
      [...expectation.projectIds].sort((a, b) => a - b),
      `${expectation.name} should only see permitted projects`,
    );

    const dashboardResponse = await request(expectation.userId, "/api/dashboard/stats");
    assert.equal(dashboardResponse.status, 200, `${expectation.name} dashboard should respond`);
    const dashboard = await readJson<{ totalProjects: number; totalStudents: number }>(dashboardResponse);
    assert.deepEqual(
      [dashboard.totalProjects, dashboard.totalStudents],
      expectation.counts,
      `${expectation.name} dashboard counts should match project access`,
    );
  }
});

test("protects project details, student rosters, and every export format", async () => {
  const allowedUsers = [ownerUserId, adminUserId, assistantUserId, photographerUserId, viewerUserId];
  const deniedUsers = [removedUserId];

  for (const userId of allowedUsers) {
    const projectResponse = await request(userId, `/api/projects/${assignedProjectId}`);
    assert.equal(projectResponse.status, 200, "assigned members should open the assigned project");

    const studentsResponse = await request(userId, `/api/projects/${assignedProjectId}/students`);
    assert.equal(studentsResponse.status, 200, "assigned members should read the student roster");
    const students = await readJson<{ id: number }[]>(studentsResponse);
    assert.deepEqual(students.map((student) => student.id), [assignedStudentId]);

    const jsonExportResponse = await request(userId, `/api/projects/${assignedProjectId}/export/json`);
    assert.equal(jsonExportResponse.status, 200, "assigned members should download JSON exports");
    const jsonExport = await readJson<{ project: { id: number }; students: { id: number }[] }>(jsonExportResponse);
    assert.equal(jsonExport.project.id, assignedProjectId);
    assert.deepEqual(jsonExport.students.map((student) => student.id), [assignedStudentId]);

    for (const [format, contentType] of [["zip", "application/zip"], ["pdf", "application/pdf"]] as const) {
      const exportResponse = await request(userId, `/api/projects/${assignedProjectId}/export/${format}`);
      assert.equal(exportResponse.status, 200, `assigned members should download ${format} exports`);
      assert.match(exportResponse.headers.get("content-type") ?? "", new RegExp(contentType));
    }
  }

  for (const userId of [...allowedUsers, ...deniedUsers]) {
    const unassignedResponse = await request(userId, `/api/projects/${unassignedProjectId}`);
    assert.equal(
      unassignedResponse.status,
      allowedUsers.slice(0, 2).includes(userId) ? 200 : 404,
      "only owner and admin should open an unassigned project",
    );

    const rosterResponse = await request(userId, `/api/projects/${unassignedProjectId}/students`);
    assert.equal(rosterResponse.status, allowedUsers.slice(0, 2).includes(userId) ? 200 : 404);

    for (const format of ["json", "zip", "pdf"]) {
      const exportResponse = await request(userId, `/api/projects/${unassignedProjectId}/export/${format}`);
      assert.equal(
        exportResponse.status,
        allowedUsers.slice(0, 2).includes(userId) ? 200 : 404,
        `${userId} must not access an unassigned ${format} export`,
      );
    }
  }
});

test("keeps Team data and invitation activation permission-aware", async () => {
  const ownerTeamResponse = await request(ownerUserId, "/api/team");
  assert.equal(ownerTeamResponse.status, 200);
  const ownerTeam = await readJson<{
    currentMember: { role: string };
    invites: { email: string; status: string }[];
    projects: { id: number }[];
    assignments: { projectId: number; memberId: number }[];
  }>(ownerTeamResponse);
  assert.equal(ownerTeam.currentMember.role, "owner");
  assert(ownerTeam.invites.some((invite) => invite.email === pendingEmail && invite.status === "pending"));
  assert.deepEqual(
    ownerTeam.projects.map((project) => project.id).sort((a, b) => a - b),
    [assignedProjectId, unassignedProjectId].sort((a, b) => a - b),
  );
  assert(ownerTeam.assignments.some((assignment) => assignment.projectId === assignedProjectId));

  for (const userId of [adminUserId, assistantUserId, photographerUserId, viewerUserId]) {
    const teamResponse = await request(userId, "/api/team");
    assert.equal(teamResponse.status, 200, "active members should load the Team page data");
    const team = await readJson<{
      currentMember: { userId: string; role: string };
      desktopConnections: unknown[];
      invites: unknown[];
      assignments: unknown[];
      projects: { id: number }[];
    }>(teamResponse);
    assert.equal(team.currentMember.userId, userId);
    if (team.currentMember.role === "admin") {
      assert.deepEqual(
        team.projects.map((project) => project.id).sort((a, b) => a - b),
        [assignedProjectId, unassignedProjectId].sort((a, b) => a - b),
      );
      continue;
    }
    assert.deepEqual(team.desktopConnections, [], "non-managers must not receive desktop connection controls/data");
    assert.deepEqual(team.invites, [], "non-managers must not receive pending invitation data");
    assert.deepEqual(team.assignments, [], "non-managers must not receive assignment metadata");
    assert.deepEqual(team.projects.map((project) => project.id), [assignedProjectId]);
  }

  const pendingTeamResponse = await request(pendingUserId, "/api/team");
  assert.equal(pendingTeamResponse.status, 200, "a pending invite is accepted only when that user signs in");
  const pendingTeam = await readJson<{ currentMember: { role: string }; projects: unknown[] }>(pendingTeamResponse);
  assert.equal(pendingTeam.currentMember.role, "viewer");
  assert.deepEqual(pendingTeam.projects, [], "an invited viewer without an assignment sees no project");

  const removedTeamResponse = await request(removedUserId, "/api/team");
  assert.equal(removedTeamResponse.status, 403, "removed members must not load the old Team page");

  const viewerInviteResponse = await request(viewerUserId, "/api/team/invites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `blocked-${suffix}@member.local`, role: "viewer" }),
  });
  assert.equal(viewerInviteResponse.status, 403, "viewer controls must not invite teammates");

  const ownerInviteResponse = await request(ownerUserId, "/api/team/invites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `allowed-${suffix}@member.local`, role: "viewer" }),
  });
  assert.equal(ownerInviteResponse.status, 201, "owner controls should be able to invite teammates");

  for (const [userId, memberId, role] of [
    [ownerUserId, ownerMemberId, "owner"],
    [adminUserId, adminMemberId, "admin"],
  ] as const) {
    const desktopResponse = await request(userId, "/api/team/desktop-connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId, deviceName: `${role} test Mac` }),
    });
    assert.equal(desktopResponse.status, 201, `${role} should create a manager desktop connection`);
    const desktop = await readJson<{ token: string }>(desktopResponse);
    assert.match(desktop.token, /^mcs_desktop_/, `${role} connection should return a one-time token`);
  }
});

test("completes a one-time browser desktop sign-in for shoot-capable roles", async () => {
  const clientSecret = createDesktopToken().token;
  const startResponse = await request(ownerUserId, "/api/desktop/auth/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientSecret }),
  });
  assert.equal(startResponse.status, 201);
  const started = await readJson<{ code: string }>(startResponse);

  const pendingResponse = await fetch(`${baseUrl}/api/desktop/auth/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: started.code, clientSecret }),
  });
  assert.equal(pendingResponse.status, 200);
  assert.equal((await readJson<{ status: string }>(pendingResponse)).status, "pending");

  const approvalResponse = await request(ownerUserId, "/api/desktop/auth/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: started.code }),
  });
  assert.equal(approvalResponse.status, 200);

  const exchangeResponse = await fetch(`${baseUrl}/api/desktop/auth/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: started.code, clientSecret }),
  });
  assert.equal(exchangeResponse.status, 200);
  const exchanged = await readJson<{ token: string; member: { role: string } }>(exchangeResponse);
  assert.match(exchanged.token, /^mcs_desktop_/);
  assert.equal(exchanged.member.role, "owner");

  const refreshResponse = await fetch(`${baseUrl}/api/desktop/auth/refresh`, {
    method: "POST",
    headers: { Authorization: `Bearer ${exchanged.token}` },
  });
  assert.equal(refreshResponse.status, 200, "an active desktop session should rotate without browser approval");
  const refreshed = await readJson<{ token: string }>(refreshResponse);
  assert.match(refreshed.token, /^mcs_desktop_/);
  assert.notEqual(refreshed.token, exchanged.token);
  const oldTokenResponse = await fetch(`${baseUrl}/api/desktop/me`, {
    headers: { Authorization: `Bearer ${exchanged.token}` },
  });
  assert.equal(oldTokenResponse.status, 401, "refresh should immediately invalidate the old credential");

  const usedAgain = await fetch(`${baseUrl}/api/desktop/auth/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: started.code, clientSecret }),
  });
  assert.equal(usedAgain.status, 409, "a browser authorization request must only be exchanged once");

  const viewerSecret = createDesktopToken().token;
  const viewerStart = await request(viewerUserId, "/api/desktop/auth/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientSecret: viewerSecret }),
  });
  const viewerCode = (await readJson<{ code: string }>(viewerStart)).code;
  const viewerApproval = await request(viewerUserId, "/api/desktop/auth/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: viewerCode }),
  });
  assert.equal(viewerApproval.status, 403, "view-only members must not connect the desktop app");
});

test("retires a desktop, blocks cloud data, and records its cleanup acknowledgement", async () => {
  const credentials = createDesktopToken();
  const [connection] = await db.insert(desktopConnectionsTable).values({
    studioId,
    memberId: ownerMemberId,
    deviceName: `Retirement test Mac ${suffix}`,
    tokenHash: credentials.tokenHash,
    tokenPrefix: credentials.tokenPrefix,
  }).returning({ id: desktopConnectionsTable.id });

  const activeProjects = await fetch(`${baseUrl}/api/desktop/projects`, {
    headers: { Authorization: `Bearer ${credentials.token}` },
  });
  assert.equal(activeProjects.status, 200);

  const adminAttempt = await request(adminUserId, `/api/team/desktop-connections/${connection.id}/retire`, {
    method: "POST",
  });
  assert.equal(adminAttempt.status, 403, "admins cannot remotely erase an owner's desktop");

  const retirement = await request(ownerUserId, `/api/team/desktop-connections/${connection.id}/retire`, {
    method: "POST",
  });
  assert.equal(retirement.status, 200);
  const retired = await readJson<{ status: string; retiredAt: string; retirementAcknowledgedAt: string | null }>(retirement);
  assert.equal(retired.status, "retired");
  assert(retired.retiredAt);
  assert.equal(retired.retirementAcknowledgedAt, null);

  const blockedProjects = await fetch(`${baseUrl}/api/desktop/projects`, {
    headers: { Authorization: `Bearer ${credentials.token}` },
  });
  assert.equal(blockedProjects.status, 401, "a retired desktop cannot list cloud projects");

  const checkIn = await fetch(`${baseUrl}/api/desktop/me`, {
    headers: { Authorization: `Bearer ${credentials.token}` },
  });
  assert.equal(checkIn.status, 200, "the retired token remains valid only for retirement check-in");
  const checkInBody = await readJson<{
    projectCount: number;
    retirement: { retiredAt: string; acknowledgedAt: string | null };
  }>(checkIn);
  assert.equal(checkInBody.projectCount, 0);
  assert.equal(checkInBody.retirement.retiredAt, retired.retiredAt);
  assert.equal(checkInBody.retirement.acknowledgedAt, null);

  const acknowledgement = await fetch(`${baseUrl}/api/desktop/retirement/acknowledge`, {
    method: "POST",
    headers: { Authorization: `Bearer ${credentials.token}` },
  });
  assert.equal(acknowledgement.status, 200);
  const acknowledged = await readJson<{ acknowledgedAt: string }>(acknowledgement);
  assert(acknowledged.acknowledgedAt);

  const teamResponse = await request(ownerUserId, "/api/team");
  const team = await readJson<{
    desktopConnections: { id: number; status: string; retirementAcknowledgedAt: string | null }[];
  }>(teamResponse);
  const visibleConnection = team.desktopConnections.find((item) => item.id === connection.id);
  assert.equal(visibleConnection?.status, "retired");
  assert.equal(visibleConnection?.retirementAcknowledgedAt, acknowledged.acknowledgedAt);
});

test("lets a connected platform owner pull projects from every studio", async () => {
  const platformCredentials = createDesktopToken();
  await db.insert(desktopConnectionsTable).values({
    studioId,
    memberId: platformOwnerMemberId,
    deviceName: `Platform owner Mac ${suffix}`,
    tokenHash: platformCredentials.tokenHash,
    tokenPrefix: platformCredentials.tokenPrefix,
  });

  const projectsResponse = await fetch(`${baseUrl}/api/desktop/projects`, {
    headers: { Authorization: `Bearer ${platformCredentials.token}` },
  });
  assert.equal(projectsResponse.status, 200);
  const projectIds = (await readJson<{ id: number }[]>(projectsResponse)).map((project) => project.id);
  assert(projectIds.includes(assignedProjectId));
  assert(projectIds.includes(unassignedProjectId));
  assert(projectIds.includes(crossStudioProjectId), "the platform owner should see projects owned by another studio");

  const bundleResponse = await fetch(`${baseUrl}/api/desktop/projects/${crossStudioProjectId}/bundle`, {
    headers: { Authorization: `Bearer ${platformCredentials.token}` },
  });
  assert.equal(bundleResponse.status, 200);
  const bundle = await readJson<{ project: { id: number } }>(bundleResponse);
  assert.equal(bundle.project.id, crossStudioProjectId);

  for (const endpoint of ["photos", "captures"]) {
    const uploadResponse = await fetch(
      `${baseUrl}/api/projects/${crossStudioProjectId}/students/${crossStudioStudentId}/${endpoint}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${platformCredentials.token}` },
      },
    );
    assert.equal(
      uploadResponse.status,
      400,
      `the platform owner should pass cross-studio authorization for ${endpoint} uploads`,
    );
  }

  const regularOwnerCredentials = createDesktopToken();
  await db.insert(desktopConnectionsTable).values({
    studioId,
    memberId: ownerMemberId,
    deviceName: `Regular owner Mac ${suffix}`,
    tokenHash: regularOwnerCredentials.tokenHash,
    tokenPrefix: regularOwnerCredentials.tokenPrefix,
  });
  const regularOwnerProjectsResponse = await fetch(`${baseUrl}/api/desktop/projects`, {
    headers: { Authorization: `Bearer ${regularOwnerCredentials.token}` },
  });
  assert.equal(regularOwnerProjectsResponse.status, 200);
  const regularOwnerProjectIds = (await readJson<{ id: number }[]>(regularOwnerProjectsResponse))
    .map((project) => project.id);
  assert(!regularOwnerProjectIds.includes(crossStudioProjectId), "ordinary studio owners must remain isolated");
  const regularOwnerUploadResponse = await fetch(
    `${baseUrl}/api/projects/${crossStudioProjectId}/students/${crossStudioStudentId}/captures`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${regularOwnerCredentials.token}` },
    },
  );
  assert.equal(regularOwnerUploadResponse.status, 404, "ordinary owners must not upload across studios");
});

test("rejects access to an unassigned or unknown project", async () => {
  for (const userId of [assistantUserId, photographerUserId, viewerUserId]) {
    const response = await request(userId, `/api/projects/${unassignedProjectId}/export/json`);
    assert.equal(response.status, 404, `${userId} must not export an unassigned project`);
  }

  const unknownProjectResponse = await request(adminUserId, `/api/projects/${assignedProjectId + 999999}`);
  assert.equal(unknownProjectResponse.status, 404, "unknown project IDs must not reveal project existence");
});

test("prevents view-only and removed members from changing rosters or photo files", async () => {
  const readOnlyUsers = [photographerUserId, viewerUserId, removedUserId];
  const rosterHeaders = { "Content-Type": "application/json" };

  for (const userId of readOnlyUsers) {
    assert.equal((await request(userId, `/api/projects/${assignedProjectId}/classes`, {
      method: "POST", headers: rosterHeaders, body: JSON.stringify({ className: `Blocked class ${suffix}` }),
    })).status, 404);
    assert.equal((await request(userId, `/api/projects/${assignedProjectId}/students`, {
      method: "POST", headers: rosterHeaders, body: JSON.stringify({ classId: 1, firstName: "Blocked", lastName: "Student" }),
    })).status, 404);
    assert.equal((await request(userId, `/api/projects/${assignedProjectId}/students/${assignedStudentId}`, {
      method: "PATCH", headers: rosterHeaders, body: JSON.stringify({ firstName: "Blocked" }),
    })).status, 404);
    assert.equal((await request(userId, `/api/projects/${assignedProjectId}/students/${assignedStudentId}`, {
      method: "DELETE",
    })).status, 404);
    assert.equal((await request(userId, `/api/projects/${assignedProjectId}/students/bulk-delete`, {
      method: "POST", headers: rosterHeaders, body: JSON.stringify({ studentIds: [assignedStudentId] }),
    })).status, 404);
    assert.equal((await request(userId, `/api/projects/${assignedProjectId}/students/generate-qr`, {
      method: "POST", headers: rosterHeaders, body: JSON.stringify({ studentIds: [assignedStudentId] }),
    })).status, 404);
  }

  const assistantClassResponse = await request(assistantUserId, `/api/projects/${assignedProjectId}/classes`, {
    method: "POST", headers: rosterHeaders, body: JSON.stringify({ className: `Assistant class ${suffix}` }),
  });
  assert.equal(assistantClassResponse.status, 201, "assistants can prepare assigned rosters");
  const assistantClass = await readJson<{ id: number }>(assistantClassResponse);
  assert.equal((await request(assistantUserId, `/api/projects/${assignedProjectId}/classes/${assistantClass.id}`, {
    method: "PATCH", headers: rosterHeaders, body: JSON.stringify({ className: `Updated assistant class ${suffix}` }),
  })).status, 200);
  assert.equal((await request(assistantUserId, `/api/projects/${assignedProjectId}/classes/${assistantClass.id}`, {
    method: "DELETE",
  })).status, 204);

  const photoListPath = `/api/projects/${assignedProjectId}/students/${assignedStudentId}/photos`;
  for (const userId of [ownerUserId, adminUserId, assistantUserId, photographerUserId, viewerUserId]) {
    const listResponse = await request(userId, photoListPath);
    assert.equal(listResponse.status, 200, "assigned members should see assigned project photos");
    const photos = await readJson<{ id: number }[]>(listResponse);
    assert(photos.some((photo) => photo.id === readablePhotoId));

    const fileResponse = await request(userId, `${photoListPath}/${readablePhotoId}/file`);
    assert.equal(fileResponse.status, 200, "assigned members should read assigned photo files");
  }

  for (const userId of [assistantUserId, photographerUserId, viewerUserId, removedUserId]) {
    assert.equal((await request(userId, `/api/projects/${unassignedProjectId}/students/${assignedStudentId}/photos`)).status, 404);
    assert.equal((await request(userId, `/api/projects/${unassignedProjectId}/students/${assignedStudentId}/photos/${readablePhotoId}/file`)).status, 404);
    assert.equal((await request(userId, `/api/projects/${unassignedProjectId}/students/${assignedStudentId}/photos/${readablePhotoId}`, {
      method: "DELETE",
    })).status, 404);
  }

  assert.equal((await request(removedUserId, photoListPath)).status, 404, "removed former project creators cannot read photos");
  assert.equal((await request(viewerUserId, `${photoListPath}/${deletablePhotoId}`, { method: "DELETE" })).status, 404);
  assert.equal((await request(photographerUserId, `${photoListPath}/${deletablePhotoId}`, { method: "DELETE" })).status, 204);
  const [deletedPhoto] = await db.select({ id: studentPhotosTable.id }).from(studentPhotosTable).where(eq(studentPhotosTable.id, deletablePhotoId));
  assert.equal(deletedPhoto, undefined, "a shoot-capable member can delete a photo from an assigned project");
});