import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  db,
  deliveryGalleriesTable,
  deliveryOrdersTable,
  marketingCampaignsTable,
  marketingContactsTable,
  marketingTemplatesTable,
  marketingVisitsTable,
  projectsTable,
} from "@workspace/db";
import { getUserId, requireAuth } from "../lib/auth";
import { getStudioMember } from "../lib/studioAccess";
import { resendConfiguration, sendResendEmails } from "../lib/resendEmail";

const router = Router();

async function manager(req: Parameters<typeof requireAuth>[0]) {
  const member = await getStudioMember(getUserId(req));
  return member.status === "active" && (member.role === "owner" || member.role === "admin") ? member : null;
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function unsubscribeToken(contactId: number, studioId: number): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required");
  const payload = `${contactId}.${studioId}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function parseUnsubscribeToken(token: unknown): { contactId: number; studioId: number } | null {
  if (typeof token !== "string") return null;
  const [contactRaw, studioRaw, signature] = token.split(".");
  const contactId = Number(contactRaw);
  const studioId = Number(studioRaw);
  if (!Number.isInteger(contactId) || !Number.isInteger(studioId) || !signature) return null;
  const expected = unsubscribeToken(contactId, studioId);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(token);
  if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) return null;
  return { contactId, studioId };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character] ?? character);
}

async function applyUnsubscribe(token: unknown): Promise<boolean> {
  const parsed = parseUnsubscribeToken(token);
  if (!parsed) return false;
  const [contact] = await db.update(marketingContactsTable).set({ unsubscribedAt: new Date() })
    .where(and(
      eq(marketingContactsTable.id, parsed.contactId),
      eq(marketingContactsTable.studioId, parsed.studioId),
    )).returning({ id: marketingContactsTable.id });
  return Boolean(contact);
}

router.get("/marketing/unsubscribe", async (req, res): Promise<void> => {
  const success = await applyUnsubscribe(req.query.token);
  res.status(success ? 200 : 400).type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Email preferences</title></head><body style="font-family:system-ui,sans-serif;margin:48px auto;max-width:560px;padding:0 20px;color:#0f172a"><h1>${success ? "You’re unsubscribed" : "This link is invalid"}</h1><p>${success ? "You will no longer receive promotional emails from this studio." : "The unsubscribe link could not be verified."}</p></body></html>`);
});

router.post("/marketing/unsubscribe", async (req, res): Promise<void> => {
  const success = await applyUnsubscribe(req.query.token);
  if (!success) { res.status(400).json({ error: "Invalid unsubscribe link" }); return; }
  res.status(204).send();
});

type AudienceFilter = {
  consent?: "consented" | "unconsented" | "all";
  engagement?: "visited" | "repeat" | "purchaser" | "all";
  search?: string;
};

function matchesAudience(contact: typeof marketingContactsTable.$inferSelect, filter: AudienceFilter): boolean {
  if (filter.search && !contact.email.includes(filter.search.toLowerCase())) return false;
  if (filter.consent === "consented" && (contact.marketingConsent !== true || contact.unsubscribedAt !== null)) return false;
  if (filter.consent === "unconsented" && contact.marketingConsent === true && contact.unsubscribedAt === null) return false;
  if (filter.engagement === "visited" && contact.successfulGalleryAccesses < 1) return false;
  if (filter.engagement === "repeat" && contact.successfulGalleryAccesses < 2) return false;
  if (filter.engagement === "purchaser" && contact.lastOrderAt === null) return false;
  return true;
}

function contactResponse(
  contact: typeof marketingContactsTable.$inferSelect,
  visits: number,
  purchases: number,
) {
  return {
    id: contact.id,
    studioId: contact.studioId,
    email: contact.email,
    firstSeenAt: contact.firstSeenAt.toISOString(),
    lastSeenAt: contact.lastSeenAt.toISOString(),
    successfulGalleryAccesses: contact.successfulGalleryAccesses,
    marketingConsent: contact.marketingConsent,
    consentAt: iso(contact.consentAt),
    consentSource: contact.consentSource,
    unsubscribedAt: iso(contact.unsubscribedAt),
    lastOrderAt: iso(contact.lastOrderAt),
    identifiedVisits: visits,
    purchases,
  };
}

