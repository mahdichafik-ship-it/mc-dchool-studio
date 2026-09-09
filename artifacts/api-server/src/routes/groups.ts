import { Router } from "express";
import { db } from "@workspace/db";
import { groupCaptureFilesTable, groupCapturesTable, groupMemberExclusionsTable, groupMembersTable, groupsTable, studentsTable, classesTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { requireAuth, getUserId } from "../lib/auth";
import { canAccessProject } from "../lib/studioAccess";
import { reconcileDefaultGroups } from "../lib/groupReconciliation";
import { defaultGroupExclusionChanges } from "../lib/groupMembership";

const router = Router({ mergeParams: true });
function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
async function access(projectId: number, userId: string, edit = false) {
  return canAccessProject(userId, projectId, edit ? "edit" : "view");
}
async function getGroup(projectId: number, groupId: number) {
  const [group] = await db.select().from(groupsTable).where(and(eq(groupsTable.id, groupId), eq(groupsTable.projectId, projectId)));
  return group;
}
async function validClass(projectId: number, classId: number | null | undefined) {
  if (classId == null) return true;
  const [row] = await db.select({ id: classesTable.id }).from(classesTable).where(and(eq(classesTable.id, classId), eq(classesTable.projectId, projectId)));
  return !!row;
}
function serialize(value: any) {
  return value instanceof Date ? value.toISOString() : value;
}
function output(group: any, members: any[] = []) {
  return { ...group, createdAt: serialize(group.createdAt), updatedAt: serialize(group.updatedAt), members };
}

router.get("/", requireAuth, async (req, res) => {
  const projectId = Number(req.params.projectId);
  if (!positiveId(projectId)) return void res.status(400).json({ error: "Invalid projectId" });
  if (!(await access(projectId, getUserId(req)))) return void res.status(404).json({ error: "Project not found" });
  await reconcileDefaultGroups(projectId);
  const groups = await db.select().from(groupsTable).where(eq(groupsTable.projectId, projectId));
  const members = await db.select().from(groupMembersTable).where(inArray(groupMembersTable.groupId, groups.map(g => g.id)));
  res.json(groups.map(g => output(g, members.filter(m => m.groupId === g.id))));
});

router.post("/", requireAuth, async (req, res) => {
  const projectId = Number(req.params.projectId);
  if (!positiveId(projectId)) return void res.status(400).json({ error: "Invalid projectId" });
  if (!(await access(projectId, getUserId(req), true))) return void res.status(404).json({ error: "Project not found" });
  const { name, classId } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) return void res.status(400).json({ error: "name is required" });
  if (classId !== undefined && (!Number.isInteger(classId) || !(await validClass(projectId, classId)))) return void res.status(400).json({ error: "classId is not in this project" });
  const [group] = await db.insert(groupsTable).values({ projectId, name: name.trim(), classId: classId ?? null, isDefaultClassGroup: false }).returning();
  res.status(201).json(output(group));
});

router.patch("/:groupId", requireAuth, async (req, res) => {
  const projectId = Number(req.params.projectId), groupId = Number(req.params.groupId);
  if (!positiveId(projectId) || !positiveId(groupId)) return void res.status(400).json({ error: "Invalid route identifiers" });
  if (!(await access(projectId, getUserId(req), true))) return void res.status(404).json({ error: "Project not found" });
  if (!(await getGroup(projectId, groupId))) return void res.status(404).json({ error: "Group not found" });
  const { name, classId, isDefaultClassGroup } = req.body ?? {};
  const current = await getGroup(projectId, groupId);
  if (current?.isDefaultClassGroup && (name !== undefined || classId !== undefined || isDefaultClassGroup !== undefined)) return void res.status(409).json({ error: "Default group identity is protected" });
  const { memberStudentIds } = req.body ?? {};
  if (classId !== undefined && (!Number.isInteger(classId) || !(await validClass(projectId, classId)))) return void res.status(400).json({ error: "classId is not in this project" });
  if (name !== undefined && (typeof name !== "string" || !name.trim())) return void res.status(400).json({ error: "name must be nonempty" });
  if (memberStudentIds !== undefined) {
    if (!Array.isArray(memberStudentIds) || memberStudentIds.some((id: unknown) => !Number.isInteger(id))) return void res.status(400).json({ error: "Invalid memberStudentIds" });
    const valid = memberStudentIds.length
      ? await db.select({ id: studentsTable.id }).from(studentsTable).where(and(eq(studentsTable.projectId, projectId), inArray(studentsTable.id, memberStudentIds)))
      : [];
    if (valid.length !== memberStudentIds.length) return void res.status(400).json({ error: "Students must belong to this project" });
    const old = await db.select({ studentId: groupMembersTable.studentId }).from(groupMembersTable).where(eq(groupMembersTable.groupId, groupId));
    const removed = old.map((row) => row.studentId).filter((id) => !memberStudentIds.includes(id));
    await db.delete(groupMembersTable).where(eq(groupMembersTable.groupId, groupId));
    if (memberStudentIds.length) await db.insert(groupMembersTable).values(memberStudentIds.map((studentId: number) => ({ groupId, studentId }))).onConflictDoNothing();
    if (current?.isDefaultClassGroup && removed.length) await db.insert(groupMemberExclusionsTable).values(removed.map((studentId) => ({ groupId, studentId }))).onConflictDoNothing();
    if (current?.isDefaultClassGroup && memberStudentIds.length) await db.delete(groupMemberExclusionsTable).where(and(eq(groupMemberExclusionsTable.groupId, groupId), inArray(groupMemberExclusionsTable.studentId, memberStudentIds)));
  }
  const [group] = await db.update(groupsTable).set({
    ...(name !== undefined ? { name: String(name).trim() } : {}),
    ...(classId !== undefined ? { classId: classId ?? null } : {}),
    ...(isDefaultClassGroup !== undefined ? { isDefaultClassGroup: !!isDefaultClassGroup } : {}),
    updatedAt: new Date(),
  }).where(eq(groupsTable.id, groupId)).returning();
  const currentMembers = await db.select().from(groupMembersTable).where(eq(groupMembersTable.groupId, groupId));
  res.json(output(group, currentMembers));
});

