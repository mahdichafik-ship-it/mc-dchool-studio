export default function Slide16_Transformed() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-bg flex flex-col">
      <div className="absolute top-0 left-0 right-0 h-[0.4vh] bg-primary" />
      <div className="flex flex-col h-full px-[8vw] pt-[8vh] pb-[6vh]">

        {/* Header */}
        <div className="mb-[4vh]">
          <h2 className="text-[4vw] font-display font-bold text-text leading-tight" style={{ textWrap: 'balance' }}>
            Your shoot day, transformed
          </h2>
        </div>

        {/* Before / After columns */}
        <div className="flex gap-[3vw] flex-1">

          {/* Before */}
          <div className="flex-1 bg-red-950/30 border border-red-900/40 rounded-2xl px-[3vw] py-[3vh] flex flex-col">
            <p className="text-[1.5vw] font-display font-bold text-red-400 tracking-widest uppercase mb-[2.5vh]">
              Before MC School Studio
            </p>
            <div className="flex flex-col gap-[2vh] flex-1">
              <div className="flex items-start gap-[1.2vw]">
                <div className="w-[0.8vw] h-[0.8vw] rounded-full bg-red-500 mt-[0.7vh] shrink-0" />
                <p className="text-[2vw] font-body text-slate-300">3–4 hours of post-shoot photo matching</p>
              </div>
              <div className="flex items-start gap-[1.2vw]">
                <div className="w-[0.8vw] h-[0.8vw] rounded-full bg-red-500 mt-[0.7vh] shrink-0" />
                <p className="text-[2vw] font-body text-slate-300">Errors requiring re-shoots</p>
              </div>
              <div className="flex items-start gap-[1.2vw]">
                <div className="w-[0.8vw] h-[0.8vw] rounded-full bg-red-500 mt-[0.7vh] shrink-0" />
                <p className="text-[2vw] font-body text-slate-300">Spreadsheets emailed back and forth</p>
              </div>
            </div>
          </div>

          {/* Divider */}
          <div className="flex items-center">
            <div className="w-px h-[60%] bg-slate-700" />
          </div>

          {/* After */}
          <div className="flex-1 bg-primary/10 border border-primary/30 rounded-2xl px-[3vw] py-[3vh] flex flex-col">
            <p className="text-[1.5vw] font-display font-bold text-accent tracking-widest uppercase mb-[2.5vh]">
              After MC School Studio
            </p>
            <div className="flex flex-col gap-[2vh] flex-1">
              <div className="flex items-start gap-[1.2vw]">
                <div className="w-[0.8vw] h-[0.8vw] rounded-full bg-accent mt-[0.7vh] shrink-0" />
                <p className="text-[2vw] font-body text-slate-200">Matching happens live, during the shoot</p>
              </div>
              <div className="flex items-start gap-[1.2vw]">
                <div className="w-[0.8vw] h-[0.8vw] rounded-full bg-accent mt-[0.7vh] shrink-0" />
                <p className="text-[2vw] font-body text-slate-200">Zero manual renaming</p>
              </div>
              <div className="flex items-start gap-[1.2vw]">
                <div className="w-[0.8vw] h-[0.8vw] rounded-full bg-accent mt-[0.7vh] shrink-0" />
                <p className="text-[2vw] font-body text-slate-200">Everything in the cloud before you pack up</p>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-[3vh] text-center">
          <p className="text-[1.8vw] font-display font-semibold text-primary tracking-wide">mc-school-studio.com</p>
        </div>
      </div>
    </div>
  );
}
