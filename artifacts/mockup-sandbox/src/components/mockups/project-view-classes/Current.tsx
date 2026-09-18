import { useMemo, useState } from "react";
import {
  ArrowLeft,
  CheckCircle,
  ChevronRight,
  CloudUpload,
  Download,
  Folder,
  FolderSync,
  Image,
  LayoutDashboard,
  Plus,
  Search,
  Settings,
  Square,
  Star,
  Upload,
  User,
  UsersRound,
} from "lucide-react";
import "./_group.css";

type ClassItem = { id: string; name: string; count: number };
type Student = { id: string; name: string; classId: string; captures: number; uploaded?: boolean };

const classes: ClassItem[] = [
  { id: "5a", name: "Class 5A", count: 21 },
  { id: "5b", name: "Class 5B", count: 21 },
  { id: "6a", name: "Class 6A", count: 19 },
];

const students: Student[] = [
  { id: "0247", name: "Maya Chen", classId: "5a", captures: 4, uploaded: true },
  { id: "0248", name: "Jordan Williams", classId: "5a", captures: 0 },
  { id: "0249", name: "Sofia Martinez", classId: "5a", captures: 2, uploaded: true },
  { id: "0250", name: "Ethan Nguyen", classId: "5b", captures: 1 },
  { id: "0251", name: "Aaliyah Johnson", classId: "5b", captures: 0 },
  { id: "0252", name: "Liam O'Connor", classId: "6a", captures: 3, uploaded: true },
  { id: "0253", name: "Grace Park", classId: "6a", captures: 0 },
];

const captures = [
  { frame: "001", time: "14:21:48", rating: 3, label: "JPEG + RAW" },
  { frame: "002", time: "14:22:05", rating: 4, label: "JPEG + RAW" },
  { frame: "003", time: "14:23:12", rating: 5, label: "JPEG only" },
  { frame: "004", time: "14:24:08", rating: 0, label: "Needs review" },
];

function SidebarHint({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <div className="group/sidebar-hint relative w-full">
      {children}
      <div
        role="tooltip"
        className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 w-max max-w-64 -translate-y-1/2 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-[11px] font-medium leading-4 text-white opacity-0 shadow-xl transition-opacity duration-150 group-hover/sidebar-hint:opacity-100 group-focus-within/sidebar-hint:opacity-100"
      >
        {text}
      </div>
    </div>
  );
}

function RatingStars({ rating }: { rating: number }) {
  return (
    <div className="flex items-center gap-0.5" aria-label={`${rating} out of 5 stars`}>
      {Array.from({ length: 5 }, (_, index) => (
        <button key={index} type="button" aria-label={`Rate ${index + 1} out of 5`} className="rounded p-0.5 hover:bg-amber-50">
          <Star className="size-3.5 text-amber-400" fill={index < rating ? "currentColor" : "none"} />
        </button>
      ))}
    </div>
  );
}

function StudentStatus({ student }: { student: Student }) {
  if (!student.captures) return <span className="text-[10px] font-bold text-slate-400">No captures</span>;
  return (
    <span className={`flex items-center gap-1 text-[10px] font-bold ${student.uploaded ? "text-emerald-600" : "text-amber-600"}`}>
      {student.uploaded ? <CheckCircle className="size-3" /> : <Upload className="size-3" />}
      {student.captures}
    </span>
  );
}

