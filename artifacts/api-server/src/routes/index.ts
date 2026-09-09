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
import platformRouter from "./platform";
import studioRouter from "./studio";
import groupsRouter from "./groups";

const router = Router();

router.use(healthRouter);
router.use("/dashboard", dashboardRouter);
router.use("/projects", projectsRouter);
router.use("/projects/:projectId/classes", classesRouter);
router.use("/projects/:projectId/groups", groupsRouter);
router.use("/projects/:projectId/students", studentsRouter);
router.use("/projects/:projectId/import", importRouter);
router.use("/projects/:projectId/export", exportRouter);
// Photos: /api/projects/:projectId/students/:studentId/photos
router.use("/projects/:projectId/students", photosRouter);
// Desktop app sync and browser-based sign-in
router.use("/desktop", desktopRouter);
// Desktop group capture multipart uploads (the route itself is desktop-token authenticated).
router.use("/desktop", photosRouter);
router.use("/team", teamRouter);
router.use("/platform", platformRouter);
router.use("/studio", studioRouter);

export default router;
