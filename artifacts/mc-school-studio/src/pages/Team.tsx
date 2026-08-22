import { useEffect, useState } from "react";
import { Users, UserPlus } from "lucide-react";

type Member = { id: number; email: string; role: string; status: string; userId: string };
type Invite = { id: number; email: string; role: string; status: string };
type DesktopConnection = { id: number; memberId: number; memberEmail: string; deviceName: string; tokenPrefix: string; status: "active" | "revoked"; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };
type TeamData = { currentMember: Member; members: Member[]; invites: Invite[]; projects: { id: number; schoolName: string }[]; assignments: { projectId: number; memberId: number }[]; desktopConnections: DesktopConnection[] };

export default function Team() {
  const [data, setData] = useState<TeamData | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("photographer");
  const [saving, setSaving] = useState(false);
  const [assignmentProjectId, setAssignmentProjectId] = useState("");
  const [assignmentMemberIds, setAssignmentMemberIds] = useState<number[]>([]);
  const [desktopMemberId, setDesktopMemberId] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [desktopSaving, setDesktopSaving] = useState(false);
  const [desktopError, setDesktopError] = useState<string | null>(null);
  const [newDesktopToken, setNewDesktopToken] = useState<string | null>(null);
  const load = () => fetch("/api/team").then((res) => res.ok ? res.json() : Promise.reject()).then(setData);
  useEffect(() => { void load(); }, []);
  const canManage = data?.currentMember.role === "owner" || data?.currentMember.role === "admin";
  async function invite(event: React.FormEvent) {
    event.preventDefault(); setSaving(true);
    const res = await fetch("/api/team/invites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, role }) });
    setSaving(false); if (res.ok) { setEmail(""); await load(); }
  }
  async function updateRole(memberId: number, nextRole: string) {
    await fetch(`/api/team/members/${memberId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: nextRole }) }); await load();
  }
  async function saveAssignments() {
    if (!assignmentProjectId) return;
    await fetch(`/api/team/projects/${assignmentProjectId}/assignments`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memberIds: assignmentMemberIds }) });
    await load();
  }
  async function createDesktopConnection(event: React.FormEvent) {
    event.preventDefault();
    setDesktopSaving(true); setDesktopError(null); setNewDesktopToken(null);
    try {
      const res = await fetch("/api/team/desktop-connections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memberId: Number(desktopMemberId), deviceName }) });
      const body = await res.json().catch(() => ({})) as { token?: string; error?: string };
      if (!res.ok || !body.token) { setDesktopError(body.error ?? "Could not create the desktop connection."); return; }
      setNewDesktopToken(body.token);
      setDeviceName("");
      await load();
    } finally {
      setDesktopSaving(false);
    }
  }
  async function revokeDesktopConnection(connection: DesktopConnection) {
    if (!window.confirm(`Revoke ${connection.deviceName}? That computer will stop seeing cloud projects and uploading photos immediately.`)) return;
    const res = await fetch(`/api/team/desktop-connections/${connection.id}`, { method: "DELETE" });
    if (!res.ok) { setDesktopError("Could not revoke the desktop connection."); return; }
    await load();
  }
  if (!data) return <div className="p-8 text-slate-500">Loading your studio team…</div>;
  return <div className="flex-1 overflow-auto bg-slate-50 p-8">
    <div className="mx-auto max-w-5xl space-y-6">
      <div><div className="flex items-center gap-3"><div className="rounded-lg bg-teal-100 p-2 text-teal-700"><Users className="h-6 w-6" /></div><div><h1 className="text-3xl font-bold text-slate-900">Studio team</h1><p className="mt-1 text-slate-500">Control who can access and prepare your school photo projects.</p></div></div></div>
      {canManage && <form onSubmit={invite} className="rounded-xl border bg-white p-5 shadow-sm">
        <h2 className="font-semibold text-slate-900">Invite a teammate</h2><p className="mt-1 text-sm text-slate-500">They’ll gain access when they sign in with this email address.</p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row"><input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="photographer@example.com" className="h-10 flex-1 rounded-md border border-slate-300 px-3 text-sm" />
          <select value={role} onChange={(e) => setRole(e.target.value)} className="h-10 rounded-md border border-slate-300 px-3 text-sm"><option value="admin">Admin</option><option value="assistant">Assistant</option><option value="photographer">Photographer</option><option value="viewer">Viewer</option></select>
          <button disabled={saving} className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-teal-600 px-4 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-60"><UserPlus className="h-4 w-4" />Invite</button></div>
      </form>}
      <div className="overflow-hidden rounded-xl border bg-white shadow-sm"><div className="border-b px-6 py-4"><h2 className="font-semibold text-slate-900">Members</h2></div>
        <div className="divide-y">{data.members.filter((member) => member.status === "active").map((member) => <div key={member.id} className="flex items-center justify-between gap-4 px-6 py-4"><div><p className="font-medium text-slate-900">{member.email}</p><p className="text-sm capitalize text-slate-500">{member.role}{member.id === data.currentMember.id ? " · You" : ""}</p></div>{canManage && member.role !== "owner" ? <select aria-label={`Role for ${member.email}`} value={member.role} onChange={(e) => void updateRole(member.id, e.target.value)} className="h-9 rounded-md border border-slate-300 px-2 text-sm"><option value="admin">Admin</option><option value="assistant">Assistant</option><option value="photographer">Photographer</option><option value="viewer">Viewer</option></select> : <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium capitalize text-slate-600">{member.role}</span>}</div>)}</div>
      </div>
      {canManage && <div className="rounded-xl border bg-white p-5 shadow-sm">
        <h2 className="font-semibold text-slate-900">Project assignments</h2><p className="mt-1 text-sm text-slate-500">Assign assistants and photographers to the projects they should see.</p>
        <div className="mt-4 grid gap-3 md:grid-cols-[1fr_1.4fr_auto]"><select value={assignmentProjectId} onChange={(e) => { const id = e.target.value; setAssignmentProjectId(id); setAssignmentMemberIds(data.assignments.filter((item) => item.projectId === Number(id)).map((item) => item.memberId)); }} className="h-10 rounded-md border border-slate-300 px-3 text-sm"><option value="">Choose a project</option>{data.projects.map((project) => <option key={project.id} value={project.id}>{project.schoolName}</option>)}</select>
          <select multiple value={assignmentMemberIds.map(String)} onChange={(e) => setAssignmentMemberIds(Array.from(e.currentTarget.selectedOptions).map((option) => Number(option.value)))} className="h-24 rounded-md border border-slate-300 px-3 py-2 text-sm" aria-label="Assigned team members">{data.members.filter((member) => member.status === "active" && member.role !== "owner" && member.role !== "admin").map((member) => <option key={member.id} value={member.id}>{member.email} · {member.role}</option>)}</select>
          <button type="button" onClick={() => void saveAssignments()} disabled={!assignmentProjectId} className="h-10 rounded-md bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">Save access</button></div>
      </div>}
       {canManage && <div className="rounded-xl border bg-white p-5 shadow-sm">
         <h2 className="font-semibold text-slate-900">Desktop connections</h2><p className="mt-1 text-sm text-slate-500">Create one token per computer. It inherits the selected member’s project assignments.</p>
         <form onSubmit={(event) => void createDesktopConnection(event)} className="mt-4 grid gap-3 md:grid-cols-[1fr_1.4fr_auto]">
           <select required value={desktopMemberId} onChange={(e) => setDesktopMemberId(e.target.value)} className="h-10 rounded-md border border-slate-300 px-3 text-sm" aria-label="Desktop connection member"><option value="">Choose a member</option>{data.members.filter((member) => member.status === "active" && (member.role === "assistant" || member.role === "photographer")).map((member) => <option key={member.id} value={member.id}>{member.email} · {member.role}</option>)}</select>
           <input required value={deviceName} onChange={(e) => setDeviceName(e.target.value)} maxLength={100} placeholder="e.g. Studio MacBook 1" className="h-10 rounded-md border border-slate-300 px-3 text-sm" />
           <button disabled={!desktopMemberId || !deviceName.trim() || desktopSaving} className="h-10 rounded-md bg-teal-600 px-4 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50">{desktopSaving ? "Creating…" : "Create token"}</button>
         </form>
         {desktopError && <p role="alert" className="mt-3 text-sm text-red-600">{desktopError}</p>}
         {newDesktopToken && <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4"><p className="text-sm font-medium text-amber-900">Copy this token now — it will not be shown again.</p><textarea readOnly value={newDesktopToken} onFocus={(event) => event.currentTarget.select()} aria-label="New desktop connection token" className="mt-2 h-16 w-full resize-none rounded border border-amber-300 bg-white p-2 font-mono text-xs text-slate-800" /></div>}
         {data.desktopConnections.length > 0 && <div className="mt-5 divide-y rounded-lg border">{data.desktopConnections.map((connection) => <div key={connection.id} className="flex items-center justify-between gap-4 px-4 py-3"><div className="min-w-0"><p className="font-medium text-slate-900">{connection.deviceName}</p><p className="mt-0.5 text-xs text-slate-500">{connection.memberEmail} · {connection.tokenPrefix}… · {connection.status === "active" ? (connection.lastUsedAt ? `Last used ${new Date(connection.lastUsedAt).toLocaleString()}` : "Not used yet") : "Revoked"}</p></div>{data.currentMember.role === "owner" && connection.status === "active" && <button type="button" onClick={() => void revokeDesktopConnection(connection)} className="shrink-0 rounded-md border border-red-200 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50">Revoke</button>}</div>)}</div>}
       </div>}
      {data.invites.filter((invite) => invite.status === "pending").length > 0 && <div className="rounded-xl border border-amber-200 bg-amber-50 p-5"><h2 className="font-semibold text-amber-900">Pending invitations</h2>{data.invites.filter((invite) => invite.status === "pending").map((invite) => <p key={invite.id} className="mt-2 text-sm text-amber-800">{invite.email} · {invite.role}</p>)}</div>}
    </div>
  </div>;
}