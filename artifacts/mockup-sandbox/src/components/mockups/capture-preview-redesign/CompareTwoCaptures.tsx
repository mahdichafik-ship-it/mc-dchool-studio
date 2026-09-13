import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Expand,
  Heart,
  Image as ImageIcon,
  Keyboard,
  LockKeyhole,
  Maximize2,
  QrCode,
  Search,
  ShieldCheck,
  Star,
  X,
} from "lucide-react";
import "./_group.css";

type Student = { id: number; name: string; code: string; frames: number; initials: string };
type Capture = {
  id: number;
  frame: string;
  time: string;
  rating: number;
  pairing: "JPEG + RAW" | "JPEG only" | "Needs review";
  upload: "Synced" | "Queued" | "Upload error";
  image: string;
  note: string;
};

const students: Student[] = [
  { id: 1, name: "Maya Chen", code: "LHS-0247", frames: 4, initials: "MC" },
  { id: 2, name: "Jordan Williams", code: "LHS-0248", frames: 0, initials: "JW" },
  { id: 3, name: "Sofia Martinez", code: "LHS-0249", frames: 2, initials: "SM" },
  { id: 4, name: "Ethan Nguyen", code: "LHS-0250", frames: 1, initials: "EN" },
  { id: 5, name: "Aaliyah Johnson", code: "LHS-0251", frames: 0, initials: "AJ" },
  { id: 6, name: "Liam O'Connor", code: "LHS-0252", frames: 3, initials: "LO" },
];

const captures: Capture[] = [
  { id: 1, frame: "001", time: "14:21:48", rating: 3, pairing: "JPEG + RAW", upload: "Synced", image: "/mc-school-studio-deck/hero.jpg", note: "Eyes open · soft shadow" },
  { id: 2, frame: "002", time: "14:22:05", rating: 4, pairing: "JPEG + RAW", upload: "Synced", image: "/mc-school-studio-deck/hero.jpg", note: "Clean expression · centered" },
  { id: 3, frame: "003", time: "14:23:12", rating: 5, pairing: "JPEG only", upload: "Queued", image: "/mc-school-studio-deck/hero.jpg", note: "Best expression · slight crop" },
  { id: 4, frame: "004", time: "14:24:08", rating: 0, pairing: "Needs review", upload: "Upload error", image: "/mc-school-studio-deck/hero.jpg", note: "Pairing still processing" },
];

function Stars({ value }: { value: number }) {
  return <span className="flex gap-0.5">{Array.from({ length: 5 }, (_, index) => <Star key={index} className={`size-3 ${index < value ? "fill-amber-400 text-amber-400" : "text-slate-300"}`} />)}</span>;
}

function UploadState({ value }: { value: Capture["upload"] }) {
  const tone = value === "Synced" ? "text-emerald-700" : value === "Queued" ? "text-amber-700" : "text-rose-700";
  return <span className={`inline-flex items-center gap-1 text-[9px] font-extrabold uppercase tracking-wider ${tone}`}><CheckCircle2 className="size-3" />{value}</span>;
}

