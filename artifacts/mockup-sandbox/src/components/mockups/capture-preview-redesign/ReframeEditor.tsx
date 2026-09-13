import { useState, type PointerEvent } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Crop,
  FlipHorizontal,
  Info,
  Lock,
  RotateCcw,
  RotateCw,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from "lucide-react";
import "./_group.css";

type Ratio = "Original" | "4 : 5" | "5 : 7" | "Square";

const image = "/mc-school-studio-deck/hero.jpg";

export function ReframeEditor() {
  const [ratio, setRatio] = useState<Ratio>("Original");
  const [angle, setAngle] = useState(0);
  const [rotation, setRotation] = useState(0);
  const [crop, setCrop] = useState({ x: 50, y: 50, zoom: 1 });
  const [dragging, setDragging] = useState(false);
  const [saved, setSaved] = useState(false);

  const ratioClass = ratio === "Square" ? "aspect-square" : ratio === "4 : 5" ? "aspect-[4/5]" : ratio === "5 : 7" ? "aspect-[5/7]" : "aspect-[16/10]";
  const nudge = (x: number, y: number) => setCrop((value) => ({ ...value, x: Math.max(15, Math.min(85, value.x + x)), y: Math.max(15, Math.min(85, value.y + y)) }));
  const reset = () => { setRatio("Original"); setAngle(0); setRotation(0); setCrop({ x: 50, y: 50, zoom: 1 }); setSaved(false); };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    setCrop((value) => ({
      ...value,
      x: Math.max(15, Math.min(85, ((event.clientX - bounds.left) / bounds.width) * 100)),
      y: Math.max(15, Math.min(85, ((event.clientY - bounds.top) / bounds.height) * 100)),
    }));
  };

  return (
    <main className="capture-preview-redesign flex min-h-[720px] h-screen w-full flex-col overflow-hidden bg-slate-50 text-slate-900">
      <header className="flex shrink-0 items-center justify-between border-b border-slate-800 bg-slate-950 px-5 py-3 text-white">
        <div className="flex min-w-0 items-center gap-3">
          <button aria-label="Back to capture review" className="rounded-md bg-slate-900 p-2 text-slate-400 hover:bg-slate-800 hover:text-white"><ArrowLeft className="size-4" /></button>
          <div className="h-7 w-px bg-slate-700" />
          <div><p className="text-[10px] font-extrabold uppercase tracking-[.18em] text-teal-300">Capture review</p><h1 className="mt-0.5 text-sm font-extrabold tracking-tight">Reframe &amp; straighten</h1></div>
        </div>
        <div className="hidden items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-400 sm:flex"><Lock className="size-3.5 text-teal-400" /> Original untouched</div>
        <div className="flex items-center gap-2">
          <button onClick={reset} className="flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-[10px] font-extrabold uppercase tracking-wider text-slate-300 hover:bg-slate-800"><RotateCcw className="size-3.5" /> Reset</button>
          <button onClick={() => setSaved(true)} className="flex items-center gap-1.5 rounded-md bg-teal-500 px-4 py-2 text-[10px] font-extrabold uppercase tracking-wider text-slate-950 hover:bg-teal-400"><Check className="size-3.5" /> Save edit</button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <section className="cp-scrollbar min-w-0 flex-1 overflow-y-auto bg-[#e8edf0]">
          <div className="mx-auto flex max-w-[820px] flex-col px-5 py-5 lg:px-10 lg:py-7">
            <div className="mb-4 flex items-center justify-between">
              <div><p className="font-mono text-[10px] font-bold text-slate-500">MAYA_0247_004.JPG</p><p className="mt-1 text-xs font-medium text-slate-500">Lincoln Heights School · Grade 08 · 14:24:08</p></div>
              <span className="rounded-full border border-slate-300 bg-white/60 px-2.5 py-1 text-[9px] font-extrabold uppercase tracking-widest text-slate-500">JPEG preview</span>
            </div>
            <div className="relative flex min-h-[445px] items-center justify-center overflow-hidden rounded-xl border border-slate-300 bg-[#cdd5d8] p-7 shadow-sm">
              <div
                className={`relative ${ratioClass} w-full max-w-[680px] cursor-move overflow-hidden rounded-sm bg-slate-900 shadow-2xl`}
                onPointerDown={() => setDragging(true)} onPointerUp={() => setDragging(false)} onPointerLeave={() => setDragging(false)} onPointerMove={onPointerMove}
              >
                <img src={image} alt="Maya Chen school portrait preview" className="absolute h-full w-full max-w-none object-cover transition-transform duration-150" style={{ transform: `translate(${50 - crop.x}%, ${50 - crop.y}%) scale(${crop.zoom}) rotate(${rotation}deg)`, transformOrigin: `${crop.x}% ${crop.y}%` }} draggable={false} />
                <div className="pointer-events-none absolute inset-0" style={{ transform: `rotate(${angle}deg)` }}>
                  <div className="absolute inset-0 border border-white/80" />
                  <div className="absolute inset-x-0 top-1/3 border-t border-white/35" /><div className="absolute inset-x-0 top-2/3 border-t border-white/35" />
                  <div className="absolute inset-y-0 left-1/3 border-l border-white/35" /><div className="absolute inset-y-0 left-2/3 border-l border-white/35" />
                </div>
                <div className="pointer-events-none absolute bottom-3 left-3 rounded bg-slate-950/65 px-2 py-1 font-mono text-[9px] text-white/85">{angle > 0 ? `STRAIGHTEN +${angle}°` : "DRAG TO REFRAME"}</div>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between text-[10px] font-bold text-slate-500"><span>Drag the image to reframe</span><span>Preview only · no pixels changed yet</span></div>
            <div className="mt-5 flex items-center justify-between rounded-lg border border-teal-200 bg-teal-50 px-3 py-2.5 text-xs text-teal-900"><span className="flex items-center gap-2"><ShieldCheck className="size-4 text-teal-700" /><strong>Safe edit:</strong> the camera original and RAW stay untouched.</span><Info className="size-4 text-teal-700" /></div>
          </div>
        </section>

        <aside className="cp-scrollbar w-[300px] shrink-0 overflow-y-auto border-l border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-5 py-5"><p className="text-[10px] font-extrabold uppercase tracking-[.18em] text-slate-400">Edit controls</p><h2 className="mt-1 text-base font-extrabold tracking-tight">Make a small correction</h2><p className="mt-1 text-xs leading-relaxed text-slate-500">Adjust the preview without leaving the shoot context.</p></div>
          <div className="space-y-5 p-5">
            <div><div className="mb-2 flex items-center justify-between"><label className="flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-widest text-slate-500"><Crop className="size-3.5 text-teal-600" /> Aspect ratio</label><span className="text-[10px] font-bold text-slate-400">Crop</span></div><div className="relative"><select value={ratio} onChange={(event) => setRatio(event.target.value as Ratio)} className="w-full appearance-none rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-bold text-slate-700 outline-none focus:border-teal-500"><option>Original</option><option>4 : 5</option><option>5 : 7</option><option>Square</option></select><ChevronDown className="pointer-events-none absolute right-3 top-3 size-3.5 text-slate-400" /></div></div>
            <div><div className="mb-2 flex items-center justify-between"><label className="flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-widest text-slate-500"><SlidersHorizontal className="size-3.5 text-teal-600" /> Straighten</label><span className="font-mono text-[10px] font-bold text-teal-700">{angle > 0 ? "+" : ""}{angle}°</span></div><input aria-label="Straighten angle" type="range" min="-8" max="8" step="1" value={angle} onChange={(event) => setAngle(Number(event.target.value))} className="w-full accent-teal-600" /><div className="mt-1 flex justify-between font-mono text-[9px] text-slate-400"><span>-8°</span><span>0°</span><span>+8°</span></div></div>
            <div><p className="mb-2 text-[10px] font-extrabold uppercase tracking-widest text-slate-500">Position</p><div className="grid grid-cols-3 gap-1.5"><span /><button onClick={() => nudge(0, -5)} className="rounded border border-slate-200 py-2 text-xs font-bold text-slate-600 hover:border-teal-400">↑</button><span /><button onClick={() => nudge(-5, 0)} className="rounded border border-slate-200 py-2 text-xs font-bold text-slate-600 hover:border-teal-400">←</button><button onClick={() => nudge(0, 5)} className="rounded border border-slate-200 py-2 text-xs font-bold text-slate-600 hover:border-teal-400">↓</button><button onClick={() => nudge(5, 0)} className="rounded border border-slate-200 py-2 text-xs font-bold text-slate-600 hover:border-teal-400">→</button></div></div>
            <div><p className="mb-2 text-[10px] font-extrabold uppercase tracking-widest text-slate-500">Rotate 90°</p><div className="flex gap-2"><button onClick={() => setRotation((value) => value - 90)} className="flex flex-1 items-center justify-center gap-2 rounded-md border border-slate-200 py-2.5 text-[10px] font-extrabold uppercase tracking-wider text-slate-600 hover:border-teal-400"><RotateCcw className="size-3.5" /> Left</button><button onClick={() => setRotation((value) => value + 90)} className="flex flex-1 items-center justify-center gap-2 rounded-md border border-slate-200 py-2.5 text-[10px] font-extrabold uppercase tracking-wider text-slate-600 hover:border-teal-400"><RotateCw className="size-3.5" /> Right</button></div></div>
            <button onClick={() => setRotation((value) => value + 180)} className="flex w-full items-center justify-center gap-2 rounded-md border border-slate-200 py-2 text-[10px] font-extrabold uppercase tracking-wider text-slate-500 hover:bg-slate-50"><FlipHorizontal className="size-3.5" /> Flip horizontal</button>
          </div>
          <div className="mt-auto border-t border-slate-200 bg-slate-50 p-5"><button onClick={() => setSaved(false)} className="flex w-full items-center justify-center gap-2 rounded-md border border-slate-300 bg-white py-2.5 text-[10px] font-extrabold uppercase tracking-wider text-slate-600 hover:bg-slate-100"><X className="size-3.5" /> Cancel</button><p className="mt-3 text-center text-[10px] leading-relaxed text-slate-400">Saving creates a new display edit.<br />Your original capture remains recoverable.</p></div>
        </aside>
      </div>
      {saved && <div role="status" className="fixed bottom-5 right-5 flex items-center gap-2 rounded-lg border border-teal-300 bg-slate-950 px-4 py-3 text-xs font-bold text-white shadow-xl"><Check className="size-4 text-teal-300" /> Reframe saved to review copy</div>}
    </main>
  );
}