async function studioData(studioId: number) {
  const [contacts, visits, orders, projects] = await Promise.all([
    db.select().from(marketingContactsTable).where(eq(marketingContactsTable.studioId, studioId)),
    db.select().from(marketingVisitsTable).where(eq(marketingVisitsTable.studioId, studioId)),
    db.select({ order: deliveryOrdersTable, gallery: deliveryGalleriesTable })
      .from(deliveryOrdersTable)
      .innerJoin(deliveryGalleriesTable, eq(deliveryOrdersTable.galleryId, deliveryGalleriesTable.id))
      .where(eq(deliveryGalleriesTable.studioId, studioId)),
    db.select({
      id: projectsTable.id,
      name: projectsTable.schoolName,
      projectType: projectsTable.projectType,
    }).from(projectsTable).where(eq(projectsTable.studioId, studioId)),
  ]);
  return { contacts, visits, orders, projects };
}

router.get("/marketing/overview", requireAuth, async (req, res): Promise<void> => {
  const member = await manager(req);
  if (!member) { res.status(403).json({ error: "Studio owner or admin access is required" }); return; }
  const { contacts, visits, orders, projects: studioProjects } = await studioData(member.studioId);
  const visitsByContact = new Map<number, number>();
  const visitsByProject = new Map<number, { visits: number; contacts: Set<number>; purchasers: Set<number> }>();
  for (const visit of visits) {
    visitsByContact.set(visit.contactId, (visitsByContact.get(visit.contactId) ?? 0) + 1);
    const project = visitsByProject.get(visit.projectId) ?? { visits: 0, contacts: new Set(), purchasers: new Set() };
    project.visits++;
    project.contacts.add(visit.contactId);
    visitsByProject.set(visit.projectId, project);
  }
  const purchasers = new Set<number>();
  for (const item of orders) {
    if (item.order.status !== "paid" || !item.order.contactId) continue;
    purchasers.add(item.order.contactId);
    const project = visitsByProject.get(item.gallery.projectId) ?? { visits: 0, contacts: new Set(), purchasers: new Set() };
    project.purchasers.add(item.order.contactId);
    visitsByProject.set(item.gallery.projectId, project);
  }
  const uniqueContacts = contacts.length;
  const identifiedVisits = visits.length;
  const projectById = new Map(studioProjects.map((project) => [project.id, project]));
  const projects = [...visitsByProject.entries()].map(([projectId, value]) => ({
    projectId,
    projectName: projectById.get(projectId)?.name ?? `Project ${projectId}`,
    projectType: projectById.get(projectId)?.projectType ?? "school",
    identifiedVisits: value.visits,
    uniqueContacts: value.contacts.size,
    purchasers: value.purchasers.size,
    conversionRate: value.contacts.size ? value.purchasers.size / value.contacts.size : 0,
  }));
  res.json({
    uniqueContacts,
    identifiedVisits,
    repeatVisitors: contacts.filter((contact) => contact.successfulGalleryAccesses > 1).length,
    purchasers: purchasers.size,
    conversionRate: uniqueContacts ? purchasers.size / uniqueContacts : 0,
    consentedContacts: contacts.filter((contact) => contact.marketingConsent === true && !contact.unsubscribedAt).length,
    unsubscribedContacts: contacts.filter((contact) => contact.unsubscribedAt !== null).length,
    perProject: projects,
    projects,
  });
});

