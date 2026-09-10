import React, { useEffect, useState } from "react";
import { Check, Copy, Download, ExternalLink, Loader2, LockKeyhole, Printer, QrCode, Send } from "lucide-react";

type DeliveryState = {
  gallery: {
    slug: string;
    status: "draft" | "published" | "revoked";
    publishedAt: string | null;
  } | null;
  accessCount: number;
};

type AccessCard = {
  firstName: string;
  lastName: string;
  generatedStudentId: string;
  className: string | null;
  accessCode: string;
  accessUrl: string;
  qrDataUrl: string;
};

type StudioBranding = {
  name: string;
  tagline: string | null;
  contactEmail: string | null;
  logoObjectPath: string | null;
  primaryColor: string;
  accentColor: string;
  brandingUpdatedAt: string | null;
};

const fallbackBranding: StudioBranding = {
  name: "Volume Capture",
  tagline: "Private photo delivery",
  contactEmail: null,
  logoObjectPath: null,
  primaryColor: "#0F766E",
  accentColor: "#14B8A6",
  brandingUpdatedAt: null,
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character] ?? character);
}

export function DeliveryTab({ projectId, projectName, isCorporate }: { projectId: number; projectName?: string; isCorporate?: boolean }) {
  const [state, setState] = useState<DeliveryState | null>(null);
  const [cards, setCards] = useState<AccessCard[]>([]);
  const [branding, setBranding] = useState<StudioBranding>(fallbackBranding);
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [classFilter, setClassFilter] = useState("all");

  const classOptions = Array.from(
    new Set(cards.map((card) => card.className).filter((value): value is string => Boolean(value))),
  ).sort((a, b) => a.localeCompare(b));
  const visibleCards = classFilter === "all" ? cards : cards.filter((card) => card.className === classFilter);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [response, studioResponse] = await Promise.all([
        fetch(`/api/projects/${projectId}/delivery`, { credentials: "include" }),
        fetch("/api/studio", { credentials: "include" }),
      ]);
      if (!response.ok) throw new Error("Could not load delivery settings.");
      setState(await response.json() as DeliveryState);
      if (studioResponse.ok) {
        const studioBody = await studioResponse.json() as { studio?: StudioBranding };
        if (studioBody.studio) setBranding(studioBody.studio);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load delivery settings.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [projectId]);

  async function publish() {
    setPublishing(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/delivery/publish`, {
        method: "POST",
        credentials: "include",
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not publish delivery.");
      await load();
      await loadCards();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not publish delivery.");
    } finally {
      setPublishing(false);
    }
  }

  async function loadCards() {
    const response = await fetch(`/api/projects/${projectId}/delivery/access-cards`, { credentials: "include" });
    if (!response.ok) {
      setError("Could not load the private access codes.");
      return;
    }
    setCards(await response.json() as AccessCard[]);
  }

  async function copyUrl() {
    if (!state?.gallery) return;
    await navigator.clipboard.writeText(`${window.location.origin}/delivery/${state.gallery.slug}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  function downloadCards() {
    if (!visibleCards.length || !state?.gallery) return;
    const header = ["First name", "Last name", "Student ID", "Class / department", "Access code", "Private gallery URL"];
    const rows = visibleCards.map((card) => [
      card.firstName,
      card.lastName,
      card.generatedStudentId,
      card.className ?? "",
      card.accessCode,
      `${window.location.origin}${card.accessUrl}`,
    ]);
    const csv = [header, ...rows]
      .map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","))
      .join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    link.download = "volume-capture-access-cards.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function printCards() {
    if (!visibleCards.length) return;
    const entity = isCorporate ? "employee" : "student";
    const entityPlural = isCorporate ? "employees" : "students";
    const publicOrigin = window.location.origin;
    const logoUrl = branding.logoObjectPath
      ? `/api/studio/branding/logo?rev=${encodeURIComponent(branding.brandingUpdatedAt ?? "")}`
      : "";
    const cardMarkup = visibleCards.map((card) => {
      const fullUrl = `${publicOrigin}${card.accessUrl}`;
      return `
        <article class="access-card">
          <div class="card-name">${escapeHtml(card.firstName)} ${escapeHtml(card.lastName)}</div>
          <div class="card-id">${escapeHtml(card.generatedStudentId)}</div>
          <img class="qr" src="${escapeHtml(card.qrDataUrl)}" alt="QR code for ${escapeHtml(card.firstName)} ${escapeHtml(card.lastName)}" />
          <div class="scan-label">Scan to view private photos</div>
          <div class="code-label">Access code</div>
          <div class="code">${escapeHtml(card.accessCode)}</div>
          <div class="url">${escapeHtml(fullUrl)}</div>
          <p class="instruction">Keep this card private. It provides access to this ${entity}'s photos.</p>
        </article>`;
    }).join("");
    const html = `<!doctype html>
      <html><head><meta charset="utf-8"><title>${escapeHtml(branding.name)} — ${escapeHtml(projectName ?? "Photo delivery")}</title>
      <style>
        @page { size: letter; margin: 0.35in; }
        * { box-sizing: border-box; }
        body { margin: 0; color: #172033; font-family: Arial, Helvetica, sans-serif; background: #fff; }
        .sheet-header { display: flex; align-items: center; gap: 14px; padding: 0 0 16px; border-bottom: 4px solid ${escapeHtml(branding.accentColor)}; margin-bottom: 16px; }
        .logo { width: 58px; height: 58px; object-fit: contain; border-radius: 10px; }
        .brand-name { color: ${escapeHtml(branding.primaryColor)}; font-size: 19px; font-weight: 700; }
        .tagline { color: #657084; font-size: 11px; margin-top: 3px; }
        .sheet-title { margin-left: auto; text-align: right; }
        .sheet-title h1 { margin: 0; font-size: 16px; }
        .sheet-title p { margin: 4px 0 0; color: #657084; font-size: 11px; }
        .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
        .access-card { min-height: 3.55in; padding: 14px; border: 1px solid #dbe2ea; border-top: 5px solid ${escapeHtml(branding.primaryColor)}; border-radius: 10px; text-align: center; page-break-inside: avoid; }
        .card-name { font-size: 17px; font-weight: 700; }
        .card-id { color: #657084; font-size: 10px; margin-top: 3px; }
        .qr { display: block; width: 1.48in; height: 1.48in; margin: 10px auto 5px; image-rendering: pixelated; }
        .scan-label { color: #657084; font-size: 10px; }
        .code-label { color: #657084; font-size: 9px; text-transform: uppercase; letter-spacing: 0.12em; margin-top: 9px; }
        .code { color: ${escapeHtml(branding.primaryColor)}; font-family: monospace; font-size: 18px; font-weight: 700; letter-spacing: 0.12em; margin-top: 3px; }
        .url { color: #657084; font-size: 8px; overflow-wrap: anywhere; margin-top: 5px; }
        .instruction { color: #657084; font-size: 9px; line-height: 1.35; margin: 8px 0 0; }
        .footer { color: #657084; font-size: 9px; margin-top: 14px; text-align: center; }
        @media print { .footer { display: none; } }
      </style></head>
      <body>
        <header class="sheet-header">
          ${logoUrl ? `<img class="logo" src="${escapeHtml(logoUrl)}" alt="${escapeHtml(branding.name)} logo" />` : ""}
          <div><div class="brand-name">${escapeHtml(branding.name)}</div><div class="tagline">${escapeHtml(branding.tagline ?? "Private photo delivery")}</div></div>
          <div class="sheet-title"><h1>Private ${entity} photo access</h1><p>${escapeHtml(projectName ?? "Photo delivery")} · ${visibleCards.length} ${entityPlural}${classFilter === "all" ? "" : ` · ${escapeHtml(classFilter)}`}</p></div>
        </header>
        <main class="grid">${cardMarkup}</main>
        <div class="footer">Print this sheet and give each card only to the matching ${entity} or family.</div>
        <script>window.addEventListener("load", () => window.print());<\/script>
      </body></html>`;
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      setError("Allow pop-ups to print the branded QR sheet.");
      return;
    }
    printWindow.document.write(html);
    printWindow.document.close();
  }

  if (loading) {
    return <div className="flex items-center justify-center gap-2 p-12 text-sm text-slate-500"><Loader2 className="size-4 animate-spin" />Loading delivery…</div>;
  }

  const publicUrl = state?.gallery ? `${window.location.origin}/delivery/${state.gallery.slug}` : null;

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-col gap-4 rounded-xl border border-teal-200 bg-teal-50 p-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex gap-3">
          <div className="rounded-lg bg-white p-2 text-teal-700"><LockKeyhole className="size-5" /></div>
          <div>
            <h2 className="font-semibold text-teal-950">Private {isCorporate ? "headshot" : "photo"} delivery</h2>
            <p className="mt-1 max-w-2xl text-sm text-teal-900/75">
              Give each {isCorporate ? "employee" : "student"} a private access code. Families or employees can view only their own published photos.
            </p>
          </div>
        </div>
        <button
          onClick={() => void publish()}
          disabled={publishing}
          className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-md bg-teal-700 px-4 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-60"
        >
          {publishing ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          {state?.gallery?.status === "published" ? "Refresh delivery" : "Publish delivery"}
        </button>
      </div>

      {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div>}

      {!state?.gallery && !error && (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <h3 className="font-semibold text-slate-800">This project is not published yet</h3>
          <p className="mx-auto mt-2 max-w-lg text-sm text-slate-500">Publish after reviewing the photos. Volume Capture will generate one private access code for every student or employee.</p>
        </div>
      )}

      {state?.gallery && (
        <>
          <section className="rounded-xl border bg-white p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Delivery link</p>
                <p className="mt-1 break-all font-mono text-sm text-slate-800">{publicUrl}</p>
                <p className="mt-2 text-sm text-slate-500">
                  {state.accessCount} private access code{state.accessCount === 1 ? "" : "s"} available
                  {state.gallery.publishedAt ? ` · published ${new Date(state.gallery.publishedAt).toLocaleDateString()}` : ""}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => void copyUrl()} className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                  {copied ? <Check className="size-4 text-teal-600" /> : <Copy className="size-4" />}
                  {copied ? "Copied" : "Copy link"}
                </button>
                <a href={publicUrl ?? "#"} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                  <ExternalLink className="size-4" />Open gallery
                </a>
              </div>
            </div>
          </section>

          <section className="rounded-xl border bg-white p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="font-semibold text-slate-900">Access cards</h3>
                <p className="mt-1 text-sm text-slate-500">Print a branded QR sheet or download a CSV with one private code and link per {isCorporate ? "employee" : "student"}.</p>
              </div>
              <button
                onClick={() => void loadCards()}
                className="inline-flex h-9 items-center gap-2 rounded-md border border-teal-200 px-3 text-sm font-semibold text-teal-700 hover:bg-teal-50"
              >
                <LockKeyhole className="size-4" />Load codes
              </button>
            </div>
            {cards.length > 0 && (
              <div className="mt-4 rounded-lg bg-slate-50 p-4">
                <div className="flex items-center justify-between gap-3">
                   <p className="text-sm font-medium text-slate-700">{visibleCards.length} of {cards.length} access cards ready</p>
                   <div className="flex flex-wrap justify-end gap-2">
                     {classOptions.length > 0 && (
                       <label className="flex items-center gap-2 text-sm text-slate-600">
                         <span className="sr-only">Filter by class or department</span>
                         <select value={classFilter} onChange={(event) => setClassFilter(event.target.value)} className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm">
                           <option value="all">All classes / departments</option>
                           {classOptions.map((className) => <option key={className} value={className}>{className}</option>)}
                         </select>
                       </label>
                     )}
                     <button onClick={printCards} className="inline-flex h-9 items-center gap-2 rounded-md bg-teal-700 px-3 text-sm font-semibold text-white hover:bg-teal-800">
                       <Printer className="size-4" />Print / Save PDF
                     </button>
                     <button onClick={downloadCards} className="inline-flex h-9 items-center gap-2 rounded-md bg-slate-900 px-3 text-sm font-semibold text-white hover:bg-slate-800">
                       <Download className="size-4" />Download CSV
                     </button>
                   </div>
                </div>
                  <p className="mt-2 text-xs text-slate-500"><QrCode className="mr-1 inline size-3.5" />Each card includes a scannable link, the access code, and your studio branding. Keep the sheet private.</p>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}