router.delete("/:groupId", requireAuth, async (req, res) => {
  const projectId = Number(req.params.projectId), groupId = Number(req.params.groupId);
  if (!positiveId(projectId) || !positiveId(groupId)) return void res.status(400).json({ error: "Invalid route identifiers" });
  if (!(await access(projectId, getUserId(req), true))) return void res.status(404).json({ error: "Project not found" });
  const group = await getGroup(projectId, groupId);
  if (!group) return void res.status(404).json({ error: "Group not found" });
  if (group.isDefaultClassGroup) return void res.status(409).json({ error: "Default groups cannot be deleted" });
  await db.delete(groupsTable).where(eq(groupsTable.id, groupId));
  res.status(204).send();
});

async function members(req: any, res: any, mode: "replace" | "add" | "remove") {
  const projectId = Number(req.params.projectId), groupId = Number(req.params.groupId);
  if (!positiveId(projectId) || !positiveId(groupId)) return void res.status(400).json({ error: "Invalid route identifiers" });
  if (!(await access(projectId, getUserId(req), true))) return res.status(404).json({ error: "Project not found" });
  const group = await getGroup(projectId, groupId);
  const ids = req.body?.studentIds;
  if (!group || !Array.isArray(ids) || ids.some((id: unknown) => !Number.isInteger(id))) return res.status(400).json({ error: "Valid studentIds are required" });
  const valid = ids.length
    ? await db.select({ id: studentsTable.id }).from(studentsTable).where(and(eq(studentsTable.projectId, projectId), inArray(studentsTable.id, ids)))
    : [];
  if (valid.length !== ids.length) return res.status(400).json({ error: "All students must belong to this project" });
  const classStudents = group.isDefaultClassGroup && group.classId
    ? await db.select({ id: studentsTable.id }).from(studentsTable).where(and(
      eq(studentsTable.projectId, projectId),
      eq(studentsTable.classId, group.classId),
    ))
    : [];
  const exclusionChanges = defaultGroupExclusionChanges(mode, ids, classStudents.map((student) => student.id));
  if (mode === "replace") await db.delete(groupMembersTable).where(eq(groupMembersTable.groupId, groupId));
  if (mode === "remove" && ids.length) await db.delete(groupMembersTable).where(and(eq(groupMembersTable.groupId, groupId), inArray(groupMembersTable.studentId, ids)));
  else if (ids.length) await db.insert(groupMembersTable).values(ids.map((studentId: number) => ({ groupId, studentId }))).onConflictDoNothing();
  if (group.isDefaultClassGroup && exclusionChanges.exclude.length) await db.insert(groupMemberExclusionsTable)
    .values(exclusionChanges.exclude.map((studentId) => ({ groupId, studentId }))).onConflictDoNothing();
  if (group.isDefaultClassGroup && exclusionChanges.clear.length) await db.delete(groupMemberExclusionsTable)
    .where(and(eq(groupMemberExclusionsTable.groupId, groupId), inArray(groupMemberExclusionsTable.studentId, exclusionChanges.clear)));
  const result = await db.select().from(groupMembersTable).where(eq(groupMembersTable.groupId, groupId));
  return res.json(result);
}
router.put("/:groupId/members", requireAuth, (req, res) => members(req, res, "replace"));
router.post("/:groupId/members", requireAuth, (req, res) => members(req, res, "add"));
router.delete("/:groupId/members", requireAuth, (req, res) => members(req, res, "remove"));

router.get("/:groupId/captures", requireAuth, async (req, res) => {
  const projectId = Number(req.params.projectId), groupId = Number(req.params.groupId);
  if (!positiveId(projectId) || !positiveId(groupId)) return void res.status(400).json({ error: "Invalid route identifiers" });
  if (!(await access(projectId, getUserId(req)))) return void res.status(404).json({ error: "Project not found" });
  if (!(await getGroup(projectId, groupId))) return void res.status(404).json({ error: "Group not found" });
  const captures = await db.select().from(groupCapturesTable).where(eq(groupCapturesTable.groupId, groupId));
  const files = captures.length ? await db.select().from(groupCaptureFilesTable).where(inArray(groupCaptureFilesTable.captureId, captures.map(c => c.id))) : [];
  res.json(captures.map(c => ({ ...c, files: files.filter(f => f.captureId === c.id) })));
});
router.get("/:groupId/capture-files", requireAuth, async (req, res) => {
  const projectId = Number(req.params.projectId), groupId = Number(req.params.groupId);
  if (!positiveId(projectId) || !positiveId(groupId)) return void res.status(400).json({ error: "Invalid route identifiers" });
  if (!(await access(projectId, getUserId(req)))) return void res.status(404).json({ error: "Project not found" });
  if (!(await getGroup(projectId, groupId))) return void res.status(404).json({ error: "Group not found" });
  const captures = await db.select({ id: groupCapturesTable.id }).from(groupCapturesTable).where(eq(groupCapturesTable.groupId, groupId));
  res.json(captures.length ? await db.select().from(groupCaptureFilesTable).where(inArray(groupCaptureFilesTable.captureId, captures.map(c => c.id))) : []);
});
export default router;