router.get("/marketing/contacts", requireAuth, async (req, res): Promise<void> => {
  const member = await manager(req);
  if (!member) { res.status(403).json({ error: "Studio owner or admin access is required" }); return; }
  const data = await studioData(member.studioId);
  const filter: AudienceFilter = {
    search: typeof req.query.search === "string" ? req.query.search.trim().toLowerCase() : undefined,
    engagement: ["visited", "repeat", "purchaser", "all"].includes(String(req.query.engagement ?? req.query.engagementFilter))
      ? String(req.query.engagement ?? req.query.engagementFilter) as AudienceFilter["engagement"] : "all",
    consent: ["consented", "unconsented", "all"].includes(String(req.query.consent ?? req.query.consentFilter))
      ? String(req.query.consent ?? req.query.consentFilter) as AudienceFilter["consent"] : "all",
  };
  const filtered = data.contacts.filter((contact) => matchesAudience(contact, filter))
    .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? req.query.limit ?? 25) || 25));
  const page = Math.max(1, Number(req.query.page ?? 1) || 1);
  const start = (page - 1) * pageSize;
  const visitsByContact = new Map<number, number>();
  const purchasesByContact = new Map<number, number>();
  for (const visit of data.visits) visitsByContact.set(visit.contactId, (visitsByContact.get(visit.contactId) ?? 0) + 1);
  for (const row of data.orders) if (row.order.status === "paid" && row.order.contactId) {
    purchasesByContact.set(row.order.contactId, (purchasesByContact.get(row.order.contactId) ?? 0) + 1);
  }
  res.json({
    contacts: filtered.slice(start, start + pageSize).map((contact) => contactResponse(
      contact, visitsByContact.get(contact.id) ?? 0, purchasesByContact.get(contact.id) ?? 0,
    )),
    page,
    pageSize,
    total: filtered.length,
    totalPages: Math.ceil(filtered.length / pageSize),
  });
});

router.patch("/marketing/contacts/:contactId/consent", requireAuth, async (req, res): Promise<void> => {
  const member = await manager(req);
  const contactId = Number(req.params.contactId);
  if (!member || !Number.isInteger(contactId)) { res.status(404).json({ error: "Contact not found" }); return; }
  const consented = typeof req.body?.consented === "boolean" ? req.body.consented
    : typeof req.body?.consent === "boolean" ? req.body.consent : undefined;
  if (consented === undefined) { res.status(400).json({ error: "consented must be a boolean" }); return; }
  const now = new Date();
  const [contact] = await db.update(marketingContactsTable).set({
    marketingConsent: consented,
    consentAt: now,
    consentSource: typeof req.body.source === "string" ? req.body.source.slice(0, 100) : "studio",
    ...(consented ? { unsubscribedAt: null } : {}),
  }).where(and(eq(marketingContactsTable.id, contactId), eq(marketingContactsTable.studioId, member.studioId))).returning();
  if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }
  res.json({ contact: contactResponse(contact, 0, 0) });
});

router.post("/marketing/contacts/:contactId/unsubscribe", requireAuth, async (req, res): Promise<void> => {
  const member = await manager(req);
  const contactId = Number(req.params.contactId);
  if (!member || !Number.isInteger(contactId)) { res.status(404).json({ error: "Contact not found" }); return; }
  const [contact] = await db.update(marketingContactsTable).set({ unsubscribedAt: new Date() })
    .where(and(eq(marketingContactsTable.id, contactId), eq(marketingContactsTable.studioId, member.studioId))).returning();
  if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }
  res.json({ contact: contactResponse(contact, 0, 0) });
});

router.patch("/marketing/contacts/:contactId/unsubscribe", requireAuth, async (req, res): Promise<void> => {
  const member = await manager(req);
  const contactId = Number(req.params.contactId);
  if (!member || !Number.isInteger(contactId)) { res.status(404).json({ error: "Contact not found" }); return; }
  const [contact] = await db.update(marketingContactsTable).set({ unsubscribedAt: req.body?.unsubscribed === false ? null : new Date() })
    .where(and(eq(marketingContactsTable.id, contactId), eq(marketingContactsTable.studioId, member.studioId))).returning();
  if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }
  res.json({ contact: contactResponse(contact, 0, 0) });
});

function templateInput(body: unknown) {
  const input = body as Record<string, unknown> | null;
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  const subject = typeof input?.subject === "string" ? input.subject.trim() : "";
  const bodyText = typeof input?.bodyText === "string" ? input.bodyText : typeof input?.body === "string" ? input.body : "";
  const category = typeof input?.category === "string" ? input.category.trim() : "";
  if (!name || !subject || !bodyText || !category || name.length > 120 || subject.length > 200 || bodyText.length > 100_000 || category.length > 80) return null;
  return { name, subject, bodyText, category };
}

router.get("/marketing/templates", requireAuth, async (req, res): Promise<void> => {
  const member = await manager(req);
  if (!member) { res.status(403).json({ error: "Studio owner or admin access is required" }); return; }
  const templates = await db.select().from(marketingTemplatesTable).where(eq(marketingTemplatesTable.studioId, member.studioId)).orderBy(desc(marketingTemplatesTable.updatedAt));
  res.json(templates);
});

