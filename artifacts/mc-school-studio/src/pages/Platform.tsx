import { useEffect, useMemo, useState } from "react";
import { Building2, Calendar, Check, ChevronRight, Copy, FolderKanban, Layers, Link2, Loader2, Mail, Pencil, ShieldCheck, UserPlus, Users, X } from "lucide-react";
import { useUser } from "@clerk/react";
import type { PlatformInvite, PlatformOverview } from "@workspace/api-client-react";
import { Link } from "wouter";
import { format } from "date-fns";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

type PlatformData = PlatformOverview;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function Platform() {
  const { user } = useUser();
  const [data, setData] = useState<PlatformData | null>(null);
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [editingStudio, setEditingStudio] = useState<PlatformData["studios"][number] | null>(null);
  const [studioForm, setStudioForm] = useState({ description: "", website: "", contactEmail: "" });
  const [studioSaving, setStudioSaving] = useState(false);
  const [studioError, setStudioError] = useState<string | null>(null);
  const { toast } = useToast();

  async function load() {
    const response = await fetch("/api/platform");
    if (!response.ok) {
      setError(response.status === 403 ? "This area is only available to the platform owner." : "Could not load platform data.");
      return;
    }
    setData(await response.json() as PlatformData);
  }

  useEffect(() => {
    void load();
  }, [user?.id]);

  const pendingInvites = useMemo(
    () => data?.invites.filter((invite) => invite.status === "pending") ?? [],
    [data],
  );

  async function createInvite(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/platform/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        setError(body.error ?? "Could not create the invitation.");
        return;
      }
      setEmail("");
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function cancelInvite(invite: PlatformInvite) {
    const response = await fetch(`/api/platform/invites/${invite.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "cancelled" }) });
    if (!response.ok) {
      setError("Could not cancel the invitation.");
      return;
    }
    await load();
  }

  async function copyInvite(invite: PlatformInvite) {
    const url = `${window.location.origin}${basePath}/studio-invite/${invite.code}`;
    await navigator.clipboard.writeText(url);
    setCopiedId(invite.id);
    window.setTimeout(() => setCopiedId((current) => current === invite.id ? null : current), 1800);
  }

  function openStudioEditor(studio: PlatformData["studios"][number]) {
    setEditingStudio(studio);
    setStudioForm({
      description: studio.description ?? "",
      website: studio.website ?? "",
      contactEmail: studio.contactEmail ?? "",
    });
    setStudioError(null);
  }

  async function updateStudio(event: React.FormEvent) {
    event.preventDefault();
    if (!editingStudio) return;
    setStudioSaving(true);
    setStudioError(null);
    try {
      const response = await fetch(`/api/platform/studios/${editingStudio.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(studioForm),
      });
      const body = await response.json().catch(() => ({})) as { error?: string } & Partial<PlatformData["studios"][number]>;
      if (!response.ok) {
        setStudioError(body.error ?? "Could not update the studio details.");
        return;
      }

      setData((current) => current ? {
        ...current,
        studios: current.studios.map((studio) => studio.id === editingStudio.id ? { ...studio, ...body } : studio),
      } : current);
      setEditingStudio(null);
      toast({
        title: "Studio details updated",
        description: `${editingStudio.name} is now up to date.`,
      });
    } finally {
      setStudioSaving(false);
    }
  }

  if (error && !data) {
    return <div className="flex-1 overflow-auto bg-slate-50 p-8"><div className="mx-auto max-w-5xl rounded-xl border border-red-200 bg-red-50 p-6 text-red-800">{error}</div></div>;
  }
  if (!data) {
    return <div className="flex-1 overflow-auto bg-slate-50 p-8 text-slate-500">Loading platform workspace…</div>;
  }

  return (
    <div className="flex-1 overflow-auto bg-slate-50 p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex items-start gap-3">
          <div className="rounded-lg bg-teal-100 p-2 text-teal-700"><ShieldCheck className="h-6 w-6" /></div>
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Platform workspace</h1>
            <p className="mt-1 text-slate-500">Create and oversee independent photography studios.</p>
          </div>
        </header>

        <section className="rounded-xl border border-teal-200 bg-teal-50 p-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-teal-900"><UserPlus className="h-4 w-4" />Invite a studio owner</div>
          <p className="mt-1 text-sm text-teal-800">They will create their own studio page. Their projects and team stay separate from every other studio.</p>
          <form onSubmit={(event) => void createInvite(event)} className="mt-4 flex flex-col gap-3 sm:flex-row">
            <input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="owner@photostudio.com" className="h-10 flex-1 rounded-md border border-teal-300 bg-white px-3 text-sm text-slate-900" />
            <button disabled={saving} className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-teal-700 px-4 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-60">{saving ? "Creating…" : "Create invitation"}</button>
          </form>
          {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
        </section>

        {pendingInvites.length > 0 && <section className="rounded-xl border bg-white shadow-sm">
          <div className="border-b px-6 py-4"><h2 className="font-semibold text-slate-900">Pending studio-owner invitations</h2></div>
          <div className="divide-y">
            {pendingInvites.map((invite) => (
              <div key={invite.id} className="flex flex-col gap-3 px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0"><p className="font-medium text-slate-900">{invite.email}</p><p className="mt-1 text-xs text-slate-500">Send the secure link below. It can be used once.</p></div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input readOnly value={`${window.location.origin}${basePath}/studio-invite/${invite.code}`} aria-label={`Invitation link for ${invite.email}`} className="h-9 min-w-0 rounded-md border border-slate-300 bg-slate-50 px-3 text-xs text-slate-600 sm:w-80" />
                  <button type="button" onClick={() => void copyInvite(invite)} className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"><Copy className="h-4 w-4" />{copiedId === invite.id ? "Copied" : "Copy link"}</button>
                  <button type="button" onClick={() => void cancelInvite(invite)} aria-label={`Cancel invitation for ${invite.email}`} className="inline-flex h-9 items-center justify-center rounded-md border border-red-200 px-3 text-red-700 hover:bg-red-50"><X className="h-4 w-4" /></button>
                </div>
              </div>
            ))}
          </div>
        </section>}

        <section className="overflow-hidden rounded-xl border bg-white shadow-sm">
          <div className="border-b px-6 py-4"><h2 className="font-semibold text-slate-900">Studios</h2></div>
          {data.studios.length === 0 ? <div className="p-8 text-center text-sm text-slate-500">No studios have been created yet.</div> : <div className="grid gap-4 p-6 md:grid-cols-2">
            {data.studios.map((studio) => <article key={studio.id} className="rounded-xl border border-slate-200 p-5">
              <div className="flex items-start justify-between gap-3"><div className="flex items-center gap-3"><div className="rounded-lg bg-slate-100 p-2 text-slate-600"><Building2 className="h-5 w-5" /></div><div><h3 className="font-semibold text-slate-900">{studio.name}</h3><p className="text-sm text-slate-500">{studio.owner?.displayName || studio.owner?.email || "Owner not completed"}</p></div></div><button type="button" onClick={() => openStudioEditor(studio)} className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50" aria-label={`Edit details for ${studio.name}`}><Pencil className="h-3.5 w-3.5" />Edit</button></div>
              <div className="mt-4 grid grid-cols-2 gap-3 text-sm"><div className="rounded-lg bg-slate-50 p-3"><p className="text-slate-500">Members</p><p className="mt-1 font-semibold text-slate-900">{studio.memberCount}</p></div><div className="rounded-lg bg-slate-50 p-3"><p className="text-slate-500">Projects</p><p className="mt-1 font-semibold text-slate-900">{studio.projectCount}</p></div></div>
              {studio.description && <p className="mt-4 line-clamp-2 text-sm text-slate-600">{studio.description}</p>}
              <div className="mt-4 space-y-1 text-xs text-slate-500">
                {studio.website ? <p className="inline-flex max-w-full items-center gap-1.5 truncate"><Link2 className="h-3.5 w-3.5 shrink-0" />{studio.website}</p> : <p className="text-slate-400">No website added</p>}
                {studio.contactEmail ? <p className="inline-flex max-w-full items-center gap-1.5 truncate"><Mail className="h-3.5 w-3.5 shrink-0" />{studio.contactEmail}</p> : <p className="text-slate-400">No contact email added</p>}
              </div>
            </article>)}
          </div>}
        </section>

        <section className="overflow-hidden rounded-xl border bg-white shadow-sm">
          <div className="flex items-center justify-between border-b px-6 py-4">
            <div>
              <h2 className="font-semibold text-slate-900">All school projects</h2>
              <p className="mt-1 text-sm text-slate-500">Open any project to manage its students, classes, photos, imports, and exports.</p>
            </div>
            <span className="rounded-full bg-teal-50 px-3 py-1 text-sm font-semibold text-teal-700">{data.projects.length}</span>
          </div>
          {data.projects.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              <FolderKanban className="mx-auto mb-3 h-8 w-8 text-slate-300" />
              No school projects have been created yet.
            </div>
          ) : (
            <div className="divide-y">
              {data.projects.map((project) => (
                <Link key={project.id} href={`/projects/${project.id}`} className="flex flex-col gap-4 px-6 py-5 transition-colors hover:bg-slate-50 md:flex-row md:items-center md:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="rounded-lg bg-teal-50 p-2 text-teal-700"><FolderKanban className="h-5 w-5" /></div>
                    <div className="min-w-0">
                      <h3 className="truncate font-semibold text-slate-900">{project.schoolName}</h3>
                      <p className="mt-1 text-sm text-slate-500">{project.studioName ?? "No studio assigned"}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
                        <span className="inline-flex items-center gap-1"><Calendar className="h-3.5 w-3.5" />{project.photoDate ? format(new Date(project.photoDate), "MMM d, yyyy") : "No photo date"}</span>
                        <span className="inline-flex items-center gap-1"><Layers className="h-3.5 w-3.5" />{project.classCount} classes</span>
                        <span className="inline-flex items-center gap-1"><Users className="h-3.5 w-3.5" />{project.studentCount} students</span>
                      </div>
                    </div>
                  </div>
                  <span className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-teal-700">Manage project <ChevronRight className="h-4 w-4" /></span>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>

      <Dialog open={Boolean(editingStudio)} onOpenChange={(open) => { if (!open && !studioSaving) setEditingStudio(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit studio details</DialogTitle>
            <DialogDescription>Update the public profile details for {editingStudio?.name}.</DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => void updateStudio(event)} className="space-y-4">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Description <span className="font-normal text-slate-400">(optional)</span></span>
              <Textarea maxLength={500} value={studioForm.description} onChange={(event) => setStudioForm((current) => ({ ...current, description: event.target.value }))} placeholder="School portraits with a calm, organized workflow." />
              <span className="text-xs text-slate-400">{studioForm.description.length}/500</span>
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Website <span className="font-normal text-slate-400">(optional)</span></span>
              <Input type="url" maxLength={200} value={studioForm.website} onChange={(event) => setStudioForm((current) => ({ ...current, website: event.target.value }))} placeholder="https://yourstudio.com" />
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Contact email <span className="font-normal text-slate-400">(optional)</span></span>
              <Input type="email" maxLength={254} value={studioForm.contactEmail} onChange={(event) => setStudioForm((current) => ({ ...current, contactEmail: event.target.value }))} placeholder="hello@yourstudio.com" />
            </label>
            {studioError && <p role="alert" className="text-sm text-red-700">{studioError}</p>}
            <DialogFooter>
              <button type="button" disabled={studioSaving} onClick={() => setEditingStudio(null)} className="inline-flex h-10 items-center justify-center rounded-md border border-slate-300 px-4 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60">Cancel</button>
              <button type="submit" disabled={studioSaving} className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-teal-600 px-4 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-60">{studioSaving ? <><Loader2 className="h-4 w-4 animate-spin" />Saving…</> : <><Check className="h-4 w-4" />Save changes</>}</button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}