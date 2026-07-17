import { Router } from "express";
import JSZip from "jszip";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { db } from "@workspace/db";
import { projectsTable, classesTable, studentsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, getUserId } from "../lib/auth";
import { generateSimpleQr, generateJsonQr } from "../lib/qrcode";

const router = Router({ mergeParams: true });

async function verifyProject(projectId: number, userId: string) {
  const [project] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)));
  return project ?? null;
}

// GET /api/projects/:projectId/export/zip
router.get("/zip", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const projectId = parseInt(req.params.projectId as string);

  const project = await verifyProject(projectId, userId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const rows = await db
    .select({ student: studentsTable, className: classesTable.className })
    .from(studentsTable)
    .innerJoin(classesTable, eq(studentsTable.classId, classesTable.id))
    .where(eq(studentsTable.projectId, projectId))
    .orderBy(classesTable.className, studentsTable.lastName);

  const zip = new JSZip();

  for (const { student, className } of rows) {
    // Use simple QR data URL or generate on the fly
    let qrDataUrl = student.simpleQr;
    if (!qrDataUrl) {
      qrDataUrl = await generateSimpleQr(
        student.firstName,
        student.lastName,
        student.generatedStudentId,
      );
    }

    // Convert data URL to buffer
    const base64Data = qrDataUrl.replace(/^data:image\/png;base64,/, "");
    const buf = Buffer.from(base64Data, "base64");

    const filename = `${student.firstName}_${student.lastName}_${student.generatedStudentId}.png`;
    zip.file(filename, buf);
  }

  const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

  const safeName = project.schoolName.replace(/[^a-z0-9]/gi, "_");
  res.set("Content-Type", "application/zip");
  res.set("Content-Disposition", `attachment; filename="${safeName}_QR_Codes.zip"`);
  res.send(zipBuffer);
});

// GET /api/projects/:projectId/export/pdf
router.get("/pdf", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const projectId = parseInt(req.params.projectId as string);

  const project = await verifyProject(projectId, userId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const rows = await db
    .select({ student: studentsTable, className: classesTable.className })
    .from(studentsTable)
    .innerJoin(classesTable, eq(studentsTable.classId, classesTable.id))
    .where(eq(studentsTable.projectId, projectId))
    .orderBy(classesTable.className, studentsTable.lastName, studentsTable.firstName);

  const doc = new PDFDocument({ size: "A4", margin: 50, autoFirstPage: false });

  const safeName = project.schoolName.replace(/[^a-z0-9]/gi, "_");
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", `attachment; filename="${safeName}_QR_Codes.pdf"`);

  doc.pipe(res);

  for (const { student, className } of rows) {
    doc.addPage();

    // School name at top
    doc.fontSize(18).font("Helvetica-Bold").text(project.schoolName, { align: "center" });
    doc.moveDown(0.5);

    // Class name
    doc.fontSize(14).font("Helvetica").text(className, { align: "center" });
    doc.moveDown(1);

    // Student name
    doc.fontSize(22).font("Helvetica-Bold")
      .text(`${student.firstName} ${student.lastName}`, { align: "center" });
    doc.moveDown(0.5);

    // Student ID
    doc.fontSize(14).font("Helvetica").text(`ID: ${student.generatedStudentId}`, { align: "center" });
    doc.moveDown(2);

    // QR code (large, centered)
    let qrDataUrl = student.simpleQr;
    if (!qrDataUrl) {
      qrDataUrl = await generateSimpleQr(
        student.firstName,
        student.lastName,
        student.generatedStudentId,
      );
    }

    const base64Data = qrDataUrl.replace(/^data:image\/png;base64,/, "");
    const qrBuf = Buffer.from(base64Data, "base64");

    const qrSize = 300;
    const pageWidth = doc.page.width - 100; // margins
    const x = (pageWidth - qrSize) / 2 + 50;

    doc.image(qrBuf, x, doc.y, { width: qrSize, height: qrSize });
  }

  doc.end();
});

export default router;