router.post("/marketing/templates", requireAuth, async (req, res): Promise<void> => {
  const member = await manager(req);
  if (!member) { res.status(403).json({ error: "Studio owner or admin access is required" }); return; }
  const input = templateInput(req.body);
  if (!input) { res.status(400).json({ error: "Name, subject, body text, and category are required" }); return; }
  try {
    const [template] = await db.insert(marketingTemplatesTable).values({ ...input, studioId: member.studioId }).returning();
    res.status(201).json(template);
  } catch { res.status(409).json({ error: "A template with this name already exists" }); }
});

router.patch("/marketing/templates/:templateId", requireAuth, async (req, res): Promise<void> => {
  const member = await manager(req);
  const templateId = Number(req.params.templateId);
  if (!member || !Number.isInteger(templateId)) { res.status(404).json({ error: "Template not found" }); return; }
  const input = templateInput(req.body);
  if (!input) { res.status(400).json({ error: "Name, subject, body text, and category are required" }); return; }
  const [template] = await db.update(marketingTemplatesTable).set({ ...input, updatedAt: new Date() })
    .where(and(eq(marketingTemplatesTable.id, templateId), eq(marketingTemplatesTable.studioId, member.studioId))).returning();
  if (!template) { res.status(404).json({ error: "Template not found" }); return; }
  res.json(template);
});

router.delete("/marketing/templates/:templateId", requireAuth, async (req, res): Promise<void> => {
  const member = await manager(req);
  const templateId = Number(req.params.templateId);
  if (!member || !Number.isInteger(templateId)) { res.status(404).json({ error: "Template not found" }); return; }
  try {
    const [template] = await db.delete(marketingTemplatesTable).where(and(eq(marketingTemplatesTable.id, templateId), eq(marketingTemplatesTable.studioId, member.studioId))).returning();
    if (!template) { res.status(404).json({ error: "Template not found" }); return; }
    res.status(204).send();
  } catch { res.status(409).json({ error: "Template is used by a campaign and cannot be deleted" }); }
});

router.get(["/marketing/campaigns", "/marketing/campaign-drafts"], requireAuth, async (req, res): Promise<void> => {
  const member = await manager(req);
  if (!member) { res.status(403).json({ error: "Studio owner or admin access is required" }); return; }
  const campaigns = await db.select().from(marketingCampaignsTable).where(eq(marketingCampaignsTable.studioId, member.studioId)).orderBy(desc(marketingCampaignsTable.updatedAt));
  res.json({ campaigns });
});

router.get("/marketing/email-status", requireAuth, async (req, res): Promise<void> => {
  const member = await manager(req);
  if (!member) { res.status(403).json({ error: "Studio owner or admin access is required" }); return; }
  const config = resendConfiguration();
  res.json({ configured: config.configured, fromEmail: config.from || null });
});

router.post(["/marketing/campaigns", "/marketing/campaign-drafts"], requireAuth, async (req, res): Promise<void> => {
  const member = await manager(req);
  if (!member) { res.status(403).json({ error: "Studio owner or admin access is required" }); return; }
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const templateId = Number(req.body?.templateId ?? req.body?.template);
  if (!name || name.length > 120 || !Number.isInteger(templateId)) { res.status(400).json({ error: "A campaign name and template are required" }); return; }
  const [template] = await db.select().from(marketingTemplatesTable).where(and(eq(marketingTemplatesTable.id, templateId), eq(marketingTemplatesTable.studioId, member.studioId))).limit(1);
  if (!template) { res.status(404).json({ error: "Template not found" }); return; }
  const data = await studioData(member.studioId);
  const filter = (req.body?.audienceFilter ?? req.body?.audience ?? {}) as AudienceFilter;
  const snapshot = JSON.stringify(filter);
  const recipientCount = data.contacts.filter((contact) =>
    contact.marketingConsent === true && !contact.unsubscribedAt && matchesAudience(contact, filter),
  ).length;
  const [campaign] = await db.insert(marketingCampaignsTable).values({
    studioId: member.studioId, name, templateId, audienceFilterSnapshot: snapshot, recipientCount, status: "draft",
  }).returning();
  res.status(201).json(campaign);
});

