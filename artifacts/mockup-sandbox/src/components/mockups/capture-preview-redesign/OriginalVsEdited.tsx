import { useState } from "react";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Crop,
  Expand,
  Info,
  LockKeyhole,
  QrCode,
  RotateCcw,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  SplitSquareHorizontal,
  X,
} from "lucide-react";
import "./_group.css";

type ViewMode = "split" | "slider";

const image = "/mc-school-studio-deck/hero.jpg";

export function OriginalVsEdited() {
  const [mode, setMode] = useState<ViewMode>("split");
  const [split, setSplit] = useState(52);
  const [ratio, setRatio] = useState("4 : 5");
  const [angle, setAngle] = useState(2);
  const [showQr, setShowQr] = useState(false);
  const [saved, setSaved] = useState(false);

  const reset = () => {
    setRatio("Original");
    setAngle(0);
    setSplit(52);
    setSaved(false);
  };

  return (
    <main className="capture-preview-redesign flex h-screen min-h-[720px] w-full flex-col overflow-hidden bg-[#eef2f1] text-slate-900">
      <header className="z-10 flex shrink-0 items-center justify-between border-b border-slate-800 bg-slate-950 px-5 py-3 text-white">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-8 items-center justify-center rounded-md border border-slate-700 bg-slate-900 text-teal-300">
            <Crop className="size-4" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-extrabold uppercase tracking-[.2em] text-teal-300">Capture review / edit verification</p>
            <h1 className="mt-0.5 truncate text-sm font-extrabold">Original vs edited framing</h1>
          </div>
        </div>
        <div className="hidden items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-400 md:flex">
          <LockKeyhole className="size-3.5 text-teal-400" /> Original untouched
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowQr(true)} className="flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-[10px] font-extrabold uppercase tracking-wider text-slate-300 hover:border-teal-400 hover:text-teal-200">
            <QrCode className="size-3.5" /> Pairing QR
          </button>
          <button onClick={reset} className="hidden items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-[10px] font-extrabold uppercase tracking-wider text-slate-300 sm:flex">
            <RotateCcw className="size-3.5" /> Reset
          </button>
          <button onClick={() => setSaved(true)} className="flex items-center gap-1.5 rounded-md bg-teal-400 px-4 py-2 text-[10px] font-extrabold uppercase tracking-wider text-slate-950 hover:bg-teal-300">
            <Save className="size-3.5" /> Save display edit
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="hidden w-[282px] shrink-0 border-r border-slate-200 bg-white lg:flex lg:flex-col">
          <div className="border-b border-slate-200 px-5 py-5">
            <p className="text-[10px] font-extrabold uppercase tracking-[.18em] text-slate-400">Active capture target</p>
            <div className="mt-3 flex items-center gap-3 rounded-lg border border-teal-200 bg-teal-50 p-3">
              <div className="flex size-10 items-center justify-center rounded-full bg-teal-700 text-sm font-extrabold text-white">MC</div>
              <div className="min-w-0">
                <p className="truncate text-sm font-extrabold">Maya Chen</p>
                <p className="mt-0.5 font-mono text-[10px] font-bold text-teal-700">LHS-0247 · GRADE 08</p>
              </div>
              <CheckCircle2 className="ml-auto size-4 shrink-0 text-teal-600" />
            </div>
            <p className="mt-3 flex items-center gap-1.5 text-[10px] font-bold leading-relaxed text-slate-500"><ShieldCheck className="size-3.5 text-emerald-600" /> Target is locked during review</p>
          </div>
          <div className="border-b border-slate-200 px-5 py-4">
            <p className="text-[10px] font-extrabold uppercase tracking-[.18em] text-slate-400">Capture context</p>
            <dl className="mt-3 space-y-3 text-xs">
              <div className="flex justify-between"><dt className="text-slate-500">Frame</dt><dd className="font-mono font-bold">004 / 004</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Captured</dt><dd className="font-mono font-bold">14:24:08</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Preview</dt><dd className="font-bold text-teal-700">Lightweight JPEG</dd></div>
            </dl>
          </div>
          <div className="mt-auto border-t border-slate-200 bg-slate-50 p-5">
            <div className="flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-wider text-emerald-700"><CheckCircle2 className="size-4" /> Safe to review</div>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">Local preview is available. The cloud copy will follow when this edit is saved.</p>
            <div className="mt-4 flex items-center gap-2 text-[10px] font-bold text-slate-500"><span className="size-2 rounded-full bg-emerald-500" /> Local safe <span className="ml-2 size-2 rounded-full bg-amber-400" /> Cloud queued</div>
          </div>
        </aside>

        <section className="cp-scrollbar min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1000px] px-5 py-5 lg:px-8">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <p className="font-mono text-[10px] font-bold text-slate-500">MAYA_0247_004.JPG</p>
                  <span className="rounded-full border border-slate-300 bg-white px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wider text-slate-500">JPEG preview</span>
                </div>
                <h2 className="mt-1 text-xl font-extrabold tracking-tight">Check the framing before saving</h2>
                <p className="mt-1 text-xs text-slate-500">Compare the display edit with the camera original. Your target stays Maya Chen.</p>
              </div>
              <div className="flex rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
                <button onClick={() => setMode("split")} className={`flex items-center gap-1.5 rounded-md px-3 py-2 text-[10px] font-extrabold uppercase tracking-wider ${mode === "split" ? "bg-slate-900 text-white" : "text-slate-500"}`}><SplitSquareHorizontal className="size-3.5" /> Side by side</button>
                <button onClick={() => setMode("slider")} className={`flex items-center gap-1.5 rounded-md px-3 py-2 text-[10px] font-extrabold uppercase tracking-wider ${mode === "slider" ? "bg-slate-900 text-white" : "text-slate-500"}`}><SlidersHorizontal className="size-3.5" /> Slider</button>
              </div>
            </div>

            <div className="relative overflow-hidden rounded-xl border border-slate-700 bg-slate-950 shadow-lg">
              <div className={`relative flex ${mode === "slider" ? "aspect-[16/7]" : "aspect-[16/7]"}`}>
                <div className="relative min-w-0 flex-1 overflow-hidden bg-[#cbd3d3]">
                  <img src={image} alt="Original Maya Chen JPEG preview" className="h-full w-full object-cover grayscale-[.08]" />
                  <span className="absolute left-4 top-4 rounded bg-slate-950/80 px-2.5 py-1.5 text-[10px] font-extrabold uppercase tracking-widest text-white">Original</span>
                  <span className="absolute bottom-4 left-4 rounded bg-white/90 px-2 py-1 text-[9px] font-bold text-slate-700">Camera JPEG · untouched</span>
                </div>
                {mode === "split" ? (
                  <div className="relative min-w-0 flex-1 overflow-hidden border-l-2 border-white bg-[#cbd3d3]">
                    <img src={image} alt="Edited Maya Chen JPEG preview" className="h-full w-full object-cover" style={{ transform: `rotate(${angle}deg) scale(${ratio === "Original" ? 1 : 1.08})`, transformOrigin: "center" }} />
                    <span className="absolute left-4 top-4 rounded bg-teal-500 px-2.5 py-1.5 text-[10px] font-extrabold uppercase tracking-widest text-slate-950">Edited</span>
                    <span className="absolute bottom-4 left-4 rounded bg-slate-950/80 px-2 py-1 text-[9px] font-bold text-white">Display edit · preview</span>
                  </div>
                ) : (
                  <div className="absolute inset-y-0 left-0 overflow-hidden border-r-2 border-white" style={{ width: `${split}%` }}>
                    <img src={image} alt="Edited comparison preview" className="h-full max-w-none object-cover" style={{ width: "1000px", transform: `rotate(${angle}deg) scale(${ratio === "Original" ? 1 : 1.08})`, transformOrigin: "center" }} />
                    <span className="absolute left-4 top-4 rounded bg-teal-500 px-2.5 py-1.5 text-[10px] font-extrabold uppercase tracking-widest text-slate-950">Edited</span>
                  </div>
                )}
              </div>
              {mode === "slider" && <div className="absolute inset-y-0 z-10" style={{ left: `${split}%` }}><div className="absolute inset-y-0 w-0.5 bg-white shadow" /><input aria-label="Compare original and edited framing" type="range" min="8" max="92" value={split} onChange={(event) => setSplit(Number(event.target.value))} className="absolute left-1/2 top-1/2 h-full w-8 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize opacity-0" /><div className="absolute left-1/2 top-1/2 flex size-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white bg-slate-950 text-white shadow-lg"><SplitSquareHorizontal className="size-4" /></div></div>}
              <div className="flex items-center justify-between border-t border-white/10 bg-slate-950 px-4 py-2 text-[9px] font-bold uppercase tracking-wider text-slate-400"><span>{mode === "slider" ? "Drag the divider to compare" : "Original pixels remain unchanged"}</span><span>Preview only · no RAW loaded</span></div>
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_300px]">
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-center justify-between"><div><p className="text-[10px] font-extrabold uppercase tracking-[.18em] text-slate-400">Edit settings summary</p><p className="mt-1 text-xs text-slate-500">Only the review copy will be updated.</p></div><span className="rounded-full bg-teal-50 px-2 py-1 text-[9px] font-extrabold uppercase tracking-wider text-teal-700">Non-destructive</span></div>
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <div className="rounded-lg bg-slate-50 p-3"><p className="text-[9px] font-extrabold uppercase tracking-widest text-slate-400">Crop</p><p className="mt-1 text-sm font-extrabold">{ratio}</p></div>
                  <div className="rounded-lg bg-slate-50 p-3"><p className="text-[9px] font-extrabold uppercase tracking-widest text-slate-400">Straighten</p><p className="mt-1 font-mono text-sm font-extrabold">{angle > 0 ? "+" : ""}{angle}°</p></div>
                  <div className="col-span-2 rounded-lg border border-teal-100 bg-teal-50 p-3 sm:col-span-1"><p className="text-[9px] font-extrabold uppercase tracking-widest text-teal-700">Result</p><p className="mt-1 text-sm font-extrabold text-teal-900">Ready to save</p></div>
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 size-5 shrink-0 text-teal-600" /><div><p className="text-xs font-extrabold">Original stays recoverable</p><p className="mt-1 text-[11px] leading-relaxed text-slate-500">Saving creates a new display edit. The camera JPEG and RAW are never overwritten.</p></div></div>
                <div className="mt-4 flex items-center gap-2 border-t border-slate-100 pt-3 text-[10px] font-bold text-slate-500"><CheckCircle2 className="size-3.5 text-emerald-600" /> Local safe <span className="ml-auto text-amber-600">Cloud queued</span></div>
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between"><div><p className="text-[10px] font-extrabold uppercase tracking-[.18em] text-slate-400">Edit controls</p><p className="mt-1 text-xs text-slate-500">Make a focused correction, then compare again.</p></div><button onClick={reset} className="text-[10px] font-extrabold uppercase tracking-wider text-teal-700">Reset changes</button></div>
              <div className="mt-4 grid gap-4 sm:grid-cols-[190px_1fr]">
                <label className="text-[10px] font-extrabold uppercase tracking-widest text-slate-500">Crop ratio<select value={ratio} onChange={(event) => setRatio(event.target.value)} className="mt-2 w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-bold"><option>Original</option><option>4 : 5</option><option>5 : 7</option><option>Square</option></select><ChevronDown className="pointer-events-none relative float-right -mt-6 mr-2 size-3.5 text-slate-400" /></label>
                <label className="text-[10px] font-extrabold uppercase tracking-widest text-slate-500">Straighten <span className="float-right font-mono text-teal-700">{angle > 0 ? "+" : ""}{angle}°</span><input aria-label="Straighten edit" type="range" min="-8" max="8" value={angle} onChange={(event) => setAngle(Number(event.target.value))} className="mt-4 w-full accent-teal-600" /><span className="mt-1 flex justify-between font-mono text-[9px] text-slate-400"><span>-8°</span><span>0°</span><span>+8°</span></span></label>
              </div>
            </div>
          </div>
        </section>
      </div>

      {showQr && <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/80 p-5" role="dialog" aria-modal="true"><div className="relative w-full max-w-[410px] rounded-2xl bg-white p-6 text-center shadow-2xl"><button onClick={() => setShowQr(false)} aria-label="Close pairing QR" className="absolute right-4 top-4 rounded p-1 text-slate-400 hover:bg-slate-100"><X className="size-5" /></button><p className="text-[10px] font-extrabold uppercase tracking-[.2em] text-teal-700">Pairing QR · active target</p><h3 className="mt-2 text-xl font-extrabold">Maya Chen</h3><div className="mx-auto my-5 flex size-[260px] items-center justify-center rounded-xl border-[14px] border-slate-950 bg-white"><QrCode className="size-full text-slate-950" /></div><p className="font-mono text-sm font-bold text-slate-600">LHS-0247</p><p className="mt-1 text-xs text-slate-500">Scan to pair the next capture. Review does not change the target.</p><button onClick={() => setShowQr(false)} className="mt-5 w-full rounded-lg bg-slate-900 py-3 text-[10px] font-extrabold uppercase tracking-wider text-white">Close</button></div></div>}
      {saved && <div role="status" className="fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-lg border border-teal-300 bg-slate-950 px-4 py-3 text-xs font-bold text-white shadow-xl"><Check className="size-4 text-teal-300" /> Display edit saved · original untouched</div>}
    </main>
  );
}