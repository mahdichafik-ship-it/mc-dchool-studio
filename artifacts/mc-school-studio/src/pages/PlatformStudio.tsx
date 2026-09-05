import { useEffect, useState } from "react";
import { Link, useParams } from "wouter";
import { AlertTriangle, ArrowLeft, CalendarClock, Cloud, FolderKanban, HardDrive, Loader2, ShieldCheck, UserCheck, UserX, Users } from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";

type StudioDetail = {
  studio: {
    id: number; name: string; description: string | null; storageProvider: string; storageStatus: string;
    archivedAt: string | null; archiveReason: string | null;
  };
  members: Array<{ id: number; email: string; displayName: string | null; role: string; status: "active" | "removed"; createdAt: string }>;
  projects: Array<{ id: number; schoolName: string; photoDate: string | null; updatedAt: string }>;
  desktopConnections: Array<{
    id: number; memberEmail: string; deviceName: string; tokenPrefix: string; status: string;
    lastUsedAt: string | null; expiresAt: string | null; createdAt: string; retirementAcknowledgedAt: string | null;
  }>;
  storageConnections: Array<{
    id: number; provider: string; providerAccountEmail: string; status: string; lastVerifiedAt: string;
    updatedAt: string; disconnectedAt: string | null;
  }>;
  storageAudit: Array<{ id: number; action: string; provider: string; providerAccountEmail: string | null; detail: string | null; createdAt: string }>;
  platformAudit: Array<{ id: number; action: string; targetType: string; detail: string | null; createdAt: string }>;
};

function readable(value: string) {
  return value.replaceAll("_", " ");
}