router.post("/marketing/campaigns/:campaignId/send", requireAuth, async (req, res): Promise<void> => {
  const member = await manager(req);
  const campaignId = Number(req.params.campaignId);
  if (!member || !Number.isInteger(campaignId)) { res.status(404).json({ error: "Campaign not found" }); return; }

  const config = resendConfiguration();
  if (!config.configured) {
    res.status(503).json({ error: "Resend requires both RESEND_API_KEY and RESEND_FROM_EMAIL" });
    return;
  }

  const [campaign] = await db.select().from(marketingCampaignsTable).where(and(
    eq(marketingCampaignsTable.id, campaignId),
    eq(marketingCampaignsTable.studioId, member.studioId),
  )).limit(1);
  if (!campaign) { res.status(404).json({ error: "Campaign not found" }); return; }
  if (campaign.status !== "draft") {
    res.status(409).json({ error: `This campaign is already ${campaign.status} and cannot be sent again` });
    return;
  }

  const [template] = await db.select().from(marketingTemplatesTable).where(and(
    eq(marketingTemplatesTable.id, campaign.templateId),
    eq(marketingTemplatesTable.studioId, member.studioId),
  )).limit(1);
  if (!template) { res.status(409).json({ error: "The campaign template no longer exists" }); return; }

  let filter: AudienceFilter;
  try {
    filter = JSON.parse(campaign.audienceFilterSnapshot) as AudienceFilter;
  } catch {
    res.status(409).json({ error: "The saved audience filter is invalid" });
    return;
  }
  const contacts = await db.select().from(marketingContactsTable).where(eq(marketingContactsTable.studioId, member.studioId));
  const recipients = contacts.filter((contact) =>
    contact.marketingConsent === true && !contact.unsubscribedAt && matchesAudience(contact, filter),
  );
  if (recipients.length === 0) {
    res.status(409).json({ error: "No currently consented recipients match this campaign" });
    return;
  }

  const [claimed] = await db.update(marketingCampaignsTable).set({
    status: "sending",
    recipientCount: recipients.length,
    sentCount: 0,
    lastError: null,
    updatedAt: new Date(),
  }).where(and(
    eq(marketingCampaignsTable.id, campaignId),
    eq(marketingCampaignsTable.studioId, member.studioId),
    eq(marketingCampaignsTable.status, "draft"),
  )).returning();
  if (!claimed) { res.status(409).json({ error: "Campaign sending has already started" }); return; }

  const protocol = String(req.headers["x-forwarded-proto"] ?? req.protocol).split(",")[0].trim();
  const host = req.get("host");
  const baseUrl = `${protocol}://${host}`;
  let sentCount = 0;
  try {
    const messages = recipients.map((contact) => {
      const unsubscribeUrl = `${baseUrl}/api/marketing/unsubscribe?token=${encodeURIComponent(unsubscribeToken(contact.id, member.studioId))}`;
      const text = `${template.bodyText.trim()}\n\nUnsubscribe: ${unsubscribeUrl}`;
      const html = `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#0f172a">${escapeHtml(template.bodyText).replace(/\n/g, "<br>")}<hr style="margin:32px 0 16px;border:0;border-top:1px solid #e2e8f0"><p style="font-size:12px;color:#64748b">Don’t want promotional email from this studio? <a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe</a>.</p></div>`;
      return {
        to: [contact.email],
        subject: template.subject,
        text,
        html,
        headers: {
          "List-Unsubscribe": `<${unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      };
    });
    sentCount = await sendResendEmails(messages);
    const [sentCampaign] = await db.update(marketingCampaignsTable).set({
      status: "sent",
      sentCount,
      sentAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(marketingCampaignsTable.id, campaignId),
      eq(marketingCampaignsTable.studioId, member.studioId),
    )).returning();
    res.json({ campaign: sentCampaign, sentCount });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Resend error";
    await db.update(marketingCampaignsTable).set({
      status: "failed",
      sentCount,
      lastError: message.slice(0, 1_000),
      updatedAt: new Date(),
    }).where(and(
      eq(marketingCampaignsTable.id, campaignId),
      eq(marketingCampaignsTable.studioId, member.studioId),
    ));
    res.status(502).json({ error: "Resend could not send this campaign", detail: message });
  }
});

export default router;