export function Current() {
  const [classesOpen, setClassesOpen] = useState(true);
  const [selectedClass, setSelectedClass] = useState<string | null>(null);
  const [selectedStudent, setSelectedStudent] = useState(students[0]);
  const [query, setQuery] = useState("");
  const [live, setLive] = useState(true);
  const [groups, setGroups] = useState<string[]>([]);
  const [isGroupComposerOpen, setIsGroupComposerOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");

  const visibleStudents = useMemo(
    () =>
      students.filter((student) => {
        const matchesClass = selectedClass === null || student.classId === selectedClass;
        const matchesQuery = `${student.name} ${student.id}`.toLowerCase().includes(query.toLowerCase());
        return matchesClass && matchesQuery;
      }),
    [query, selectedClass],
  );
  const selectedClassName = selectedClass ? classes.find((item) => item.id === selectedClass)?.name : "All classes";
  const addGroup = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = newGroupName.trim();
    if (!trimmedName) return;
    setGroups((currentGroups) => [...currentGroups, trimmedName]);
    setNewGroupName("");
    setIsGroupComposerOpen(false);
  };

  return (
    <main className="project-view-preview flex min-h-screen flex-col overflow-hidden bg-slate-50 text-slate-900">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="app-rail flex w-[190px] shrink-0 flex-col bg-[#0f172a] text-slate-300">
          <div className="flex h-16 shrink-0 items-center gap-2.5 border-b border-white/10 px-4">
            <div className="flex size-8 items-center justify-center overflow-hidden rounded-lg bg-black">
              <div className="text-lg">◉</div>
            </div>
            <span className="text-sm font-semibold leading-tight text-white">Volume<br />Capture</span>
          </div>
          <nav className="flex-1 space-y-1 px-3 py-4">
            <SidebarHint text="Return to the project list.">
              <button type="button" className="flex h-9 w-full items-center justify-start gap-3 rounded-md bg-white/10 px-3 text-sm text-white">
                <LayoutDashboard className="size-4" />
                Projects
              </button>
            </SidebarHint>
            <div className="ml-1 mt-2">
              <SidebarHint text={classesOpen ? "Hide this project's classes." : "Show this project's classes."}>
                <button
                  type="button"
                  aria-expanded={classesOpen}
                  onClick={() => setClassesOpen((open) => !open)}
                  className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-xs text-slate-400 transition-colors hover:bg-white/5 hover:text-white"
                >
                  <ChevronRight className={`size-3 shrink-0 transition-transform ${classesOpen ? "rotate-90" : ""}`} />
                  <span className="truncate">Lincoln High School</span>
                </button>
              </SidebarHint>
              {classesOpen && (
                <div className="mt-1 space-y-0.5 pl-4">
                  <SidebarHint text="Show students from every class.">
                    <button
                      type="button"
                      onClick={() => setSelectedClass(null)}
                      className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[11px] ${selectedClass === null ? "bg-white/10 font-semibold text-white" : "text-slate-500 hover:bg-white/5 hover:text-slate-200"}`}
                    >
                      <span>All classes</span>
                      <span className="text-[10px] text-slate-500">61</span>
                    </button>
                  </SidebarHint>
                  {classes.map((item) => (
                    <SidebarHint key={item.id} text={`Show students from ${item.name}.`}>
                      <button
                        type="button"
                        onClick={() => setSelectedClass(item.id)}
                        className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[11px] ${selectedClass === item.id ? "bg-teal-500/15 font-semibold text-teal-300" : "text-slate-500 hover:bg-white/5 hover:text-slate-200"}`}
                      >
                        <span className="truncate">{item.name}</span>
                        <span className="shrink-0 text-[10px] text-slate-500">{item.count}</span>
                      </button>
                    </SidebarHint>
                  ))}
                </div>
              )}
              <div className="mt-4 border-t border-white/10 pt-3">
                <div className="flex items-center justify-between px-2 pb-1.5">
                  <span className="text-[10px] font-extrabold uppercase tracking-widest text-slate-500">Groups</span>
                  <button
                    type="button"
                    onClick={() => setIsGroupComposerOpen((open) => !open)}
                    aria-expanded={isGroupComposerOpen}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-bold text-teal-300 transition-colors hover:bg-white/10 hover:text-teal-200"
                  >
                    <Plus className="size-3" /> Add
                  </button>
                </div>
                {isGroupComposerOpen && (
                  <form onSubmit={addGroup} className="mb-2 flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 p-1.5">
                    <input
                      autoFocus
                      value={newGroupName}
                      onChange={(event) => setNewGroupName(event.target.value)}
                      placeholder="Group name"
                      aria-label="New group name"
                      className="min-w-0 flex-1 rounded-md border border-white/10 bg-slate-950 px-2 py-1.5 text-[11px] text-white outline-none placeholder:text-slate-600 focus:border-teal-400"
                    />
                    <button type="submit" className="rounded-md bg-teal-600 px-2 py-1.5 text-[9px] font-extrabold uppercase tracking-wider text-white hover:bg-teal-500">Add</button>
                  </form>
                )}
                <div className="space-y-0.5">
                  {groups.length === 0 ? (
                    <p className="px-2 py-1 text-[10px] italic text-slate-600">No groups yet</p>
                  ) : (
                    groups.map((group) => (
                      <button key={group} type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] text-slate-400 transition-colors hover:bg-white/5 hover:text-white">
                        <UsersRound className="size-3.5 text-slate-500" />
                        <span className="truncate">{group}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            </div>
          </nav>
          <div className="border-t border-white/10 px-3 pb-4 pt-3">
            <SidebarHint text="Open desktop settings.">
              <button type="button" className="flex h-9 w-full items-center justify-start gap-3 rounded-md px-3 text-sm text-slate-300 hover:bg-white/10 hover:text-white">
                <Settings className="size-4" />
                Settings
              </button>
            </SidebarHint>
            <p className="mt-3 px-2 text-[10px] text-slate-500">Volume Capture v1.0.71</p>
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-900 bg-slate-950 px-5 py-3 shadow-sm">
            <div className="flex min-w-0 items-center gap-4">
              <button type="button" aria-label="Back to projects" className="rounded-md bg-slate-900 p-1.5 text-slate-400 hover:text-white">
                <ArrowLeft className="size-4" />
              </button>
              <div className="min-w-0">
                <h1 className="truncate text-base font-extrabold tracking-tight text-white">Lincoln High School</h1>
                <div className="mt-0.5 flex items-center gap-2.5 whitespace-nowrap text-[11px] font-medium text-slate-400">
                  <span>3 classes</span><i className="size-1 rounded-full bg-slate-700" /><span>61 students</span><i className="size-1 rounded-full bg-slate-700" /><span>24 captures</span>
                </div>
              </div>
            </div>
            <button type="button" className="flex h-8 shrink-0 items-center bg-blue-600 px-4 text-[10px] font-bold uppercase tracking-wider text-white shadow-md hover:bg-blue-500">
              <CloudUpload className="mr-1.5 size-3.5" /> Finish My Shoot
            </button>
          </header>

          <div className="flex min-h-0 flex-1 overflow-hidden">
            <aside className="roster-panel flex w-[320px] shrink-0 flex-col overflow-y-auto border-r border-slate-200 bg-white shadow-[4px_0_24px_rgba(0,0,0,0.02)]">
              <details open className="shrink-0 border-b border-slate-200 bg-slate-50/80">
                <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-[10px] font-extrabold uppercase tracking-widest text-slate-600 hover:bg-slate-100">
                  <span>Project actions</span><ChevronRight className="summary-chevron size-4" />
                </summary>
                <div className="space-y-2 px-3 pb-3">
                  <div className={`flex h-9 items-center overflow-hidden rounded-md border ${live ? "border-teal-500/20 bg-teal-500/10" : "border-slate-200 bg-white"}`}>
                    <div className="flex min-w-0 flex-1 items-center gap-2 px-3"><span className={`size-2 rounded-full ${live ? "bg-teal-400 shadow-[0_0_8px_rgba(45,212,191,.6)]" : "bg-slate-400"}`} /><span className={`truncate text-[10px] font-bold uppercase tracking-wider ${live ? "text-teal-700" : "text-slate-500"}`}>{live ? "Live" : "Paused"}</span></div>
                    <button type="button" onClick={() => setLive(!live)} className="flex h-full items-center gap-1 px-3 text-[10px] font-bold uppercase tracking-wider text-teal-700">{live ? <Square className="size-3 fill-current" /> : <CloudUpload className="size-3" />}{live ? "Stop" : "Start"}</button><button type="button" aria-label="Change watch folder" className="h-full border-l border-slate-200 px-2.5 text-slate-500"><Folder className="size-3.5" /></button>
                  </div>
                  <button type="button" className="flex h-9 w-full items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-left text-[10px] font-bold uppercase tracking-wider text-slate-600 hover:bg-slate-100"><FolderSync className="size-3.5" /> Consolidate folders</button>
                  <button type="button" className="hidden w-full items-center justify-between rounded-md border border-slate-200 bg-white px-3 py-2 text-left hover:bg-slate-100 xl:flex"><span><span className="flex items-center gap-1.5 text-[11px]"><Image className="size-3.5 text-emerald-600" /> Local folder ready</span><span className="mt-1 flex items-center gap-1.5 text-[11px]"><CloudUpload className="size-3.5 text-teal-600" /> Cloud queue clear</span></span><ChevronRight className="size-3 text-slate-400" /></button>
                  <div className="flex h-9 w-full overflow-hidden rounded-md border border-blue-200 bg-blue-50"><button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 px-3 text-[10px] font-bold uppercase tracking-wider text-blue-700"><Upload className="size-3.5" /> Live Upload On</button><button type="button" className="border-l border-blue-200 px-2.5 text-[10px] font-bold text-blue-700">Status</button></div>
                  <div className="flex h-9 w-full overflow-hidden rounded-md border border-slate-200 bg-white"><select aria-label="Choose captures to export" className="min-w-0 flex-1 bg-transparent px-2 text-[10px] font-bold uppercase tracking-wider text-slate-600"><option>All captures</option><option>Paired</option><option>Favorites</option></select><button type="button" aria-label="Export captures" className="border-l border-slate-200 px-2.5 text-slate-600"><Download className="size-3" /></button></div>
                </div>
              </details>

              <div className="border-b border-slate-100 bg-slate-50/50 p-3">
                <div className="relative">
                  <Search className="absolute left-3 top-2.5 size-4 text-slate-400" />
                  <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${selectedClassName?.toLowerCase() ?? "students"}...`} className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm shadow-sm outline-none focus:border-teal-500" />
                </div>
                <div className="mt-2 flex items-center justify-between gap-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">
                  <span>Students · {visibleStudents.length}</span>
                  <button type="button" aria-label="Add student" title="Add student or person" className="flex size-7 items-center justify-center rounded-md bg-slate-900 text-white"><Plus className="size-3.5" /></button>
                </div>
              </div>

              <div className="flex-1">
                <div className="pb-2">
                  {visibleStudents.map((student) => (
                    <button type="button" key={student.id} onClick={() => setSelectedStudent(student)} className={`flex w-full items-center gap-3 border-b border-slate-100 border-l-2 px-4 py-3 text-left transition ${selectedStudent.id === student.id ? "border-l-teal-500 bg-teal-50/60" : "border-l-transparent hover:bg-slate-50"}`}>
                      <div className={`flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${selectedStudent.id === student.id ? "bg-teal-600 text-white" : "bg-slate-100 text-slate-500"}`}><User className="size-4" /></div>
                      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold text-slate-800">{student.name}</span><span className="block text-[10px] text-slate-400">LHS-{student.id} · {classes.find((item) => item.id === student.classId)?.name}</span></span>
                      <StudentStatus student={student} />
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 border-t border-slate-200 bg-slate-50 p-2 text-[9px] font-medium text-slate-500"><span><kbd>/</kbd> Search</span><span><kbd>↑↓</kbd> Navigate</span><span><kbd>Esc</kbd> Clear</span></div>
            </aside>

            <section className="min-w-0 flex-1 overflow-y-auto bg-slate-50 p-5">
              <div className="mb-5 flex items-center justify-between"><div><p className="text-[10px] font-extrabold uppercase tracking-widest text-teal-600">Capture review</p><h2 className="mt-1 text-2xl font-extrabold tracking-tight text-slate-900">{selectedStudent.name}</h2><p className="mt-1 text-sm text-slate-500">{selectedClassName} · LHS-{selectedStudent.id} · {selectedStudent.captures} captures</p></div><button type="button" className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-600"><span>QR</span> Show QR</button></div>
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">{captures.map((capture) => <article key={capture.frame} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className={`capture-card relative flex aspect-square items-end justify-between p-3 capture-${capture.frame}`}><span className="rounded bg-slate-900/70 px-2 py-1 text-[9px] font-bold text-white">FRAME {capture.frame}</span><span className="rounded bg-white/85 px-2 py-1 text-[9px] font-bold text-slate-700">{capture.time}</span></div><div className="space-y-2 p-3"><div className="flex items-center justify-between"><span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{capture.label}</span><RatingStars rating={capture.rating} /></div><button type="button" className="w-full rounded-lg bg-slate-100 py-2 text-[10px] font-extrabold uppercase tracking-wider text-slate-700 hover:bg-slate-200">Open capture</button></div></article>)}</div>
            </section>
          </div>
        </section>
      </div>
    </main>
  );
}