export function CompareTwoCaptures() {
  const [studentId, setStudentId] = useState(1);
  const [query, setQuery] = useState("");
  const [leftId, setLeftId] = useState(2);
  const [rightId, setRightId] = useState(3);
  const [favorite, setFavorite] = useState(3);
  const [chosen, setChosen] = useState<number | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [lightbox, setLightbox] = useState<Capture | null>(null);
  const [safeUpload, setSafeUpload] = useState(true);
  const selectedStudent = students.find((student) => student.id === studentId) ?? students[0];
  const left = captures.find((capture) => capture.id === leftId) ?? captures[0];
  const right = captures.find((capture) => capture.id === rightId) ?? captures[1];
  const visibleStudents = useMemo(() => students.filter((student) => `${student.name} ${student.code}`.toLowerCase().includes(query.toLowerCase())), [query]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).tagName === "INPUT") return;
      if (event.key === "Escape") { setQrOpen(false); setLightbox(null); }
      if (event.key === "ArrowLeft") setLeftId((value) => Math.max(1, value - 1));
      if (event.key === "ArrowRight") setRightId((value) => Math.min(captures.length, value + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const slot = (capture: Capture, label: "A" | "B") => (
    <article className={`relative min-w-0 overflow-hidden rounded-xl border-2 bg-slate-950 ${chosen === capture.id ? "border-teal-500" : "border-slate-800"}`}>
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2.5">
        <div className="flex items-center gap-2"><span className="flex size-6 items-center justify-center rounded bg-teal-400 text-xs font-black text-slate-950">{label}</span><span className="font-mono text-[10px] font-bold text-white/70">FRAME {capture.frame}</span></div>
        <button onClick={() => setLightbox(capture)} aria-label={`Enlarge frame ${capture.frame}`} className="rounded p-1 text-white/60 hover:bg-white/10 hover:text-white"><Maximize2 className="size-3.5" /></button>
      </div>
      <button className="relative block w-full cursor-zoom-in text-left" onClick={() => setLightbox(capture)} aria-label={`Inspect frame ${capture.frame}`}>
        <img src={capture.image} alt={`JPEG preview frame ${capture.frame}`} className="h-[238px] w-full object-cover object-center saturate-[.88]" />
        <span className="absolute bottom-2 left-2 rounded bg-slate-950/75 px-2 py-1 font-mono text-[9px] text-white/80">JPEG PREVIEW · {capture.time}</span>
      </button>
      <div className="border-t border-white/10 bg-slate-900/90 p-3">
        <div className="flex items-center justify-between"><span className="text-[10px] font-extrabold uppercase tracking-widest text-slate-400">{capture.note}</span><button onClick={() => setFavorite(capture.id)} aria-label={`Favorite frame ${capture.frame}`}><Heart className={`size-4 ${favorite === capture.id ? "fill-rose-400 text-rose-400" : "text-slate-500"}`} /></button></div>
        <div className="mt-3 flex items-center justify-between"><Stars value={capture.rating} /><span className="font-mono text-[10px] text-slate-500">{capture.pairing}</span></div>
        <div className="mt-3 flex items-center justify-between border-t border-white/10 pt-2"><UploadState value={capture.upload} /><button onClick={() => setChosen(capture.id)} className={`rounded px-2.5 py-1.5 text-[9px] font-extrabold uppercase tracking-wider ${chosen === capture.id ? "bg-teal-400 text-slate-950" : "border border-slate-600 text-slate-300 hover:border-teal-400 hover:text-teal-300"}`}>{chosen === capture.id ? "Chosen" : "Choose this"}</button></div>
      </div>
    </article>
  );

  return (
    <main className="capture-preview-redesign flex min-h-[720px] h-screen w-full flex-col overflow-hidden bg-[#eef2f1] text-slate-900">
      <header className="flex h-[60px] shrink-0 items-center justify-between border-b border-slate-800 bg-[#071b1c] px-5 text-white">
        <div className="flex items-center gap-4"><button aria-label="Back to projects" className="rounded-md bg-white/5 p-2 text-slate-400 hover:text-white"><ArrowLeft className="size-4" /></button><div><h1 className="text-sm font-extrabold tracking-tight">Lincoln Heights School</h1><p className="mt-0.5 text-[10px] font-bold uppercase tracking-[.17em] text-teal-300/70">Portrait day · Grade 08 · Pair review</p></div></div>
        <div className="flex items-center gap-3"><div className="hidden items-center gap-2 rounded-md border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-emerald-300 md:flex"><ShieldCheck className="size-3.5" />42 safe locally</div><button onClick={() => setSafeUpload(!safeUpload)} className={`flex items-center gap-2 rounded-md border px-3 py-2 text-[10px] font-bold uppercase tracking-wider ${safeUpload ? "border-teal-400/30 bg-teal-400/10 text-teal-300" : "border-slate-700 text-slate-400"}`}><Cloud className="size-3.5" />Cloud {safeUpload ? "connected" : "paused"}</button><button onClick={() => setQrOpen(true)} className="flex items-center gap-2 rounded-md bg-teal-400 px-3 py-2 text-[10px] font-extrabold uppercase tracking-wider text-slate-950"><QrCode className="size-3.5" />Pairing QR</button></div>
      </header>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="flex w-[252px] shrink-0 flex-col border-r border-slate-200 bg-[#f8faf9]">
          <div className="border-b border-slate-200 px-4 py-4"><div className="mb-3 flex items-center justify-between"><span className="text-[10px] font-extrabold uppercase tracking-[.18em] text-slate-400">Active target</span><span className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-teal-700"><span className="size-1.5 rounded-full bg-teal-500" />locked</span></div><div className="relative"><Search className="absolute left-3 top-2.5 size-3.5 text-slate-400" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find student..." className="w-full rounded-md border border-slate-200 bg-white py-2 pl-9 pr-3 text-xs font-medium outline-none focus:border-teal-500" /></div></div>
          <div className="border-b border-slate-200 bg-slate-100/70 px-4 py-2 text-[9px] font-extrabold uppercase tracking-widest text-slate-400">Grade 08 · all students</div>
          <div className="min-h-0 flex-1 overflow-y-auto py-2">{visibleStudents.map((student) => <button key={student.id} onClick={() => setStudentId(student.id)} className={`flex w-full items-center gap-3 border-l-4 px-4 py-3 text-left ${student.id === studentId ? "border-teal-500 bg-teal-50" : "border-transparent hover:bg-white"}`}><span className={`flex size-8 items-center justify-center rounded-full text-[10px] font-black ${student.id === studentId ? "bg-teal-700 text-white" : "bg-slate-200 text-slate-500"}`}>{student.initials}</span><span className="min-w-0 flex-1"><span className="flex items-center justify-between"><strong className="truncate text-xs">{student.name}</strong>{student.id === studentId ? <LockKeyhole className="size-3 text-teal-600" /> : <span className="font-mono text-[10px] text-slate-400">{student.frames}</span>}</span><span className="font-mono text-[9px] text-slate-500">{student.code}</span></span></button>)}</div>
          <div className="border-t border-slate-200 px-4 py-3 text-[9px] leading-relaxed text-slate-500"><Keyboard className="mr-1 inline size-3" /><span className="font-mono font-bold">← →</span> change slots · <span className="font-mono font-bold">Esc</span> close</div>
        </aside>
        <section className="min-w-0 flex-1 overflow-y-auto">
          <div className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3.5"><div><div className="flex items-center gap-2"><span className="rounded bg-teal-700 px-2 py-1 text-[9px] font-extrabold uppercase tracking-widest text-white">Active target</span><span className="font-mono text-[10px] font-bold text-slate-400">{selectedStudent.code}</span></div><h2 className="mt-1 text-xl font-extrabold tracking-tight">{selectedStudent.name}</h2></div><div className="text-right"><p className="text-[9px] font-extrabold uppercase tracking-widest text-slate-400">Review mode</p><p className="mt-1 text-xs font-bold text-slate-700">Comparing 2 of {selectedStudent.frames} previews</p></div></div>
          <div className="mx-auto max-w-[960px] p-5">
            <div className="mb-4 flex items-end justify-between"><div><p className="text-[10px] font-extrabold uppercase tracking-[.2em] text-slate-400">Pairwise comparison</p><h3 className="mt-1 text-base font-extrabold">Which frame earns the final cut?</h3><p className="mt-1 text-xs text-slate-500">A/B slots stay locked to this target. Reviewing never changes who receives the next capture.</p></div><div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-right"><p className="text-[9px] font-extrabold uppercase tracking-widest text-slate-400">Decision</p><p className={`mt-1 text-xs font-extrabold ${chosen ? "text-teal-700" : "text-slate-400"}`}>{chosen ? `Frame ${String(chosen).padStart(3, "0")} selected` : "No frame selected"}</p></div></div>
            <div className="grid grid-cols-2 gap-4">{slot(left, "A")}{slot(right, "B")}</div>
            <div className="mt-4 rounded-xl border border-slate-200 bg-white p-3"><div className="mb-3 flex items-center justify-between"><div><p className="text-[10px] font-extrabold uppercase tracking-[.18em] text-slate-500">Replace a slot</p><p className="mt-1 text-[11px] text-slate-400">Newest capture is always on the right.</p></div><span className="rounded-full bg-teal-50 px-2 py-1 text-[9px] font-extrabold uppercase tracking-wider text-teal-700">JPEG previews only</span></div><div className="flex gap-2 overflow-x-auto pb-1">{captures.map((capture) => <button key={capture.id} onClick={() => leftId === capture.id ? setRightId(capture.id) : setLeftId(capture.id)} className={`group relative min-w-[139px] overflow-hidden rounded-lg border-2 text-left ${capture.id === leftId || capture.id === rightId ? "border-teal-500" : "border-slate-200"}`}><div className="relative aspect-[1.45] overflow-hidden bg-slate-900"><img src={capture.image} alt={`Frame ${capture.frame}`} className="h-full w-full object-cover opacity-90" /><span className="absolute left-2 top-2 rounded bg-slate-950/75 px-1.5 py-0.5 font-mono text-[8px] font-bold text-white">FRAME {capture.frame}</span></div><div className="flex items-center justify-between bg-white px-2 py-2"><span className="font-mono text-[9px] text-slate-500">{capture.time}</span>{capture.id === leftId ? <span className="text-[9px] font-black text-teal-700">A</span> : capture.id === rightId ? <span className="text-[9px] font-black text-teal-700">B</span> : <ImageIcon className="size-3 text-slate-400" />}</div></button>)}</div></div>
            <div className="mt-4 flex items-center justify-between rounded-lg border border-teal-200 bg-teal-50 px-4 py-3"><div className="flex items-center gap-2 text-xs text-teal-950"><ShieldCheck className="size-4 text-teal-700" /><span><strong>Safe review.</strong> Original camera files and RAW pairs remain untouched.</span></div><span className="hidden font-mono text-[10px] font-bold text-teal-700 sm:block">LOCAL COPY · CLOUD {safeUpload ? "READY" : "PAUSED"}</span></div>
          </div>
        </section>
      </div>
      {qrOpen && <div className="fixed inset-0 z-40 flex items-center justify-center bg-[#071b1c]/80 p-5" role="dialog" aria-modal="true"><div className="relative w-full max-w-[390px] rounded-2xl bg-[#f8faf9] p-6 text-center shadow-2xl"><button onClick={() => setQrOpen(false)} aria-label="Close pairing QR" className="absolute right-4 top-4 rounded p-1 text-slate-400 hover:bg-slate-200"><X className="size-5" /></button><p className="text-[9px] font-extrabold uppercase tracking-[.2em] text-teal-700">Pairing QR · active target</p><h3 className="mt-2 text-2xl font-extrabold">{selectedStudent.name}</h3><div className="mx-auto my-5 flex size-[250px] items-center justify-center rounded-xl border-[14px] border-slate-950 bg-white"><QrCode className="size-full text-slate-950" /></div><p className="font-mono text-sm font-bold text-slate-600">{selectedStudent.code}</p><p className="mt-1 text-xs text-slate-500">Scan to pair the next capture. Target stays locked.</p><button onClick={() => setQrOpen(false)} className="mt-5 w-full rounded-lg bg-slate-900 py-3 text-[10px] font-extrabold uppercase tracking-wider text-white">Close QR</button></div></div>}
      {lightbox && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/90 p-8" role="dialog" aria-modal="true"><button onClick={() => setLightbox(null)} aria-label="Close enlarged preview" className="absolute right-6 top-6 rounded-md bg-white/10 p-2 text-white"><X className="size-5" /></button><div className="max-w-[900px]"><img src={lightbox.image} alt={`Enlarged JPEG preview frame ${lightbox.frame}`} className="max-h-[74vh] w-full rounded-lg object-contain" /><div className="mt-3 flex justify-between text-white"><span className="font-mono text-xs">FRAME {lightbox.frame} · {lightbox.time}</span><span className="text-[10px] font-extrabold uppercase tracking-widest text-teal-300">Lightweight JPEG preview</span></div></div></div>}
    </main>
  );
}

export default CompareTwoCaptures;