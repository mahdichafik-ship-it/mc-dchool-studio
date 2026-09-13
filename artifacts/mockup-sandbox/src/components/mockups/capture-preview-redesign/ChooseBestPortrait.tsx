import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Expand,
  Grid2X2,
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

type Capture = {
  id: number;
  frame: string;
  time: string;
  quality: string;
  upload: "Synced" | "Queued";
  image: string;
};

const captures: Capture[] = [
  { id: 1, frame: "001", time: "14:21:48", quality: "Eyes open", upload: "Synced", image: "/mc-school-studio-deck/hero.jpg" },
  { id: 2, frame: "002", time: "14:22:05", quality: "Good expression", upload: "Synced", image: "/mc-school-studio-deck/hero.jpg" },
  { id: 3, frame: "003", time: "14:23:12", quality: "Eyes open", upload: "Queued", image: "/mc-school-studio-deck/hero.jpg" },
  { id: 4, frame: "004", time: "14:24:08", quality: "Latest", upload: "Queued", image: "/mc-school-studio-deck/hero.jpg" },
];

function FaceMark() {
  return (
    <span className="pointer-events-none absolute left-[38%] top-[27%] size-[29%] rounded-[48%] border-2 border-lime-300/90 shadow-[0_0_0_1px_rgba(11,32,41,.55)]">
      <span className="absolute -left-1 -top-1 size-2 rounded-tl border-l-2 border-t-2 border-lime-300" />
      <span className="absolute -right-1 -top-1 size-2 rounded-tr border-r-2 border-t-2 border-lime-300" />
      <span className="absolute -bottom-1 -left-1 size-2 rounded-bl border-b-2 border-l-2 border-lime-300" />
      <span className="absolute -bottom-1 -right-1 size-2 rounded-br border-b-2 border-r-2 border-lime-300" />
    </span>
  );
}

