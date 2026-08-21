import { Router } from "express";
import healthRouter from "./health";
import dashboardRouter from "./dashboard";
import projectsRouter from "./projects";
import classesRouter from "./classes";
import studentsRouter from "./students";
import importRouter from "./import";
import exportRouter from "./export";
import photosRouter from "./photos";
import desktopRouter from "./desktop";
import teamRouter from "./team";

const router = Router();

router.use(healthRouter);
router.use("/dashboard", dashboardRouter);
router.use("/projects", projectsRouter);
router.use("/projects/:projectId/classes", classesRouter);
router.use("/projects/:projectId/students", studentsRouter);
router.use("/projects/:projectId/import", importRouter);
router.use("/projects/:projectId/export", exportRouter);
// Photos: /api/projects/:projectId/students/:studentId/photos
router.use("/projects/:projectId/students", photosRouter);
// Desktop app sync (upload-key auth, no Clerk)
router.use("/desktop", desktopRouter);
router.use("/team", teamRouter);

export default router;
