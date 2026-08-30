import { useEffect, useMemo, useState } from "react";
import { Building2, Copy, Link2, ShieldCheck, UserPlus, X } from "lucide-react";
import { useUser } from "@clerk/react";
import type { PlatformInvite, PlatformOverview } from "@workspace/api-client-react";

type PlatformData = PlatformOverview;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function Platform() {
  const { user } = useUser();
  const [data, setData] = useState<PlatformData | null>(null);
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);

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
              <div className="flex items-start justify-between gap-3"><div className="flex items-center gap-3"><div className="rounded-lg bg-slate-100 p-2 text-slate-600"><Building2 className="h-5 w-5" /></div><div><h3 className="font-semibold text-slate-900">{studio.name}</h3><p className="text-sm text-slate-500">{studio.owner?.displayName || studio.owner?.email || "Owner not completed"}</p></div></div><Link2 className="h-4 w-4 text-slate-400" /></div>
              <div className="mt-4 grid grid-cols-2 gap-3 text-sm"><div className="rounded-lg bg-slate-50 p-3"><p className="text-slate-500">Members</p><p className="mt-1 font-semibold text-slate-900">{studio.memberCount}</p></div><div className="rounded-lg bg-slate-50 p-3"><p className="text-slate-500">Projects</p><p className="mt-1 font-semibold text-slate-900">{studio.projectCount}</p></div></div>
              {studio.description && <p className="mt-4 line-clamp-2 text-sm text-slate-600">{studio.description}</p>}
            </article>)}
          </div>}
        </section>
      </div>
    </div>
  );
}