export function ChooseBestPortrait() {
  const [selected, setSelected] = useState(3);
  const [best, setBest] = useState(3);
  const [search, setSearch] = useState("");
  const [qrOpen, setQrOpen] = useState(false);
  const [compareMode, setCompareMode] = useState(false);
  const [notice, setNotice] = useState("");
  const target = "Maya Chen";
  const current = captures.find((capture) => capture.id === selected) ?? captures[2];
  const visible = useMemo(() => captures.filter((capture) => `${capture.frame} ${capture.time} ${capture.quality}`.toLowerCase().includes(search.toLowerCase())), [search]);

  const move = (direction: number) => {
    const index = captures.findIndex((capture) => capture.id === selected);
    setSelected(captures[Math.max(0, Math.min(captures.length - 1, index + direction))].id);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).tagName === "INPUT") return;
      if (event.key === "ArrowLeft") move(-1);
      if (event.key === "ArrowRight") move(1);
      if (event.key.toLowerCase() === "b") {
        setBest(selected);
        setNotice("Best shot updated");
      }
      if (event.key === "Escape") setQrOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  return (
    <main className="capture-preview-redesign flex min-h-[720px] h-screen w-full flex-col overflow-hidden bg-[#f3f7f5] text-slate-900">
      <header className="flex shrink-0 items-center justify-between border-b border-[#23343a] bg-[#10252b] px-5 py-3 text-white">
        <div className="flex min-w-0 items-center gap-4">
          <button aria-label="Back to projects" className="rounded-md bg-[#1a343b] p-2 text-slate-300 hover:text-white"><ArrowLeft className="size-4" /></button>
          <div className="min-w-0"><h1 className="truncate text-sm font-extrabold">Lincoln Heights School</h1><p className="mt-1 text-[10px] font-bold uppercase tracking-[.18em] text-[#95aeb0]">Portrait day · Grade 08 · selection desk</p></div>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-2 rounded-md border border-[#456157] bg-[#203c38] px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-[#c7e6ce] md:flex"><ShieldCheck className="size-3.5" />42 safe locally</div>
          <div className="hidden items-center gap-1.5 rounded-md border border-[#456157] bg-[#203c38] px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-[#c7e6ce] sm:flex"><Cloud className="size-3.5" />Cloud synced</div>
          <button onClick={() => setQrOpen(true)} className="flex items-center gap-1.5 rounded-md bg-[#d4ed8e] px-3 py-2 text-[10px] font-extrabold uppercase tracking-wider text-[#183137]"><QrCode className="size-3.5" />Pairing QR</button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="flex w-[282px] shrink-0 flex-col border-r border-[#d6e2de] bg-[#fbfdfb]">
          <div className="border-b border-[#e2ebe7] px-4 py-4">
            <div className="mb-3 flex items-center justify-between"><span className="text-[10px] font-extrabold uppercase tracking-[.18em] text-[#72878a]">Active capture target</span><span className="flex items-center gap-1 text-[10px] font-bold text-[#1b917b]"><span className="size-1.5 animate-pulse rounded-full bg-[#40b99b]" />locked</span></div>
            <div className="flex items-center gap-3 rounded-lg border border-[#add3c2] bg-[#eaf7ef] p-3"><div className="flex size-9 items-center justify-center rounded-full bg-[#244a4b] text-xs font-extrabold text-white">MC</div><div><p className="text-sm font-extrabold">Maya Chen</p><p className="mt-1 font-mono text-[10px] text-[#5c7775]">LHS-0247 · 4 captures</p></div><LockKeyhole className="ml-auto size-3.5 text-[#27826e]" /></div>
            <p className="mt-3 text-[10px] leading-relaxed text-[#617673]">Reviewing only. Selection actions never change the capture target.</p>
          </div>
          <div className="border-b border-[#e2ebe7] px-4 py-3"><div className="relative"><Search className="absolute left-3 top-2.5 size-4 text-[#8ba09c]" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter frames..." className="w-full rounded-lg border border-[#d8e4df] bg-[#f3f8f5] py-2 pl-9 pr-3 text-xs font-medium outline-none focus:border-[#5db597]" /></div></div>
          <div className="flex items-center justify-between border-b border-[#e2ebe7] px-4 py-3"><span className="text-[10px] font-extrabold uppercase tracking-widest text-[#72878a]">4 JPEG previews</span><span className="rounded bg-[#e4f2d8] px-1.5 py-0.5 text-[9px] font-extrabold text-[#48783b]">NEWEST →</span></div>
          <div className="cp-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
            {visible.map((capture) => <button key={capture.id} onClick={() => setSelected(capture.id)} className={`mb-2 flex w-full items-center gap-3 rounded-lg border p-2.5 text-left ${selected === capture.id ? "border-[#65b995] bg-[#eef9f0]" : "border-transparent hover:border-[#d7e5df]"}`}><div className="relative size-12 shrink-0 overflow-hidden rounded-md bg-[#18333a]"><img src={capture.image} alt="" className="h-full w-full object-cover opacity-75" /><span className="absolute bottom-1 left-1 rounded bg-[#10252b]/80 px-1 font-mono text-[8px] text-white">{capture.frame}</span></div><div className="min-w-0 flex-1"><div className="flex justify-between gap-1"><span className="font-mono text-[10px] font-bold text-[#516b6a]">{capture.time}</span>{best === capture.id && <Star className="size-3.5 text-[#d9942b]" fill="currentColor" />}</div><p className="mt-1 truncate text-xs font-bold">{capture.quality}</p></div></button>)}
          </div>
          <div className="border-t border-[#dce8e3] bg-[#f3f8f5] px-4 py-3 text-[10px] leading-relaxed text-[#607874]"><div className="mb-1 flex items-center gap-1.5 font-bold text-[#385956]"><Keyboard className="size-3.5" />Fast triage</div><span className="font-mono font-bold text-[#263f42]">← →</span> browse · <span className="font-mono font-bold text-[#263f42]">B</span> mark best</div>
        </aside>

        <section className="cp-scrollbar min-w-0 flex-1 overflow-y-auto">
          <div className="flex items-center justify-between border-b border-[#d6e2de] bg-[#fbfdfb] px-6 py-4"><div><p className="text-[10px] font-extrabold uppercase tracking-[.2em] text-[#718785]">Best-shot selection</p><h2 className="mt-1 text-xl font-extrabold tracking-tight">Narrow the gallery to one frame</h2></div><div className="flex items-center gap-2"><button onClick={() => setCompareMode(!compareMode)} className={`flex items-center gap-2 rounded-md border px-3 py-2 text-[10px] font-extrabold uppercase tracking-wider ${compareMode ? "border-[#3e8876] bg-[#e3f4e9] text-[#246854]" : "border-[#d6e2de] bg-white text-[#57716f]"}`}><Grid2X2 className="size-3.5" />{compareMode ? "Compare on" : "Compare"} </button><span className="rounded-full bg-[#e8f3e1] px-2.5 py-1.5 text-[10px] font-extrabold uppercase tracking-wider text-[#537944]">4 visible · JPEG only</span></div></div>
          <div className="mx-auto flex max-w-[1040px] flex-col gap-4 p-5 lg:p-6">
            <div className="flex items-center justify-between"><div><p className="text-xs font-bold text-[#385957]">Active target <span className="ml-1 rounded bg-[#244a4b] px-2 py-1 text-[10px] text-white">MAYA CHEN · LHS-0247</span></p><p className="mt-2 text-[11px] text-[#708580]">Newest capture is on the right. Pick a best shot without changing who is next.</p></div><button onClick={() => setQrOpen(true)} className="hidden items-center gap-2 rounded-lg border border-[#badcc9] bg-[#f1fbf3] px-3 py-2 text-[10px] font-extrabold uppercase tracking-wider text-[#28715e] sm:flex"><QrCode className="size-3.5" />Open pairing QR</button></div>
            <div className={`grid gap-3 ${compareMode ? "grid-cols-2 lg:grid-cols-4" : "grid-cols-2 lg:grid-cols-3"}`}>
              {captures.map((capture) => <button key={capture.id} onClick={() => setSelected(capture.id)} className={`group relative overflow-hidden rounded-xl border-2 bg-[#193139] text-left shadow-sm transition-transform hover:-translate-y-0.5 ${selected === capture.id ? "border-[#b5e56f] shadow-[0_0_0_3px_rgba(181,229,111,.2)]" : "border-transparent"}`}><div className="relative aspect-[1.15] overflow-hidden"><img src={capture.image} alt={`${target} frame ${capture.frame}`} className="h-full w-full object-cover opacity-90" /><FaceMark /><div className="absolute inset-x-0 top-0 flex items-center justify-between p-2.5"><span className="rounded bg-[#10252b]/85 px-2 py-1 font-mono text-[9px] font-bold text-white">FRAME {capture.frame}</span>{capture.id === 4 && <span className="rounded bg-[#d4ed8e] px-2 py-1 text-[9px] font-extrabold uppercase text-[#27443b]">Newest</span>}</div>{best === capture.id && <div className="absolute bottom-0 left-0 right-0 flex items-center gap-1.5 bg-[#b8e870] px-3 py-2 text-[10px] font-extrabold uppercase tracking-wider text-[#203f37]"><Star className="size-3.5" fill="currentColor" />Current best / gallery choice</div>}<span className="absolute bottom-2 right-2 rounded bg-[#10252b]/80 px-1.5 py-1 text-[9px] font-bold text-white">{capture.time}</span></div><div className="flex items-center justify-between bg-[#fbfdfb] px-3 py-2.5"><span className="text-[11px] font-bold text-[#395754]">{capture.quality}</span><span className="flex items-center gap-1 text-[9px] font-extrabold uppercase text-[#32816d]"><CheckCircle2 className="size-3" />{capture.upload}</span></div></button>)}
            </div>
            <div className="grid grid-cols-[1fr_270px] gap-3">
              <div className="rounded-xl border border-[#d6e2de] bg-[#fbfdfb] p-4"><div className="mb-3 flex items-center justify-between"><div><p className="text-[10px] font-extrabold uppercase tracking-[.18em] text-[#67807b]">Inspection window</p><p className="mt-1 text-xs text-[#6f837f]">Larger preview for the highlighted candidate</p></div><span className="flex items-center gap-1 text-[9px] font-extrabold uppercase tracking-wider text-[#738a84]"><Maximize2 className="size-3" />Preview only</span></div><div className="relative overflow-hidden rounded-lg bg-[#183139]"><img src={current.image} alt={`Focused JPEG preview, frame ${current.frame}`} className="aspect-[2.15/1] w-full object-cover" /><div className="absolute bottom-0 inset-x-0 flex items-center justify-between bg-gradient-to-t from-[#10252b]/85 to-transparent p-3 pt-8"><span className="font-mono text-[10px] text-white">{target.toUpperCase()}_{current.frame}.JPG · {current.time}</span><span className="text-[9px] font-extrabold uppercase tracking-wider text-[#d5eea2]">Lightweight JPEG</span></div><button onClick={() => move(-1)} aria-label="Previous frame" className="absolute left-2 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full bg-[#10252b]/70 text-white"><ChevronLeft className="size-4" /></button><button onClick={() => move(1)} aria-label="Next frame" className="absolute right-2 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full bg-[#10252b]/70 text-white"><ChevronRight className="size-4" /></button></div></div>
              <div className="flex flex-col justify-between rounded-xl border border-[#cadfcd] bg-[#eaf7e9] p-4"><div><p className="text-[10px] font-extrabold uppercase tracking-[.18em] text-[#54755f]">Decision</p><h3 className="mt-1 text-lg font-extrabold text-[#24463f]">{best === selected ? "This is the best shot" : "Choose a gallery shot"}</h3><p className="mt-2 text-[11px] leading-relaxed text-[#59776a]">Your review is saved to the capture set. Camera originals remain untouched.</p></div><button onClick={() => { setBest(selected); setNotice("Best shot updated"); }} className="mt-4 flex items-center justify-center gap-2 rounded-lg bg-[#244a4b] py-3 text-[10px] font-extrabold uppercase tracking-wider text-white hover:bg-[#183b3d]"><Star className="size-3.5" fill="currentColor" />Mark frame {current.frame} as best</button></div>
            </div>
          </div>
        </section>
      </div>
      {qrOpen && <div className="fixed inset-0 z-40 flex items-center justify-center bg-[#10252b]/80 p-5" role="dialog" aria-modal="true"><div className="relative w-full max-w-[440px] rounded-2xl bg-[#fbfdfb] p-6 text-center shadow-2xl"><button onClick={() => setQrOpen(false)} aria-label="Close pairing QR" className="absolute right-4 top-4 rounded p-1 text-[#6a817d] hover:bg-[#e9f0ec]"><X className="size-5" /></button><p className="text-[10px] font-extrabold uppercase tracking-[.2em] text-[#27715f]">Pairing QR · active target</p><h3 className="mt-2 text-2xl font-extrabold">{target}</h3><div className="mx-auto my-5 flex size-[270px] max-h-[52vh] max-w-full items-center justify-center rounded-xl border-[15px] border-[#10252b] bg-white"><QrCode className="size-full text-[#10252b]" /></div><p className="font-mono text-sm font-bold text-[#58716e]">LHS-0247</p><p className="mt-1 text-xs text-[#718682]">Scan to pair the next capture. Target stays locked while reviewing.</p><button onClick={() => setQrOpen(false)} className="mt-5 w-full rounded-lg bg-[#244a4b] py-3 text-[10px] font-extrabold uppercase tracking-wider text-white">Close</button></div></div>}
      {notice && <button onClick={() => setNotice("")} role="status" className="fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-lg border border-[#afd787] bg-[#f1fbdf] px-4 py-3 text-xs font-bold text-[#315847] shadow-lg"><Check className="size-4" />{notice}</button>}
    </main>
  );
}