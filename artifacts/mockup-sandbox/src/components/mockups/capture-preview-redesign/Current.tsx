import { useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Camera,
  Check,
  CheckCircle,
  ChevronRight,
  CloudUpload,
  Image as ImageIcon,
  Loader,
  Play,
  Plus,
  Search,
  Square,
  Star,
  Upload,
  User,
  XCircle,
} from "lucide-react";
import "./_group.css";

type RosterStudent = {
  id: number;
  firstName: string;
  lastName: string;
  studentId: string;
  className: string;
  captures: number;
  active?: boolean;
  uploaded?: boolean;
};

const students: RosterStudent[] = [
  { id: 1, firstName: "Maya", lastName: "Chen", studentId: "LHS-0247", className: "Grade 08 · Mrs. Patel", captures: 4, active: true, uploaded: true },
  { id: 2, firstName: "Jordan", lastName: "Williams", studentId: "LHS-0248", className: "Grade 08 · Mrs. Patel", captures: 0 },
  { id: 3, firstName: "Sofia", lastName: "Martinez", studentId: "LHS-0249", className: "Grade 08 · Mrs. Patel", captures: 2, uploaded: true },
  { id: 4, firstName: "Ethan", lastName: "Nguyen", studentId: "LHS-0250", className: "Grade 08 · Mrs. Patel", captures: 1 },
  { id: 5, firstName: "Aaliyah", lastName: "Johnson", studentId: "LHS-0251", className: "Grade 08 · Mrs. Patel", captures: 0 },
  { id: 6, firstName: "Liam", lastName: "O'Connor", studentId: "LHS-0252", className: "Grade 08 · Mrs. Patel", captures: 3, uploaded: true },
  { id: 7, firstName: "Grace", lastName: "Park", studentId: "LHS-0253", className: "Grade 08 · Mrs. Patel", captures: 0 },
];

const captureFilters = ["All", "JPEG + RAW", "JPEG only", "RAW only", "Needs review"];
const captureCounts = [4, 3, 1, 0, 0];

function Finder({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect className="cp-finder" width="7" height="7" rx=".3" />
      <rect className="cp-finder-cutout" x="1.4" y="1.4" width="4.2" height="4.2" rx=".15" />
      <rect className="cp-finder" x="2.6" y="2.6" width="1.8" height="1.8" />
    </g>
  );
}

function QrCode() {
  const cells = Array.from({ length: 21 }, (_, y) =>
    Array.from({ length: 21 }, (_, x) => {
      const inFinder = (x < 7 && y < 7) || (x > 13 && y < 7) || (x < 7 && y > 13);
      return !inFinder && ((x * 13 + y * 7 + x * y) % 5 < 2 || (x + y) % 11 === 0);
    }),
  );
  return (
    <svg viewBox="0 0 21 21" className="h-full w-full" aria-label="QR code for Maya Chen">
      <rect width="21" height="21" fill="white" />
      <g transform="translate(.75 .75) scale(.93)">
        {cells.flatMap((row, y) =>
          row.map((enabled, x) => enabled && <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="#111827" />),
        )}
        <Finder x={0} y={0} />
        <Finder x={14} y={0} />
        <Finder x={0} y={14} />
      </g>
    </svg>
  );
}

function Kbd({ children }: { children: string }) {
  return <kbd className="rounded border border-slate-200 bg-white px-1.5 py-0.5 font-sans font-bold text-slate-700 shadow-sm">{children}</kbd>;
}

function CaptureThumb({ index, favorite = false }: { index: number; favorite?: boolean }) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="relative aspect-[1.22] overflow-hidden bg-slate-900">
        <img
          src="/mc-school-studio-deck/hero.jpg"
          alt={`Capture ${index} of Maya Chen`}
          className="h-full w-full object-cover object-center transition-transform duration-300 group-hover:scale-105"
        />
        <div className="absolute inset-x-0 top-0 flex items-center justify-between p-2">
          <span className="rounded bg-black/55 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white backdrop-blur-sm">JPG + RAW</span>
          <button className="rounded bg-black/45 p-1 text-white/85 backdrop-blur-sm hover:text-amber-300" aria-label="Favorite capture">
            <Star className="size-3.5" fill={favorite ? "currentColor" : "none"} />
          </button>
        </div>
        <span className="absolute bottom-2 left-2 rounded bg-black/55 px-1.5 py-0.5 font-mono text-[9px] text-white/90 backdrop-blur-sm">MAYA_0247_{String(index).padStart(3, "0")}</span>
      </div>
      <div className="flex items-center justify-between gap-2 px-2.5 py-2">
        <span className="truncate font-mono text-[9px] font-medium text-slate-500">Capture {index} · 14:2{index}</span>
        <span className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-emerald-600"><CheckCircle className="size-3" /> Synced</span>
      </div>
    </div>
  );
}

