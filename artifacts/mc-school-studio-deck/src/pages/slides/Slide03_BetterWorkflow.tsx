export default function Slide03_BetterWorkflow() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-bg flex flex-col">
      <div className="absolute top-0 left-0 right-0 h-[0.4vh] bg-primary" />
      <div className="flex flex-col h-full px-[8vw] pt-[8vh] pb-[6vh]">

        {/* Header */}
        <div className="mb-[4vh]">
          <p className="text-[1.4vw] font-display font-semibold text-accent tracking-widest uppercase mb-[1.5vh]">
            The solution
          </p>
          <h2 className="text-[4vw] font-display font-bold text-text leading-tight" style={{ textWrap: 'balance' }}>
            There's a better workflow
          </h2>
        </div>

        {/* Numbered steps */}
        <div className="flex flex-col gap-[2vh] flex-1">
          <div className="flex items-center gap-[2.5vw] bg-slate-800/60 rounded-2xl px-[3vw] py-[2.5vh]">
            <span className="text-[2.2vw] font-display font-bold text-primary w-[3vw] shrink-0 text-center">1</span>
            <div className="w-px h-[4vh] bg-slate-700 shrink-0" />
            <p className="text-[2.1vw] font-body text-slate-200">Prepare your project online before shoot day</p>
          </div>
          <div className="flex items-center gap-[2.5vw] bg-slate-800/60 rounded-2xl px-[3vw] py-[2.5vh]">
            <span className="text-[2.2vw] font-display font-bold text-primary w-[3vw] shrink-0 text-center">2</span>
            <div className="w-px h-[4vh] bg-slate-700 shrink-0" />
            <p className="text-[2.1vw] font-body text-slate-200">Print QR codes — one per student</p>
          </div>
          <div className="flex items-center gap-[2.5vw] bg-slate-800/60 rounded-2xl px-[3vw] py-[2.5vh]">
            <span className="text-[2.2vw] font-display font-bold text-primary w-[3vw] shrink-0 text-center">3</span>
            <div className="w-px h-[4vh] bg-slate-700 shrink-0" />
            <p className="text-[2.1vw] font-body text-slate-200">On shoot day: camera fires, app matches, photo uploads</p>
          </div>
          <div className="flex items-center gap-[2.5vw] bg-slate-800/60 rounded-2xl px-[3vw] py-[2.5vh]">
            <span className="text-[2.2vw] font-display font-bold text-primary w-[3vw] shrink-0 text-center">4</span>
            <div className="w-px h-[4vh] bg-slate-700 shrink-0" />
            <p className="text-[2.1vw] font-body text-slate-200">Review everything from the web — no USB, no spreadsheets</p>
          </div>
        </div>
      </div>
    </div>
  );
}