export default function PlatformStudio() {
  const { studioId } = useParams<{ studioId: string }>();
  const [data, setData] = useState<StudioDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { toast } = useToast();

  async function load() {
    const response = await fetch(`/api/platform/studios/${studioId}`);
    const body = await response.json().catch(() => ({})) as StudioDetail & { error?: string };
    if (!response.ok) {
      setError(body.error ?? "Could not load studio oversight.");
      return;
    }
    setData(body);
    setError(null);
  }

  useEffect(() => { void load(); }, [studioId]);

  async function mutate(key: string, url: string, init: RequestInit, success: string) {
    setBusy(key);
    try {
      const response = await fetch(url, init);
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "The platform action failed.");
      await load();
      toast({ title: success, description: "The action was recorded in the platform audit trail." });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The platform action failed.");
    } finally {
      setBusy(null);
    }
  }

  if (!data && !error) return <div className="flex flex-1 items-center justify-center bg-slate-50 text-slate-500"><Loader2 className="mr-2 h-5 w-5 animate-spin" />Loading studio oversight…</div>;
  if (!data) return <div className="flex-1 bg-slate-50 p-8"><p className="rounded-xl border border-red-200 bg-red-50 p-5 text-red-800">{error}</p></div>;

  const isArchived = Boolean(data.studio.archivedAt);

  return (
    <div className="flex-1 overflow-auto bg-slate-50 p-5 sm:p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <Link href="/platform" className="inline-flex items-center gap-2 text-sm font-semibold text-teal-700"><ArrowLeft className="h-4 w-4" />Platform workspace</Link>
        <section className="rounded-2xl border border-amber-300 bg-amber-50 p-5">
          <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 text-amber-700" /><div><h1 className="text-2xl font-bold text-slate-950">{data.studio.name}</h1><p className="mt-1 text-sm text-amber-900">Platform oversight mode. You have owner-equivalent visibility, but every control action is explicitly logged.</p></div></div>
        </section>
        {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</p>}

        <section className="grid gap-4 sm:grid-cols-4">
          <div className="rounded-xl border bg-white p-4"><Users className="h-5 w-5 text-teal-700" /><p className="mt-3 text-2xl font-bold">{data.members.length}</p><p className="text-sm text-slate-500">Members</p></div>
          <div className="rounded-xl border bg-white p-4"><FolderKanban className="h-5 w-5 text-teal-700" /><p className="mt-3 text-2xl font-bold">{data.projects.length}</p><p className="text-sm text-slate-500">Projects</p></div>
          <div className="rounded-xl border bg-white p-4"><HardDrive className="h-5 w-5 text-teal-700" /><p className="mt-3 text-2xl font-bold">{data.desktopConnections.filter((item) => item.status === "active").length}</p><p className="text-sm text-slate-500">Active desktops</p></div>
          <div className="rounded-xl border bg-white p-4"><Cloud className="h-5 w-5 text-teal-700" /><p className="mt-3 text-sm font-bold capitalize">{readable(data.studio.storageStatus)}</p><p className="text-sm text-slate-500">Storage</p></div>
        </section>

        <section className="overflow-hidden rounded-xl border bg-white">
          <div className="flex items-center justify-between border-b p-5"><div><h2 className="font-semibold">Studio access</h2><p className="mt-1 text-sm text-slate-500">Suspending a member immediately revokes their desktop connections.</p></div></div>
          <div className="divide-y">{data.members.map((member) => <div key={member.id} className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium">{member.displayName || member.email}</p><p className="text-sm capitalize text-slate-500">{member.role} · {member.status}</p></div><button disabled={busy !== null} onClick={() => void mutate(`member-${member.id}`, `/api/platform/studios/${studioId}/members/${member.id}/access`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: member.status === "active" ? "removed" : "active" }) }, member.status === "active" ? "Member access suspended" : "Member access restored")} className={`inline-flex h-9 items-center justify-center gap-2 rounded-md border px-3 text-sm font-semibold ${member.status === "active" ? "border-red-200 text-red-700" : "border-emerald-200 text-emerald-700"}`}>{member.status === "active" ? <UserX className="h-4 w-4" /> : <UserCheck className="h-4 w-4" />}{member.status === "active" ? "Suspend access" : "Reactivate"}</button></div>)}</div>
        </section>

        <section className="overflow-hidden rounded-xl border bg-white">
          <div className="border-b p-5"><h2 className="font-semibold">Desktop access tokens</h2><p className="mt-1 text-sm text-slate-500">Desktop tokens default to 30 days. Extend, retire for safe local cleanup, or revoke immediately.</p></div>
          {data.desktopConnections.length === 0 ? <p className="p-5 text-sm text-slate-500">No desktop connections.</p> : <div className="divide-y">{data.desktopConnections.map((item) => <div key={item.id} className="p-5"><div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between"><div><p className="font-medium">{item.deviceName}</p><p className="text-sm text-slate-500">{item.memberEmail} · {item.tokenPrefix}… · {item.status}</p><p className="mt-1 text-xs text-slate-400">Expires {item.expiresAt ? format(new Date(item.expiresAt), "MMM d, yyyy") : "never"}</p></div>{item.status !== "revoked" && <div className="flex flex-wrap gap-2"><button disabled={busy !== null} onClick={() => void mutate(`expiry-${item.id}`, `/api/platform/studios/${studioId}/desktop-connections/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "set_expiry", days: 30 }) }, "Desktop access extended by 30 days")} className="rounded-md border px-3 py-2 text-xs font-semibold text-slate-700">Extend 30 days</button><button disabled={busy !== null} onClick={() => void mutate(`retire-${item.id}`, `/api/platform/studios/${studioId}/desktop-connections/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "retire" }) }, "Desktop retirement requested")} className="rounded-md border border-amber-200 px-3 py-2 text-xs font-semibold text-amber-700">Retire</button><button disabled={busy !== null} onClick={() => void mutate(`revoke-${item.id}`, `/api/platform/studios/${studioId}/desktop-connections/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "revoke" }) }, "Desktop access revoked")} className="rounded-md border border-red-200 px-3 py-2 text-xs font-semibold text-red-700">Revoke</button></div>}</div></div>)}</div>}
        </section>

        <section className="overflow-hidden rounded-xl border bg-white">
          <div className="border-b p-5"><h2 className="font-semibold">Studio storage connections</h2><p className="mt-1 text-sm text-slate-500">OAuth access is refreshed automatically. Revoke it when access must end; the platform Drive takes over.</p></div>
          {data.storageConnections.length === 0 ? <p className="p-5 text-sm text-slate-500">No studio-owned storage connection.</p> : <div className="divide-y">{data.storageConnections.map((item) => <div key={item.id} className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium capitalize">{readable(item.provider)}</p><p className="text-sm text-slate-500">{item.providerAccountEmail} · {item.status}</p></div>{item.status === "active" && <button disabled={busy !== null} onClick={() => void mutate(`storage-${item.id}`, `/api/platform/studios/${studioId}/storage-connections/${item.id}`, { method: "DELETE" }, "Storage access revoked")} className="rounded-md border border-red-200 px-3 py-2 text-sm font-semibold text-red-700">Revoke storage</button>}</div>)}</div>}
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <div className="overflow-hidden rounded-xl border bg-white"><div className="border-b p-5"><h2 className="font-semibold">Storage failures and history</h2></div><div className="max-h-96 divide-y overflow-auto">{data.storageAudit.length === 0 ? <p className="p-5 text-sm text-slate-500">No storage events.</p> : data.storageAudit.map((item) => <div key={item.id} className="p-4"><p className="text-sm font-medium capitalize">{readable(item.action)} · {readable(item.provider)}</p><p className="mt-1 text-xs text-slate-500">{format(new Date(item.createdAt), "MMM d, yyyy HH:mm")}{item.detail ? ` · ${item.detail}` : ""}</p></div>)}</div></div>
          <div className="overflow-hidden rounded-xl border bg-white"><div className="border-b p-5"><h2 className="font-semibold">Platform action audit</h2></div><div className="max-h-96 divide-y overflow-auto">{data.platformAudit.length === 0 ? <p className="p-5 text-sm text-slate-500">No platform actions recorded yet.</p> : data.platformAudit.map((item) => <div key={item.id} className="p-4"><p className="text-sm font-medium capitalize">{readable(item.action)}</p><p className="mt-1 text-xs text-slate-500">{format(new Date(item.createdAt), "MMM d, yyyy HH:mm")}{item.detail ? ` · ${item.detail}` : ""}</p></div>)}</div></div>
        </section>

        <section className={`rounded-xl border p-5 ${isArchived ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"}`}>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div className="flex gap-3"><AlertTriangle className={`mt-0.5 h-5 w-5 ${isArchived ? "text-emerald-700" : "text-red-700"}`} /><div><h2 className="font-semibold">{isArchived ? "Studio is archived" : "Archive this studio"}</h2><p className="mt-1 text-sm text-slate-600">{isArchived ? "Restore access when the audit or support hold is complete." : "Archiving blocks access and revokes desktop tokens without deleting projects, photos, or audit records."}</p></div></div><button disabled={busy !== null} onClick={() => void mutate("lifecycle", `/api/platform/studios/${studioId}/lifecycle`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: isArchived ? "restore" : "archive", reason: isArchived ? "" : "Archived from platform oversight console" }) }, isArchived ? "Studio restored" : "Studio archived")} className={`inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold text-white ${isArchived ? "bg-emerald-700" : "bg-red-700"}`}><CalendarClock className="h-4 w-4" />{isArchived ? "Restore studio" : "Archive safely"}</button></div>
        </section>
      </div>
    </div>
  );
}