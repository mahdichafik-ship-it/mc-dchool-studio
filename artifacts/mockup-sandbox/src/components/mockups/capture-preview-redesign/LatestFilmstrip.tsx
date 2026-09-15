import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  CheckCircle,
  ChevronRight,
  CloudUpload,
  Keyboard,
  Pause,
  Play,
  Search,
  ShieldCheck,
  Star,
  Upload,
  Wifi,
  XCircle,
} from "lucide-react";
import "./_group.css";

type Student = {
  id: number;
  firstName: string;
  lastName: string;
  studentId: string;
  className: string;
  captures: number;
  uploaded?: boolean;
};

type Capture = {
  id: number;
  frame: string;
  time: string;
  rating: number;
  pairing: "JPEG + RAW" | "JPEG only" | "Needs review";
  upload: "Synced" | "Queued" | "Error";
  image: string;
};

const students: Student[] = [
  { id: 1, firstName: "Maya", lastName: "Chen", studentId: "LHS-0247", className: "Grade 08 · Mrs. Patel", captures: 4, uploaded: true },
  { id: 2, firstName: "Jordan", lastName: "Williams", studentId: "LHS-0248", className: "Grade 08 · Mrs. Patel", captures: 0 },
  { id: 3, firstName: "Sofia", lastName: "Martinez", studentId: "LHS-0249", className: "Grade 08 · Mrs. Patel", captures: 2, uploaded: true },
  { id: 4, firstName: "Ethan", lastName: "Nguyen", studentId: "LHS-0250", className: "Grade 08 · Mrs. Patel", captures: 1 },
  { id: 5, firstName: "Aaliyah", lastName: "Johnson", studentId: "LHS-0251", className: "Grade 08 · Mrs. Patel", captures: 0 },
  { id: 6, firstName: "Liam", lastName: "O'Connor", studentId: "LHS-0252", className: "Grade 08 · Mrs. Patel", captures: 3, uploaded: true },
  { id: 7, firstName: "Grace", lastName: "Park", studentId: "LHS-0253", className: "Grade 08 · Mrs. Patel", captures: 0 },
];

const captures: Capture[] = [
  { id: 1, frame: "001", time: "14:21:48", rating: 3, pairing: "JPEG + RAW", upload: "Synced", image: "/mc-school-studio-deck/hero.jpg" },
  { id: 2, frame: "002", time: "14:22:05", rating: 4, pairing: "JPEG + RAW", upload: "Synced", image: "/mc-school-studio-deck/hero.jpg" },
  { id: 3, frame: "003", time: "14:23:12", rating: 5, pairing: "JPEG only", upload: "Queued", image: "/mc-school-studio-deck/hero.jpg" },
  { id: 4, frame: "004", time: "14:24:08", rating: 0, pairing: "Needs review", upload: "Error", image: "/mc-school-studio-deck/hero.jpg" },
];

function Rating({ value, compact = false }: { value: number; compact?: boolean }) {
  return (
    <span className={`flex items-center gap-0.5 ${compact ? "scale-90 origin-left" : ""}`} aria-label={`${value} out of 5 stars`}>
      {Array.from({ length: 5 }, (_, index) => <Star key={index} className="size-3.5 text-amber-400" fill={index < value ? "currentColor" : "none"} />)}
    </span>
  );
}

function Status({ status }: { status: Capture["upload"] }) {
  if (status === "Synced") return <span className="flex items-center gap-1 text-[10px] font-extrabold uppercase tracking-wider text-emerald-600"><CheckCircle className="size-3.5" /> Synced</span>;
  if (status === "Queued") return <span className="flex items-center gap-1 text-[10px] font-extrabold uppercase tracking-wider text-amber-600"><CloudUpload className="size-3.5" /> Queued</span>;
  return <span className="flex items-center gap-1 text-[10px] font-extrabold uppercase tracking-wider text-rose-600"><XCircle className="size-3.5" /> Upload error</span>;
}

