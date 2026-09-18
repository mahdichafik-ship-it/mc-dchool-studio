import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft, CheckCircle, ChevronRight, CloudUpload, Download, Folder,
  FolderSync, Image, Plus, Search, Square, Star, Upload, User, QrCode,
} from "lucide-react";
import "./_group.css";

type Student = { name: string; id: string; className: string; captures: number; uploaded?: boolean };
const students: Student[] = [
  { name: "Maya Chen", id: "LHS-0247", className: "Class 5A", captures: 4, uploaded: true },
  { name: "Jordan Williams", id: "LHS-0248", className: "Class 5A", captures: 0 },
  { name: "Sofia Martinez", id: "LHS-0249", className: "Class 5A", captures: 2, uploaded: true },
  { name: "Ethan Nguyen", id: "LHS-0250", className: "Class 5A", captures: 1 },
  { name: "Aaliyah Johnson", id: "LHS-0251", className: "Class 5A", captures: 0 },
  { name: "Liam O'Connor", id: "LHS-0252", className: "Class 5B", captures: 3, uploaded: true },
  { name: "Grace Park", id: "LHS-0253", className: "Class 5B", captures: 0 },
];
const captures = [
  { frame: "001", time: "14:21:48", rating: 3, label: "JPEG + RAW" },
  { frame: "002", time: "14:22:05", rating: 4, label: "JPEG + RAW" },
  { frame: "003", time: "14:23:12", rating: 5, label: "JPEG only" },
  { frame: "004", time: "14:24:08", rating: 0, label: "Needs review" },
];

function Status({ uploaded, captures: count }: Pick<Student, "uploaded" | "captures">) {
  if (!count) return <span className="text-[10px] font-bold text-slate-400">No captures</span>;
  return <span className={`flex items-center gap-1 text-[10px] font-bold ${uploaded ? "text-emerald-600" : "text-amber-600"}`}>
    {uploaded ? <CheckCircle className="size-3" /> : <Upload className="size-3" />} {count}
  </span>;
}

function RatingStars({ rating }: { rating: number }) {
  return (
    <div className="flex items-center gap-0.5" aria-label={`${rating} out of 5 stars`}>
      {Array.from({ length: 5 }, (_, index) => (
        <button
          key={index}
          type="button"
          title={`Rate ${index + 1} out of 5`}
          aria-label={`Rate ${index + 1} out of 5`}
          data-help={`Set this capture to ${index + 1} out of 5 stars.`}
          className="rounded p-0.5 hover:bg-amber-50"
        >
          <Star className="size-3.5 text-amber-400" fill={index < rating ? "currentColor" : "none"} />
        </button>
      ))}
    </div>
  );
}

