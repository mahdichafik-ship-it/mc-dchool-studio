import { Router } from "express";
import { db } from "@workspace/db";
import { projectsTable, classesTable, studentsTable } from "@workspace/db";
import { eq, inArray, countDistinct, count } from "drizzle-orm";
import { requireAuth, getUserId } from "../lib/auth";
import { accessibleProjectIds } from "../lib/studioAccess";

const router = Router();

// GET /api/dashboard/stats
router.get("/stats", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const ids = await accessibleProjectIds(userId);
  if (!ids.length) { res.json({ totalProjects: 0, totalSchools: 0, totalClasses: 0, totalStudents: 0 }); return; }

  const [projectCount] = await db
    .select({ count: count() })
    .from(projectsTable)
    .where(inArray(projectsTable.id, ids));

  const [schoolCount] = await db
    .select({ count: countDistinct(projectsTable.schoolName) })
    .from(projectsTable)
    .where(inArray(projectsTable.id, ids));

  const classCount = await db
    .select({ count: count() })
    .from(classesTable)
    .innerJoin(projectsTable, eq(classesTable.projectId, projectsTable.id))
    .where(inArray(projectsTable.id, ids));

  const studentCount = await db
    .select({ count: count() })
    .from(studentsTable)
    .innerJoin(projectsTable, eq(studentsTable.projectId, projectsTable.id))
    .where(inArray(projectsTable.id, ids));

  res.json({
    totalProjects: projectCount.count,
    totalSchools: schoolCount.count,
    totalClasses: classCount[0]?.count ?? 0,
    totalStudents: studentCount[0]?.count ?? 0,
  });
});

export default router;