export function LatestFilmstrip() {
  const [selectedId, setSelectedId] = useState(1);
  const [reviewIndex, setReviewIndex] = useState(captures.length - 1);
  const [search, setSearch] = useState("");
  const [live, setLive] = useState(true);
  const [liveUpload, setLiveUpload] = useState(true);
  const [starred, setStarred] = useState<number[]>([2]);
  const [toast, setToast] = useState(false);
  const selected = students.find((student) => student.id === selectedId) ?? students[0];
  const visibleStudents = useMemo(() => students.filter((student) => `${student.firstName} ${student.lastName} ${student.studentId}`.toLowerCase().includes(search.toLowerCase())), [search]);
  const currentCapture = captures[reviewIndex];
  const isLatest = reviewIndex === captures.length - 1;

  const navigate = (direction: number) => setReviewIndex((index) => Math.max(0, Math.min(captures.length - 1, index + direction)));
  const simulateCapture = () => {
    setReviewIndex(captures.length - 1);
    setLive(true);
    setToast(true);
    window.setTimeout(() => setToast(false), 2400);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).tagName === "INPUT") return;
      if (event.key === "ArrowLeft") navigate(-1);
      if (event.key === "ArrowRight") navigate(1);
      if (event.key.toLowerCase() === "l") setReviewIndex(captures.length - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <main className="capture-preview-redesign flex min-h-[720px] h-screen w-full flex-col overflow-hidden bg-slate-50 text-slate-900">
      <header className="z-20 flex shrink-0 items-center justify-between gap-4 border-b border-slate-800 bg-slate-950 px-5 py-3 text-white">
        <div className="flex min-w-0 items-center gap-4">
          <button aria-label="Back to projects" className="rounded-md bg-slate-900 p-2 text-slate-400 hover:bg-slate-800 hover:text-white"><ArrowLeft className="size-4" /></button>
          <div className="min-w-0"><h1 className="truncate text-sm font-extrabold tracking-tight">Lincoln Heights School</h1><p className="mt-1 text-[10px] font-bold uppercase tracking-[.18em] text-slate-500">Portrait day · Grade 08 · 128 students</p></div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="hidden items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-emerald-300 sm:flex"><ShieldCheck className="size-3.5" /> 42 safe locally</div>
          <button onClick={() => setLiveUpload(!liveUpload)} className={`flex items-center gap-1.5 rounded-md border px-3 py-2 text-[10px] font-bold uppercase tracking-wider ${liveUpload ? "border-teal-400/30 bg-teal-400/10 text-teal-300" : "border-slate-700 bg-slate-900 text-slate-400"}`}><CloudUpload className="size-3.5" /> Live upload {liveUpload ? "on" : "off"}</button>
          <button onClick={() => setLive(!live)} className="flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-300 hover:bg-slate-800">{live ? <Pause className="size-3" /> : <Play className="size-3" />} {live ? "Pause" : "Resume"}</button>
          <button className="hidden items-center gap-1.5 rounded-md bg-blue-600 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-white hover:bg-blue-500 md:flex"><Upload className="size-3" /> Finish shoot</button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="z-10 flex w-[300px] shrink-0 flex-col border-r border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-3"><div className="mb-3 flex items-center justify-between"><span className="text-[10px] font-extrabold uppercase tracking-[.18em] text-slate-400">Capture target</span><span className="flex items-center gap-1 text-[10px] font-bold text-teal-700"><span className="size-1.5 animate-pulse rounded-full bg-teal-500" /> ready</span></div><div className="relative"><Search className="absolute left-3 top-2.5 size-4 text-slate-400" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search roster..." className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm font-medium outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20" /></div></div>
          <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-4 py-2"><span className="text-[10px] font-extrabold uppercase tracking-widest text-slate-400">Grade 08 · All</span><span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">32</span></div>
          <div className="cp-scrollbar min-h-0 flex-1 overflow-y-auto py-2"><div className="px-4 py-2 text-[10px] font-extrabold uppercase tracking-widest text-slate-400">Students</div>{visibleStudents.map((student) => <button key={student.id} onClick={() => setSelectedId(student.id)} className={`cp-roster-row flex w-full items-center gap-3 border-b border-slate-100 border-l-4 p-3 text-left ${selectedId === student.id ? "is-active border-l-teal-500" : "border-l-transparent"}`}><div className={`flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-extrabold ${selectedId === student.id ? "bg-teal-600 text-white" : "bg-slate-100 text-slate-500"}`}>{student.firstName[0]}{student.lastName[0]}</div><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-bold">{student.lastName}, {student.firstName}</span>{selectedId === student.id ? <Camera className="size-3.5 shrink-0 text-teal-600" /> : student.captures > 0 && <span className="rounded bg-slate-200 px-1.5 text-[10px] font-bold text-slate-600">{student.captures}</span>}</div><div className="mt-1 flex items-center justify-between"><span className="font-mono text-[10px] text-slate-500">{student.studentId}</span>{student.uploaded && <Check className="size-3 text-emerald-500" />}</div></div></button>)}</div>
          <div className="border-t border-slate-200 bg-slate-50 px-4 py-3 text-[10px] font-medium leading-relaxed text-slate-500"><div className="mb-1 flex items-center gap-1.5 font-bold text-slate-600"><Keyboard className="size-3.5" /> Roster shortcuts</div><span className="font-mono text-slate-700">↑ ↓</span> navigate · <span className="font-mono text-slate-700">N</span> next unphotographed · <span className="font-mono text-slate-700">Esc</span> clear</div>
        </aside>

        <section className="cp-scrollbar min-w-0 flex-1 overflow-y-auto">
          <div className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4"><div><div className="mb-1 flex items-center gap-2"><span className="flex items-center gap-1.5 rounded bg-teal-500 px-2 py-1 text-[10px] font-extrabold uppercase tracking-widest text-white"><Camera className="size-3" /> Active target</span><span className="font-mono text-[10px] font-bold text-slate-500">{selected.studentId}</span></div><h2 className="text-xl font-extrabold tracking-tight">{selected.firstName} {selected.lastName}</h2></div><button onClick={() => setSelectedId(1)} className="rounded-md border border-slate-200 px-3 py-2 text-[10px] font-extrabold uppercase tracking-wider text-slate-500 hover:bg-slate-50">Clear target</button></div>
          <div className="mx-auto flex max-w-[1050px] flex-col gap-4 p-5 lg:p-6">
            <div className="flex items-center justify-between"><div><p className="text-[10px] font-extrabold uppercase tracking-[.2em] text-slate-400">Visual confirmation</p><p className="mt-1 text-xs font-medium text-slate-500">{isLatest ? "Following the latest capture automatically" : "Manual review mode · capture target unchanged"}</p></div><button onClick={simulateCapture} className="flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-[10px] font-extrabold uppercase tracking-wider text-white shadow-sm hover:bg-slate-800"><Camera className="size-3.5" /> Simulate new capture</button></div>
            <div className="relative overflow-hidden rounded-2xl border border-slate-700 bg-slate-950 shadow-xl">
              <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between bg-gradient-to-b from-black/80 to-transparent p-4"><div className="flex items-center gap-2"><span className={`rounded px-2 py-1 text-[9px] font-extrabold uppercase tracking-widest text-white ${isLatest ? "bg-red-600" : "bg-slate-700"}`}>{isLatest ? "Latest capture" : "Reviewing frame"}</span><span className="font-mono text-[10px] text-white/75">MAYA_0247_{currentCapture.frame}.JPG</span></div><span className="hidden items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-white/65 sm:flex"><Wifi className="size-3" /> JPEG preview</span></div>
              <img key={currentCapture.id} src={currentCapture.image} alt={`Capture ${currentCapture.frame} of ${selected.firstName} ${selected.lastName}`} className="cp-preview-image aspect-[16/8.2] max-h-[330px] w-full object-cover object-center" />
              <button onClick={() => navigate(-1)} disabled={reviewIndex === 0} aria-label="Previous capture" className="absolute left-3 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur hover:bg-black/70 disabled:opacity-30"><ArrowLeft className="size-4" /></button><button onClick={() => navigate(1)} disabled={isLatest} aria-label="Next capture" className="absolute right-3 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur hover:bg-black/70 disabled:opacity-30"><ArrowRight className="size-4" /></button>
              <div className="absolute bottom-0 inset-x-0 flex items-end justify-between bg-gradient-to-t from-black/80 to-transparent p-4 pt-10"><span className="font-mono text-[10px] text-white/75">{currentCapture.time} · frame {currentCapture.frame} / {captures.length}</span><span className="text-[10px] font-bold uppercase tracking-wider text-white/70">Lightweight JPEG</span></div>
            </div>
            {!isLatest && <div className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900"><span><strong>Manual review:</strong> this does not change the active capture target.</span><button onClick={() => setReviewIndex(captures.length - 1)} className="flex items-center gap-1 font-extrabold uppercase tracking-wider text-amber-800 hover:text-amber-950">Latest capture <ChevronRight className="size-3.5" /></button></div>}
            <div className="grid grid-cols-2 gap-3 rounded-xl border border-slate-200 bg-white p-3 sm:grid-cols-4"><div><p className="text-[9px] font-extrabold uppercase tracking-widest text-slate-400">Rating</p><button className="mt-2" onClick={() => setStarred(starred.includes(currentCapture.id) ? starred.filter((id) => id !== currentCapture.id) : [...starred, currentCapture.id])}><Rating value={currentCapture.rating} /></button></div><div><p className="text-[9px] font-extrabold uppercase tracking-widest text-slate-400">Pairing</p><p className={`mt-2 text-xs font-bold ${currentCapture.pairing === "Needs review" ? "text-rose-600" : "text-slate-700"}`}>{currentCapture.pairing}</p></div><div><p className="text-[9px] font-extrabold uppercase tracking-widest text-slate-400">Upload</p><div className="mt-2"><Status status={currentCapture.upload} /></div></div><div><p className="text-[9px] font-extrabold uppercase tracking-widest text-slate-400">Review</p><p className="mt-2 text-xs font-bold text-slate-700">{starred.includes(currentCapture.id) ? "In parent gallery" : "Not selected"}</p></div></div>
            <div className="rounded-xl border border-slate-200 bg-white p-3"><div className="mb-3 flex items-center justify-between"><div><p className="text-[10px] font-extrabold uppercase tracking-[.18em] text-slate-500">Recent captures</p><p className="mt-1 text-[11px] text-slate-400">Newest on the right · click to review without changing target</p></div><span className="rounded-full bg-teal-50 px-2 py-1 text-[9px] font-extrabold uppercase tracking-wider text-teal-700">4 JPEG previews</span></div><div className="cp-scrollbar flex gap-2 overflow-x-auto pb-1">{captures.map((capture) => <button key={capture.id} onClick={() => setReviewIndex(captures.indexOf(capture))} className={`group relative min-w-[150px] overflow-hidden rounded-lg border-2 text-left transition-all ${currentCapture.id === capture.id ? "border-teal-500 shadow-[0_0_0_2px_rgba(20,184,166,.14)]" : "border-slate-200 hover:border-slate-400"}`}><div className="relative aspect-[1.45] overflow-hidden bg-slate-900"><img src={capture.image} alt={`Capture ${capture.frame}`} className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105" /><span className={`absolute left-2 top-2 rounded px-1.5 py-0.5 text-[8px] font-extrabold uppercase tracking-wider text-white ${capture.id === captures.length ? "bg-red-600" : "bg-black/60"}`}>{capture.id === captures.length ? "NEWEST" : `FRAME ${capture.frame}`}</span>{starred.includes(capture.id) && <Star className="absolute right-2 top-2 size-3.5 text-amber-300" fill="currentColor" />}</div><div className="flex items-center justify-between gap-2 bg-white px-2 py-2"><span className="font-mono text-[9px] text-slate-500">{capture.time}</span><Status status={capture.upload} /></div></button>)}</div></div>
          </div>
        </section>
      </div>
      {toast && <div role="status" className="fixed bottom-5 right-5 z-30 flex items-center gap-2 rounded-lg border border-teal-400/30 bg-slate-900 px-4 py-3 text-xs font-bold text-white shadow-xl"><CheckCircle className="size-4 text-teal-300" /> New JPEG preview received · following latest</div>}
    </main>
  );
}