function HoverHelp() {
  const [help, setHelp] = useState<{ text: string; left: number; top: number; above: boolean } | null>(null);

  useEffect(() => {
    const show = (target: EventTarget | null) => {
      const element = target instanceof Element ? target.closest<HTMLElement>("[data-help]") : null;
      const text = element?.dataset.help;
      if (!element || !text) return;
      const rect = element.getBoundingClientRect();
      const above = rect.bottom + 70 > window.innerHeight;
      setHelp({
        text,
        left: Math.min(Math.max(rect.left + rect.width / 2, 140), window.innerWidth - 140),
        top: above ? rect.top - 8 : rect.bottom + 8,
        above,
      });
    };
    const hide = () => setHelp(null);
    const onPointerOver = (event: PointerEvent) => show(event.target);
    const onPointerOut = (event: PointerEvent) => {
      const current = event.target instanceof Element ? event.target.closest("[data-help]") : null;
      const next = event.relatedTarget instanceof Element ? event.relatedTarget.closest("[data-help]") : null;
      if (current !== next) hide();
    };
    const onFocusIn = (event: FocusEvent) => show(event.target);
    const onFocusOut = () => hide();
    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointerout", onPointerOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  if (!help) return null;
  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-[100] max-w-[260px] -translate-x-1/2 rounded-md bg-slate-950 px-3 py-2 text-center text-[11px] font-medium leading-4 text-white shadow-xl"
      style={{ left: help.left, top: help.top, transform: `translate(-50%, ${help.above ? "-100%" : "0"})` }}
    >
      {help.text}
    </div>
  );
}

export function ProjectSidebar() {
  const [selected, setSelected] = useState(students[0]);
  const [query, setQuery] = useState("");
  const [live, setLive] = useState(true);
  const visible = useMemo(() => students.filter((s) => `${s.name} ${s.id}`.toLowerCase().includes(query.toLowerCase())), [query]);

  return (
    <main className="project-sidebar-mockup flex h-screen min-h-[720px] flex-col overflow-hidden bg-slate-50">
      <HoverHelp />
      <header className="toolbar z-10 flex shrink-0 flex-wrap items-center justify-between gap-y-3 border-b border-slate-900 bg-slate-950 px-6 py-3 shadow-sm">
        <div className="flex min-w-0 items-center gap-5">
          <button data-help="Return to the full project list." className="rounded-md bg-slate-900 p-1.5 text-slate-400 hover:text-white" aria-label="Back to projects"><ArrowLeft className="size-4" /></button>
          <div className="min-w-0">
            <h1 className="truncate text-base font-extrabold tracking-tight text-white">Lincoln High School</h1>
            <div className="mt-0.5 flex items-center gap-2.5 whitespace-nowrap text-[11px] font-medium text-slate-400">
              <span>4 classes</span><i className="size-1 rounded-full bg-slate-700" /><span>128 students</span><i className="size-1 rounded-full bg-slate-700 sm:hidden" /><span className="text-slate-300 sm:hidden">24 captures</span>
            </div>
          </div>
        </div>
        <button data-help="Review pending work, upload this photographer's files, and finish the shoot." className="flex h-8 items-center bg-blue-600 px-4 text-[10px] font-bold uppercase tracking-wider text-white shadow-md hover:bg-blue-500"><CloudUpload className="mr-1.5 size-3.5" /><span className="finish-label">Finish My Shoot</span></button>
      </header>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="roster-panel sidebar-scroll z-[1] flex w-[340px] shrink-0 flex-col overflow-y-auto border-r border-slate-200 bg-white shadow-[4px_0_24px_rgba(0,0,0,0.02)]">
          <details open className="shrink-0 border-b border-slate-200 bg-slate-50/80">
            <summary data-help="Show or hide the project tools used during and after the shoot." className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-[10px] font-extrabold uppercase tracking-widest text-slate-600 hover:bg-slate-100">
              <span>Project actions</span><ChevronRight className="summary-chevron size-4 transition-transform" />
            </summary>
            <div className="space-y-2 px-3 pb-3">
              <div className={`flex h-9 items-center overflow-hidden rounded-md border ${live ? "border-teal-500/20 bg-teal-500/10" : "border-slate-200 bg-white"}`}>
                <div className="flex min-w-0 flex-1 items-center gap-2 px-3"><span className={`size-2 rounded-full ${live ? "bg-teal-400 shadow-[0_0_8px_rgba(45,212,191,.6)]" : "bg-slate-400"}`} /><span className={`truncate text-[10px] font-bold uppercase tracking-wider ${live ? "text-teal-700" : "text-slate-500"}`}>{live ? "Live" : "Paused"}</span></div>
                <button data-help={live ? "Stop watching the selected folder for new camera files." : "Start watching the selected folder for new camera files."} onClick={() => setLive(!live)} className="flex h-full items-center gap-1 px-3 text-[10px] font-bold uppercase tracking-wider text-teal-700">{live ? <Square className="size-3 fill-current" /> : <CloudUpload className="size-3" />}{live ? "Stop" : "Start"}</button><button data-help="Choose the folder where new camera files arrive." className="h-full border-l border-slate-200 px-2.5 text-slate-500" aria-label="Change watch folder"><Folder className="size-3.5" /></button>
              </div>
              <button data-help="Copy files from older student folders into the current folder structure without deleting originals." className="flex h-9 w-full items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-left text-[10px] font-bold uppercase tracking-wider text-slate-600 hover:bg-slate-100"><FolderSync className="size-3.5" /> Consolidate folders</button>
              <button data-help="Open the local-folder and cloud-upload activity details." className="hidden w-full items-center justify-between rounded-md border border-slate-200 bg-white px-3 py-2 text-left hover:bg-slate-100 xl:flex"><span><span className="flex items-center gap-1.5 text-[11px]"><Image className="size-3.5 text-emerald-600" /> Local folder ready</span><span className="mt-1 flex items-center gap-1.5 text-[11px]"><CloudUpload className="size-3.5 text-teal-600" /> Cloud queue clear</span></span><ChevronRight className="size-3 text-slate-400" /></button>
              <div className="flex h-9 w-full overflow-hidden rounded-md border border-blue-200 bg-blue-50"><button data-help="Upload the six files currently waiting in the local queue." className="flex min-w-0 flex-1 items-center gap-1.5 px-3 text-[10px] font-bold uppercase tracking-wider text-blue-700"><Upload className="size-3.5" /> Upload 6</button><button data-help="Open detailed upload progress, queued files, and errors." className="border-l border-blue-200 px-2.5 text-[10px] font-bold text-blue-700">Status</button></div>
              <div className="flex h-9 w-full overflow-hidden rounded-md border border-slate-200 bg-white"><select data-help="Choose which captures to include in the export." aria-label="Choose captures to export" className="min-w-0 flex-1 bg-transparent px-2 text-[10px] font-bold uppercase tracking-wider text-slate-600"><option>All captures</option><option>Paired</option><option>Favorites</option></select><button data-help="Export the selected captures to a folder you choose." aria-label="Export selected captures" className="border-l border-slate-200 px-2.5 text-[10px] font-bold text-slate-600"><Download className="size-3" /></button></div>
            </div>
          </details>
          <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-100 p-2"><button data-help="Show every student in this project." className="rounded-md bg-slate-900 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-white">All (128)</button><button data-help="Show only students in Class 5A." className="rounded-md px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:bg-slate-100">Class 5A</button><button data-help="Show only students in Class 5B." className="rounded-md px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:bg-slate-100">Class 5B</button></div>
          <div className="flex gap-2 border-b border-slate-100 bg-slate-50/50 p-3"><div className="relative flex-1"><Search className="absolute left-3 top-2.5 size-4 text-slate-400" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search students..." className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm shadow-sm outline-none focus:border-teal-500" /></div><button data-help="Add a student to this project and select them for capture." aria-label="Add student" className="flex size-[38px] items-center justify-center rounded-lg bg-slate-900 text-white"><Plus className="size-4" /></button></div>
          <div className="flex-1">{visible.map((student) => <button data-help={`Select ${student.name} as the active student for capture and review.`} key={student.id} onClick={() => setSelected(student)} className={`flex w-full items-center gap-3 border-b border-slate-100 px-4 py-3 text-left transition ${selected.id === student.id ? "border-l-2 border-l-teal-500 bg-teal-50/60" : "border-l-2 border-l-transparent hover:bg-slate-50"}`}><div className={`flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${selected.id === student.id ? "bg-teal-600 text-white" : "bg-slate-100 text-slate-500"}`}><User className="size-4" /></div><span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold text-slate-800">{student.name}</span><span className="block text-[10px] text-slate-400">{student.id} · {student.className}</span></span><Status uploaded={student.uploaded} captures={student.captures} /></button>)}</div>
        </aside>
        <section className="min-w-0 flex-1 overflow-y-auto bg-slate-50 p-5">
          <div className="workspace-title mb-5 flex items-center justify-between"><div><p className="text-[10px] font-extrabold uppercase tracking-widest text-teal-600">Capture review</p><h2 className="mt-1 text-2xl font-extrabold tracking-tight text-slate-900">{selected.name}</h2><p className="mt-1 text-sm text-slate-500">{selected.className} · {selected.id} · {selected.captures} captures</p></div><button data-help="Display this student's QR code for identification during capture." className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-600"><QrCode className="size-3.5" /> Show QR</button></div>
          <div className="capture-grid grid grid-cols-2 gap-4 lg:grid-cols-3">{captures.map((capture) => <article key={capture.frame} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="capture-card relative flex aspect-square items-end justify-between p-3"><span className="rounded bg-slate-900/70 px-2 py-1 text-[9px] font-bold text-white">FRAME {capture.frame}</span><span className="rounded bg-white/85 px-2 py-1 text-[9px] font-bold text-slate-700">{capture.time}</span></div><div className="space-y-2 p-3"><div className="flex items-center justify-between"><span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{capture.label}</span><RatingStars rating={capture.rating} /></div><button data-help={`Open frame ${capture.frame} for a larger review and editing view.`} className="w-full rounded-lg bg-slate-100 py-2 text-[10px] font-extrabold uppercase tracking-wider text-slate-700 hover:bg-slate-200">Open capture</button></div></article>)}</div>
        </section>
      </div>
    </main>
  );
}