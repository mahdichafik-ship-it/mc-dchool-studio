import { Router } from "express";
import { db } from "@workspace/db";
import { projectsTable, classesTable, studentsTable } from "@workspace/db";
import { eq, sql, countDistinct, count } from "drizzle-orm";
import { requireAuth, getUserId } from "../lib/auth";

const router = Router();

// GET /api/dashboard/stats
router.get("/stats", requireAuth, async (req, res) => {
  const userId = getUserId(req);

  const [projectCount] = await db
    .select({ count: count() })
    .from(projectsTable)
    .where(eq(projectsTable.userId, userId));

  const [schoolCount] = await db
    .select({ count: countDistinct(projectsTable.schoolName) })
    .from(projectsTable)
    .where(eq(projectsTable.userId, userId));

  const classCount = await db
    .select({ count: count() })
    .from(classesTable)
    .innerJoin(projectsTable, eq(classesTable.projectId, projectsTable.id))
    .where(eq(projectsTable.userId, userId));

  const studentCount = await db
    .select({ count: count() })
    .from(studentsTable)
    .innerJoin(projectsTable, eq(studentsTable.projectId, projectsTable.id))
    .where(eq(projectsTable.userId, userId));

  res.json({
    totalProjects: projectCount.count,
    totalSchools: schoolCount.count,
    totalClasses: classCount[0]?.count ?? 0,
    totalStudents: studentCount[0]?.count ?? 0,
  });
});

export default router;
