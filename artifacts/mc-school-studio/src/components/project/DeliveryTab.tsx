import React, { useEffect, useState } from "react";
import { Check, Copy, Download, ExternalLink, Loader2, LockKeyhole, Send } from "lucide-react";

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
  accessCode: string;
  accessUrl: string;
};

export function DeliveryTab({ projectId, isCorporate }: { projectId: number; isCorporate?: boolean }) {
  const [state, setState] = useState<DeliveryState | null>(null);
  const [cards, setCards] = useState<AccessCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/delivery`, { credentials: "include" });
      if (!response.ok) throw new Error("Could not load delivery settings.");
      setState(await response.json() as DeliveryState);
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
    if (!response.ok) return;
    setCards(await response.json() as AccessCard[]);
  }

  async function copyUrl() {
    if (!state?.gallery) return;
    await navigator.clipboard.writeText(`${window.location.origin}/delivery/${state.gallery.slug}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  function downloadCards() {
    if (!cards.length || !state?.gallery) return;
    const header = ["First name", "Last name", "Student ID", "Access code", "Private gallery URL"];
    const rows = cards.map((card) => [
      card.firstName,
      card.lastName,
      card.generatedStudentId,
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
                <p className="mt-1 text-sm text-slate-500">Download a CSV with one private code and link per {isCorporate ? "employee" : "student"}.</p>
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
                  <p className="text-sm font-medium text-slate-700">{cards.length} access cards ready</p>
                  <button onClick={downloadCards} className="inline-flex h-9 items-center gap-2 rounded-md bg-slate-900 px-3 text-sm font-semibold text-white hover:bg-slate-800">
                    <Download className="size-4" />Download CSV
                  </button>
                </div>
                <p className="mt-2 text-xs text-slate-500">Keep this file private. Anyone with a code can view that person’s delivery gallery.</p>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}