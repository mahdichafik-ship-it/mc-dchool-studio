import { strict as assert } from "node:assert";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test, { after, before } from "node:test";
import express from "express";
import { eq } from "drizzle-orm";
import {
  db,
  platformInvitesTable,
  pool,
  projectsTable,
  studioMembersTable,
  studioStorageConnectionsTable,
  studiosTable,
} from "@workspace/db";
import platformRouter from "../src/routes/platform";
import projectsRouter from "../src/routes/projects";
import studioRouter from "../src/routes/studio";
import { decryptStorageValue, encryptStorageValue } from "../src/lib/storageCrypto";

process.env.CLERK_SECRET_KEY = "";
process.env.SESSION_SECRET ||= "integration-test-session-secret-at-least-32-characters";
const suffix = `${process.pid}-${Date.now()}`;
process.env.PLATFORM_OWNER_USER_ID = `platform-owner-${suffix}`;

const platformOwnerId = process.env.PLATFORM_OWNER_USER_ID;
const inviteeId = `studio-owner-${suffix}`;
const otherUserId = `other-user-${suffix}`;
const studioViewerId = `studio-viewer-${suffix}`;
const inviteeEmail = `${inviteeId}@member.local`;

let server: Server;
let baseUrl: string;
let inviteId: number;
let inviteCode: string;
let onboardedStudioId: number;
let isolatedStudioId: number;
let isolatedProjectId: number;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const userId = req.header("x-test-user") ?? platformOwnerId;
  const authHandler = Object.assign(
    () => ({ tokenType: "session_token", userId, sessionClaims: { userId } }),
    { [Symbol.for("@clerk/express.auth")]: true },
  );
  (req as any).auth = authHandler;
  next();
});
app.use("/api/platform", platformRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/studio", studioRouter);

async function request(userId: string, pathname: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-test-user", userId);
  return fetch(`${baseUrl}${pathname}`, { ...init, headers });
}

before(async () => {
  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (inviteId) await db.delete(platformInvitesTable).where(eq(platformInvitesTable.id, inviteId));
  if (isolatedStudioId) await db.delete(studiosTable).where(eq(studiosTable.id, isolatedStudioId));
  if (onboardedStudioId) await db.delete(studiosTable).where(eq(studiosTable.id, onboardedStudioId));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await pool.end();
});

test("only the configured platform owner can view the platform workspace", async () => {
  const forbidden = await request(otherUserId, "/api/platform");
  assert.equal(forbidden.status, 403);

  const allowed = await request(platformOwnerId, "/api/platform");
  assert.equal(allowed.status, 200);
  const body = await allowed.json() as {
    configured: boolean;
    healthSummary: {
      totalStudios: number;
      healthyStudios: number;
      attentionStudios: number;
      criticalStudios: number;
      archivedStudios: number;
    };
    studios: unknown[];
    projects: unknown[];
    invites: unknown[];
  };
  assert.equal(body.configured, true);
  assert.equal(body.healthSummary.totalStudios, body.studios.length);
  assert.equal(
    body.healthSummary.healthyStudios
      + body.healthSummary.attentionStudios
      + body.healthSummary.criticalStudios,
    body.healthSummary.totalStudios,
  );
  assert.ok(Array.isArray(body.studios));
  assert.ok(Array.isArray(body.projects));
  assert.ok(Array.isArray(body.invites));
});

test("encrypts storage credentials with authenticated encryption", () => {
  const encrypted = encryptStorageValue({
    accessToken: "access-token-value",
    refreshToken: "refresh-token-value",
  });
  assert.doesNotMatch(encrypted, /access-token-value|refresh-token-value/);
  assert.deepEqual(decryptStorageValue(encrypted), {
    accessToken: "access-token-value",
    refreshToken: "refresh-token-value",
  });
  const tampered = encrypted.replace(/"ciphertext":"./, '"ciphertext":"A');
  assert.throws(() => decryptStorageValue(tampered));
});

test("creates one-time owner invites and onboards the invited account", async () => {
  const created = await request(platformOwnerId, "/api/platform/invites", {
    method: "POST",
    body: JSON.stringify({ email: inviteeEmail }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(created.status, 201);
  const invite = await created.json() as { id: number; code: string; status: string };
  inviteId = invite.id;
  inviteCode = invite.code;
  assert.equal(invite.status, "pending");

  const duplicate = await request(platformOwnerId, "/api/platform/invites", {
    method: "POST",
    body: JSON.stringify({ email: inviteeEmail.toUpperCase() }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(duplicate.status, 409);

  const publicDetails = await request(otherUserId, `/api/platform/invites/${inviteCode}`);
  assert.equal(publicDetails.status, 200);
  assert.equal((await publicDetails.json() as { email: string }).email, inviteeEmail);

  const completed = await request(inviteeId, `/api/platform/invites/${inviteCode}/complete`, {
    method: "POST",
    body: JSON.stringify({
      name: "North Star School Photography",
      description: "Organized school portraits.",
      website: "https://north-star.example",
    }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(completed.status, 201);
  const studio = await completed.json() as { id: number; name: string };
  onboardedStudioId = studio.id;
  assert.equal(studio.name, "North Star School Photography");

  const repeated = await request(inviteeId, `/api/platform/invites/${inviteCode}/complete`, {
    method: "POST",
    body: JSON.stringify({ name: "Should Not Replace Studio" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(repeated.status, 409);

  const forbiddenUpdate = await request(inviteeId, `/api/platform/studios/${onboardedStudioId}`, {
    method: "PATCH",
    body: JSON.stringify({ description: "Should remain unchanged" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(forbiddenUpdate.status, 403);

  const invalidUpdate = await request(platformOwnerId, `/api/platform/studios/${onboardedStudioId}`, {
    method: "PATCH",
    body: JSON.stringify({ contactEmail: "not-an-email" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(invalidUpdate.status, 400);

  const invalidWebsite = await request(platformOwnerId, `/api/platform/studios/${onboardedStudioId}`, {
    method: "PATCH",
    body: JSON.stringify({ website: "ftp://north-star.example" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(invalidWebsite.status, 400);

  const updated = await request(platformOwnerId, `/api/platform/studios/${onboardedStudioId}`, {
    method: "PATCH",
    body: JSON.stringify({
      description: "Updated studio description.",
      website: "https://north-star-school.example",
      contactEmail: "hello@north-star.example",
    }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(updated.status, 200);
  const updatedStudio = await updated.json() as {
    name: string;
    description: string | null;
    website: string | null;
    contactEmail: string | null;
  };
  assert.deepEqual(
    [updatedStudio.name, updatedStudio.description, updatedStudio.website, updatedStudio.contactEmail],
    ["North Star School Photography", "Updated studio description.", "https://north-star-school.example", "hello@north-star.example"],
  );

  const [persistedStudio] = await db.select().from(studiosTable).where(eq(studiosTable.id, onboardedStudioId));
  assert.equal(persistedStudio.contactEmail, "hello@north-star.example");
  assert.equal(persistedStudio.website, "https://north-star-school.example");

  const members = await db.select().from(studioMembersTable).where(eq(studioMembersTable.studioId, onboardedStudioId));
  assert.deepEqual(members.map((member) => [member.userId, member.role]), [[inviteeId, "owner"]]);
});

test("keeps platform storage active while a studio-owned connection is pending", async () => {
  const initial = await request(inviteeId, "/api/studio");
  assert.equal(initial.status, 200);
  const initialBody = await initial.json() as {
    studio: { storageProvider: string; storageStatus: string };
    activeStorageProvider: string;
  };
  assert.equal(initialBody.studio.storageStatus, "needs_setup");
  assert.equal(initialBody.activeStorageProvider, "platform_google_drive");

  const requested = await request(inviteeId, "/api/studio/storage", {
    method: "PUT",
    body: JSON.stringify({ provider: "google_drive" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(requested.status, 200);
  const requestedBody = await requested.json() as {
    studio: { storageProvider: string; storageStatus: string; storageRequestedAt: string | null };
    activeStorageProvider: string;
  };
  assert.equal(requestedBody.studio.storageProvider, "google_drive");
  assert.equal(requestedBody.studio.storageStatus, "connection_requested");
  assert.ok(requestedBody.studio.storageRequestedAt);
  assert.equal(requestedBody.activeStorageProvider, "platform_google_drive");

  const platformHealth = await request(platformOwnerId, "/api/platform");
  assert.equal(platformHealth.status, 200);
  const platformHealthBody = await platformHealth.json() as {
    studios: Array<{
      id: number;
      health: {
        severity: string;
        alerts: Array<{ code: string; label: string; severity: string }>;
      };
    }>;
  };
  const studioHealth = platformHealthBody.studios.find((studio) => studio.id === onboardedStudioId)?.health;
  assert.equal(studioHealth?.severity, "attention");
  assert.ok(studioHealth?.alerts.some((alert) => alert.code === "storage_pending"));

  await db.insert(studioMembersTable).values({
    studioId: onboardedStudioId,
    userId: studioViewerId,
    email: `${studioViewerId}@member.local`,
    role: "viewer",
  });
  const forbidden = await request(studioViewerId, "/api/studio/storage", {
    method: "PUT",
    body: JSON.stringify({ provider: "dropbox" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(forbidden.status, 403);

  const fallback = await request(inviteeId, "/api/studio/storage", {
    method: "PUT",
    body: JSON.stringify({ provider: "platform_google_drive" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(fallback.status, 200);
  const fallbackBody = await fallback.json() as {
    studio: { storageProvider: string; storageStatus: string; storageRequestedAt: string | null };
    activeStorageProvider: string;
  };
  assert.equal(fallbackBody.studio.storageProvider, "platform_google_drive");
  assert.equal(fallbackBody.studio.storageStatus, "using_platform");
  assert.equal(fallbackBody.studio.storageRequestedAt, null);
  assert.equal(fallbackBody.activeStorageProvider, "platform_google_drive");
});

test("lets studio managers save branding while keeping viewers read-only", async () => {
  const invalid = await request(inviteeId, "/api/studio/branding", {
    method: "PATCH",
    body: JSON.stringify({
      name: "North Star School Photography",
      tagline: "Portrait day, beautifully organized",
      website: "https://north-star-school.example",
      contactEmail: "hello@north-star.example",
      logoObjectPath: null,
      primaryColor: "teal",
      accentColor: "#F59E0B",
    }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(invalid.status, 400);

  const updated = await request(inviteeId, "/api/studio/branding", {
    method: "PATCH",
    body: JSON.stringify({
      name: "North Star School Photography",
      tagline: "Portrait day, beautifully organized",
      website: "https://north-star-school.example",
      contactEmail: "BRAND@NORTH-STAR.EXAMPLE",
      logoObjectPath: null,
      primaryColor: "#123456",
      accentColor: "#F59E0B",
    }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(updated.status, 200);
  const updatedBody = await updated.json() as {
    studio: { tagline: string; contactEmail: string; primaryColor: string; accentColor: string };
  };
  assert.equal(updatedBody.studio.tagline, "Portrait day, beautifully organized");
  assert.equal(updatedBody.studio.contactEmail, "brand@north-star.example");
  assert.equal(updatedBody.studio.primaryColor, "#123456");
  assert.equal(updatedBody.studio.accentColor, "#F59E0B");

  const uploadRequest = await request(inviteeId, "/api/studio/branding/logo-upload-url", {
    method: "POST",
    body: JSON.stringify({ name: "studio-logo.png", size: 1024, contentType: "image/png" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(uploadRequest.status, 200);
  const uploadBody = await uploadRequest.json() as { uploadUrl: string; objectPath: string };
  assert.match(uploadBody.uploadUrl, /^https?:\/\//);
  assert.match(uploadBody.objectPath, new RegExp(`/branding/studios/${onboardedStudioId}/`));

  const invalidUpload = await request(inviteeId, "/api/studio/branding/logo-upload-url", {
    method: "POST",
    body: JSON.stringify({ name: "unsafe.svg", size: 1024, contentType: "image/svg+xml" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(invalidUpload.status, 400);

  const persisted = await request(inviteeId, "/api/studio");
  assert.equal(persisted.status, 200);
  const persistedBody = await persisted.json() as {
    studio: { tagline: string; primaryColor: string; accentColor: string };
  };
  assert.equal(persistedBody.studio.tagline, "Portrait day, beautifully organized");
  assert.equal(persistedBody.studio.primaryColor, "#123456");

  const forbidden = await request(studioViewerId, "/api/studio/branding", {
    method: "PATCH",
    body: JSON.stringify({
      name: "Viewer must not rename the studio",
      tagline: "",
      website: "",
      contactEmail: "",
      logoObjectPath: null,
      primaryColor: "#000000",
      accentColor: "#FFFFFF",
    }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(forbidden.status, 403);
});

test("rejects email mismatches and keeps studios isolated", async () => {
  const invalid = await request(otherUserId, "/api/platform/invites/does-not-exist");
  assert.equal(invalid.status, 404);

  const created = await request(platformOwnerId, "/api/platform/invites", {
    method: "POST",
    body: JSON.stringify({ email: `different-owner-${suffix}@member.local` }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(created.status, 201);
  const invite = await created.json() as { id: number; code: string };

  const mismatch = await request(otherUserId, `/api/platform/invites/${invite.code}/complete`, {
    method: "POST",
    body: JSON.stringify({ name: "Blocked Studio" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(mismatch.status, 403);

  const cancelledCreated = await request(platformOwnerId, "/api/platform/invites", {
    method: "POST",
    body: JSON.stringify({ email: `cancelled-owner-${suffix}@member.local` }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(cancelledCreated.status, 201);
  const cancelledInvite = await cancelledCreated.json() as { id: number; code: string };
  const cancelled = await request(platformOwnerId, `/api/platform/invites/${cancelledInvite.id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "cancelled" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json() as { status: string }).status, "cancelled");
  const cancelledComplete = await request(otherUserId, `/api/platform/invites/${cancelledInvite.code}/complete`, {
    method: "POST",
    body: JSON.stringify({ name: "Cancelled Studio" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(cancelledComplete.status, 409);

  const [isolatedStudio] = await db.insert(studiosTable).values({
    name: "Separate Existing Studio",
    createdByUserId: otherUserId,
  }).returning({ id: studiosTable.id });
  isolatedStudioId = isolatedStudio.id;
  const [project] = await db.insert(projectsTable).values({
    userId: otherUserId,
    studioId: isolatedStudioId,
    schoolName: "Separate School",
  }).returning({ id: projectsTable.id });
  isolatedProjectId = project.id;
  await db.insert(studioMembersTable).values({
    studioId: isolatedStudioId,
    userId: otherUserId,
    email: `${otherUserId}@member.local`,
    role: "owner",
  });

  const platformProjects = await request(platformOwnerId, "/api/projects");
  assert.equal(platformProjects.status, 200);
  assert.ok((await platformProjects.json() as { id: number }[]).some((item) => item.id === isolatedProjectId));

  const platformOverview = await request(platformOwnerId, "/api/platform");
  assert.equal(platformOverview.status, 200);
  const overviewBody = await platformOverview.json() as {
    projects: { id: number; studioId: number | null; studioName: string | null }[];
  };
  const overviewProjects = overviewBody.projects;
  assert.ok(overviewProjects.some((item) => item.id === isolatedProjectId && item.studioId === isolatedStudioId && item.studioName === "Separate Existing Studio"));

  const platformProject = await request(platformOwnerId, `/api/projects/${isolatedProjectId}`);
  assert.equal(platformProject.status, 200);
  const platformUpdate = await request(platformOwnerId, `/api/projects/${isolatedProjectId}`, {
    method: "PATCH",
    body: JSON.stringify({ notes: "Managed by the platform owner" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(platformUpdate.status, 200);
  assert.equal((await platformUpdate.json() as { notes: string }).notes, "Managed by the platform owner");

  const otherProjects = await request(otherUserId, "/api/projects");
  assert.equal(otherProjects.status, 200);
  assert.deepEqual((await otherProjects.json() as { id: number }[]).map((item) => item.id), [isolatedProjectId]);

  await db.delete(platformInvitesTable).where(eq(platformInvitesTable.id, invite.id));
  await db.delete(platformInvitesTable).where(eq(platformInvitesTable.id, cancelledInvite.id));
});

test("never exposes or selects another studio's storage connection", async () => {
  await db.insert(studioStorageConnectionsTable).values([
    {
      studioId: onboardedStudioId,
      provider: "google_drive",
      providerAccountId: `google-${suffix}`,
      providerAccountEmail: `north-star-${suffix}@example.com`,
      encryptedCredentials: "encrypted-north-star-credential",
      status: "active",
    },
    {
      studioId: isolatedStudioId,
      provider: "google_drive",
      providerAccountId: `google-other-${suffix}`,
      providerAccountEmail: `separate-${suffix}@example.com`,
      encryptedCredentials: "encrypted-separate-credential",
      status: "active",
    },
  ]);
  await db.update(studiosTable).set({
    storageProvider: "google_drive",
    storageStatus: "connected",
    storageConnectedAt: new Date(),
  }).where(eq(studiosTable.id, onboardedStudioId));
  await db.update(studiosTable).set({
    storageProvider: "google_drive",
    storageStatus: "connected",
    storageConnectedAt: new Date(),
  }).where(eq(studiosTable.id, isolatedStudioId));

  const northStar = await request(inviteeId, "/api/studio");
  assert.equal(northStar.status, 200);
  const northStarBody = await northStar.json() as {
    connections: Array<{ providerAccountEmail: string }>;
  };
  assert.deepEqual(
    northStarBody.connections.map((connection) => connection.providerAccountEmail),
    [`north-star-${suffix}@example.com`],
  );
  assert.doesNotMatch(JSON.stringify(northStarBody), /encrypted-.*-credential/);

  const separate = await request(otherUserId, "/api/studio");
  assert.equal(separate.status, 200);
  const separateBody = await separate.json() as {
    connections: Array<{ providerAccountEmail: string }>;
  };
  assert.deepEqual(
    separateBody.connections.map((connection) => connection.providerAccountEmail),
    [`separate-${suffix}@example.com`],
  );
  assert.doesNotMatch(JSON.stringify(separateBody), /encrypted-.*-credential/);

  const viewer = await request(studioViewerId, "/api/studio");
  assert.equal(viewer.status, 200);
  assert.deepEqual((await viewer.json() as { connections: unknown[] }).connections, []);
});

test("lets the platform owner audit and control one studio without leaking credentials", async () => {
  const detail = await request(platformOwnerId, `/api/platform/studios/${onboardedStudioId}`);
  assert.equal(detail.status, 200);
  const detailBody = await detail.json() as {
    studio: { id: number };
    members: Array<{ id: number; userId: string; status: string }>;
    storageConnections: Array<Record<string, unknown>>;
    platformAudit: unknown[];
  };
  assert.equal(detailBody.studio.id, onboardedStudioId);
  assert.ok(detailBody.members.some((member) => member.userId === inviteeId));
  assert.doesNotMatch(JSON.stringify(detailBody.storageConnections), /encryptedCredentials|encrypted-north-star-credential/);

  const target = detailBody.members.find((member) => member.userId === inviteeId)!;
  const suspended = await request(platformOwnerId, `/api/platform/studios/${onboardedStudioId}/members/${target.id}/access`, {
    method: "PATCH",
    body: JSON.stringify({ status: "removed" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(suspended.status, 200);
  assert.equal((await request(inviteeId, "/api/studio")).status, 404);

  const restoredMember = await request(platformOwnerId, `/api/platform/studios/${onboardedStudioId}/members/${target.id}/access`, {
    method: "PATCH",
    body: JSON.stringify({ status: "active" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(restoredMember.status, 200);
  assert.equal((await request(inviteeId, "/api/studio")).status, 200);

  const archived = await request(platformOwnerId, `/api/platform/studios/${onboardedStudioId}/lifecycle`, {
    method: "PATCH",
    body: JSON.stringify({ action: "archive", reason: "Integration audit hold" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(archived.status, 200);
  assert.equal((await request(inviteeId, "/api/studio")).status, 404);
  assert.equal((await request(platformOwnerId, `/api/platform/studios/${onboardedStudioId}`)).status, 200);

  const restoredStudio = await request(platformOwnerId, `/api/platform/studios/${onboardedStudioId}/lifecycle`, {
    method: "PATCH",
    body: JSON.stringify({ action: "restore" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(restoredStudio.status, 200);
  assert.equal((await request(inviteeId, "/api/studio")).status, 200);

  const refreshedDetail = await request(platformOwnerId, `/api/platform/studios/${onboardedStudioId}`);
  const refreshedBody = await refreshedDetail.json() as { platformAudit: Array<{ action: string }> };
  assert.ok(refreshedBody.platformAudit.some((entry) => entry.action === "member_suspended"));
  assert.ok(refreshedBody.platformAudit.some((entry) => entry.action === "studio_archived"));
  assert.ok(refreshedBody.platformAudit.some((entry) => entry.action === "studio_restored"));
});