export function Current() {
  const [selectedId, setSelectedId] = useState(1);
  const [search, setSearch] = useState("");
  const [activeFilter, setActiveFilter] = useState("All");
  const [watching, setWatching] = useState(true);
  const [liveUpload, setLiveUpload] = useState(true);
  const selected = students.find((student) => student.id === selectedId) ?? students[0];
  const visibleStudents = students.filter((student) => `${student.firstName} ${student.lastName} ${student.studentId}`.toLowerCase().includes(search.toLowerCase()));

  return (
    <main className="capture-preview-redesign flex h-screen min-h-[720px] w-full flex-col overflow-hidden bg-slate-50 text-slate-900">
      <header className="z-20 flex shrink-0 flex-wrap items-center justify-between gap-y-3 border-b border-slate-900 bg-slate-950 px-6 py-3 shadow-sm">
        <div className="flex min-w-0 items-center gap-5">
          <button aria-label="Back to projects" className="rounded-md bg-slate-900 p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"><ArrowLeft className="size-4" /></button>
          <div className="min-w-0">
            <h1 className="truncate text-base font-extrabold tracking-tight text-white">Lincoln Heights School</h1>
            <div className="mt-0.5 flex items-center gap-2.5 whitespace-nowrap text-[11px] font-medium text-slate-400">
              <span>4 classes</span><span className="h-1 w-1 rounded-full bg-slate-700" /><span>128 students</span><span className="h-1 w-1 rounded-full bg-slate-700" /><span className="text-slate-300">42 captures</span>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-4">
          <div className={`flex h-8 items-center overflow-hidden rounded-md border ${watching ? "border-teal-500/20 bg-teal-500/10" : "border-slate-800 bg-slate-900"}`}>
            <div className="flex items-center gap-2 px-3"><span className={`h-2 w-2 rounded-full ${watching ? "animate-pulse bg-teal-400 shadow-[0_0_8px_rgba(45,212,191,0.6)]" : "bg-slate-600"}`} /><span className={`text-[10px] font-bold uppercase tracking-wider ${watching ? "text-teal-400" : "text-slate-400"}`}>{watching ? "Live" : "Paused"}</span></div>
            <span className={`h-full w-px ${watching ? "bg-teal-500/20" : "bg-slate-800"}`} />
            <button onClick={() => setWatching(!watching)} className="flex h-full items-center gap-1 px-3 text-[10px] font-bold uppercase tracking-wider text-slate-300 hover:bg-slate-800 hover:text-white">{watching ? <Square className="size-3 fill-current" /> : <Play className="size-3 fill-current" />}{watching ? "Pause" : "Start"}</button>
          </div>
          <button className="hidden items-center gap-3 rounded-md border border-slate-800 bg-slate-900 px-3 py-1.5 text-left hover:bg-slate-800 md:flex">
            <div className="flex flex-col gap-1"><span className="flex items-center gap-1.5 text-[11px] leading-none text-slate-200"><CheckCircle className="size-3.5 text-emerald-400" />42 safe locally</span><span className="flex items-center gap-1.5 text-[11px] leading-none text-slate-200"><CloudUpload className="size-3.5 text-teal-400" />Cloud queue clear</span></div><ChevronRight className="size-3.5 text-slate-500" />
          </button>
          <button onClick={() => setLiveUpload(!liveUpload)} className={`flex h-8 items-center gap-1.5 rounded-md border px-3 text-[10px] font-bold uppercase tracking-wider ${liveUpload ? "border-blue-500/30 bg-blue-500/10 text-blue-300" : "border-slate-800 bg-slate-900 text-slate-300"}`}><CloudUpload className="size-3" /> Live Upload {liveUpload ? "On" : "Off"}</button>
          <button className="hidden h-8 items-center gap-1.5 rounded-md bg-blue-600 px-4 text-[10px] font-bold uppercase tracking-wider text-white shadow-md hover:bg-blue-500 sm:flex"><Upload className="size-3.5" /> Finish My Shoot</button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="z-10 flex w-[340px] shrink-0 flex-col border-r border-slate-200 bg-white shadow-[4px_0_24px_rgba(0,0,0,0.02)]">
          <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-100 p-2">
            <button className="whitespace-nowrap rounded-md bg-slate-900 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-white shadow-sm">All (128)</button>
            <button className="whitespace-nowrap rounded-md px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:bg-slate-100">Grade 08</button>
            <button className="whitespace-nowrap rounded-md px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:bg-slate-100">Grade 09</button>
          </div>
          <div className="shrink-0 border-b border-slate-100 bg-slate-50/50 p-3">
            <div className="flex gap-2">
              <div className="relative flex-1"><Search className="absolute left-3 top-2.5 size-4 text-slate-400" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search students..." className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm font-medium shadow-sm outline-none placeholder:text-slate-400 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20" /></div>
              <button className="flex size-[38px] shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white shadow-sm hover:bg-slate-800" aria-label="Add student"><Plus className="size-4" /></button>
            </div>
          </div>
          <div className="cp-scrollbar min-h-0 flex-1 overflow-y-auto">
            <div className="border-b border-slate-100 py-2">
              <div className="flex items-center justify-between px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-slate-400"><span>Groups</span><button className="text-teal-600 hover:text-teal-700">+ New group</button></div>
              <button className="flex w-full items-center gap-2.5 border-l-4 border-teal-500 bg-teal-50/50 px-4 py-2 text-left"><span className="flex size-6 items-center justify-center rounded-md bg-teal-100 text-teal-700"><User className="size-3.5" /></span><span className="flex-1 truncate text-sm font-bold text-teal-950">Grade 08 · All</span><span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-700">32</span></button>
            </div>
            <div className="py-2"><div className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">Students</div>
              {visibleStudents.map((student) => (
                <button key={student.id} onClick={() => setSelectedId(student.id)} className={`cp-roster-row flex w-full items-center gap-3 border-b border-slate-100 border-l-4 p-3 text-left ${selectedId === student.id ? "is-active border-l-teal-500" : "border-l-transparent"}`}>
                  <div className="min-w-0 flex-1"><div className="mb-1 flex items-center justify-between"><span className={`truncate text-sm font-bold ${selectedId === student.id ? "text-teal-950" : "text-slate-900"}`}>{student.lastName}, {student.firstName}</span>{selectedId === student.id ? <span className="flex items-center rounded-sm bg-teal-600 px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-widest text-white"><Camera className="mr-1 size-2.5" />Active</span> : student.captures > 0 && <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-700">{student.captures}</span>}</div><div className="flex items-center justify-between"><span className={`font-mono text-[10px] font-medium ${selectedId === student.id ? "text-teal-700" : "text-slate-500"}`}>{student.studentId}</span>{student.uploaded && <span className="flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold text-emerald-600"><Check className="size-3" /> Synced</span>}</div></div>
                </button>
              ))}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-center gap-x-4 gap-y-2 border-t border-slate-200 bg-slate-50 p-2 text-[10px] font-medium text-slate-500"><span><Kbd>/</Kbd> Search</span><span><Kbd>↑↓</Kbd> Navigate</span><span><Kbd>N</Kbd> Next unphotographed</span><span><Kbd>Esc</Kbd> Clear</span></div>
        </aside>

        <section className="cp-scrollbar min-w-0 flex-1 overflow-y-auto bg-slate-50">
          <div className="relative flex shrink-0 flex-wrap items-start justify-between gap-4 border-b border-slate-200 bg-white px-8 py-6 shadow-sm">
            <div className="absolute left-0 top-0 h-1 w-full bg-teal-500" />
            <div className="min-w-0"><div className="mb-2 flex flex-wrap items-center gap-3"><span className="flex items-center rounded bg-teal-500 px-2.5 py-0.5 text-[10px] font-extrabold uppercase tracking-widest text-white shadow-sm"><Camera className="mr-1.5 size-3" /> Active Target</span><span className="truncate rounded-md border border-slate-200 bg-slate-100 px-2 py-0.5 font-mono text-[11px] font-medium text-slate-600">{selected.studentId}</span><span className="truncate text-[11px] font-extrabold uppercase tracking-widest text-slate-400">{selected.className}</span></div><h2 className="break-words text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">{selected.firstName} {selected.lastName}</h2></div>
            <div className="flex shrink-0 flex-col items-end justify-center gap-3"><button className="flex h-8 items-center rounded-md border border-slate-300 px-3 text-[10px] font-bold uppercase tracking-wider text-slate-600 shadow-sm hover:bg-slate-100"><XCircle className="mr-1.5 size-3.5" /> Clear Target</button><div className="text-[11px] font-bold uppercase tracking-widest text-slate-500">{selected.captures} Captures recorded</div></div>
          </div>
          <div className="mx-auto flex max-w-[1400px] flex-col-reverse gap-8 p-8 xl:flex-row">
            <div className="min-w-0 flex-1">
              <div className="relative mb-4 aspect-[16/9] overflow-hidden rounded-2xl border border-slate-200 bg-black shadow-lg">
                <div className="absolute left-0 right-0 top-0 z-10 flex items-start justify-between bg-gradient-to-b from-black/80 to-transparent p-5"><div className="flex items-center gap-3"><span className="flex items-center gap-2 rounded bg-red-600 px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-widest text-white shadow-sm"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)]" />Live Preview</span><span className="rounded bg-black/40 px-2 py-0.5 font-mono text-xs font-medium text-white/80">MAYA_0247_004.JPG</span></div><span className="hidden rounded bg-black/40 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-white/60 backdrop-blur-sm md:block">Prioritizing newest capture</span></div>
                <img src="/mc-school-studio-deck/hero.jpg" alt="Latest portrait capture preview" className="cp-preview-image h-full w-full object-cover object-center" />
                <div className="absolute bottom-3 right-3 rounded bg-black/55 px-2 py-1 text-[9px] font-bold uppercase tracking-widest text-white/80">Original photograph · 14:24:08</div>
              </div>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-4"><div><div className="w-fit rounded-full border border-teal-100 bg-teal-50 px-3.5 py-1.5 text-[10px] font-extrabold uppercase tracking-widest text-teal-600 shadow-sm">2. Live Captures</div><p className="mt-2 text-xs font-semibold text-slate-500">Star a photo to include it in the parent gallery.</p></div><div className="flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">{captureFilters.map((filter, index) => <button key={filter} onClick={() => setActiveFilter(filter)} className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-all ${activeFilter === filter ? "bg-slate-900 text-white shadow-md" : "text-slate-500 hover:bg-slate-100 hover:text-slate-800"}`}>{filter}<span className={`rounded px-1.5 py-0.5 text-[9px] font-extrabold ${activeFilter === filter ? "bg-slate-700 text-white" : "bg-slate-200 text-slate-600"}`}>{captureCounts[index]}</span></button>)}</div></div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"><CaptureThumb index={1} favorite /><CaptureThumb index={2} /><CaptureThumb index={3} /></div>
            </div>
            <div className="w-full shrink-0 xl:w-[300px]"><div className="flex flex-col items-center gap-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><div className="w-full text-center"><div className="mb-4 inline-block rounded-full border border-teal-100 bg-teal-50 px-3.5 py-1.5 text-[10px] font-extrabold uppercase tracking-widest text-teal-600 shadow-sm">1. Scan to link</div><p className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 font-mono text-[11px] font-medium text-slate-500">{selected.firstName}.{selected.lastName}.{selected.studentId}</p></div><div className="aspect-square w-full rounded-2xl border-2 border-slate-100 bg-slate-50 p-3 shadow-inner"><QrCode /></div><p className="text-center text-xs font-medium leading-relaxed text-slate-400">Present this code to the camera before capturing portraits.</p></div><div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><div className="mb-3 flex items-center justify-between"><span className="text-[10px] font-extrabold uppercase tracking-widest text-slate-400">Capture status</span><span className="flex items-center gap-1 text-[10px] font-bold text-emerald-600"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Ready</span></div><div className="flex items-center gap-2 text-xs font-medium text-slate-500"><ImageIcon className="size-4 text-teal-600" /> JPEG + RAW pairing enabled</div></div></div>
          </div>
        </section>
      </div>
    </main>
  );
}