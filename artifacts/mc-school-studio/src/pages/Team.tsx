import { useEffect, useState } from "react";
import { Users, UserPlus } from "lucide-react";

type Member = { id: number; email: string; role: string; status: string; userId: string };
type Invite = { id: number; email: string; role: string; status: string };
type TeamData = { currentMember: Member; members: Member[]; invites: Invite[]; projects: { id: number; schoolName: string }[]; assignments: { projectId: number; memberId: number }[] };

export default function Team() {
  const [data, setData] = useState<TeamData | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("photographer");
  const [saving, setSaving] = useState(false);
  const [assignmentProjectId, setAssignmentProjectId] = useState("");
  const [assignmentMemberIds, setAssignmentMemberIds] = useState<number[]>([]);
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
      {data.invites.filter((invite) => invite.status === "pending").length > 0 && <div className="rounded-xl border border-amber-200 bg-amber-50 p-5"><h2 className="font-semibold text-amber-900">Pending invitations</h2>{data.invites.filter((invite) => invite.status === "pending").map((invite) => <p key={invite.id} className="mt-2 text-sm text-amber-800">{invite.email} · {invite.role}</p>)}</div>}
    </div>
  </div>;
}