export default function Slide14_LiveCounters() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-bg flex flex-col">
      <div className="absolute top-0 left-0 right-0 h-[0.4vh] bg-primary" />
      <div className="flex flex-col h-full px-[8vw] pt-[8vh] pb-[6vh]">

        {/* Header */}
        <div className="mb-[5vh]">
          <h2 className="text-[4vw] font-display font-bold text-text leading-tight" style={{ textWrap: 'balance' }}>
            Live counters keep you on track
          </h2>
          <p className="text-[2vw] font-body text-muted mt-[1.5vh]">
            All updated in real time — no refreshing, no guessing.
          </p>
        </div>

        {/* Stat cards */}
        <div className="flex gap-[2.5vw] flex-1">
          <div className="flex-1 bg-slate-800/60 rounded-2xl flex flex-col items-center justify-center gap-[1.5vh]">
            <p className="text-[8vw] font-display font-bold text-primary leading-none">12</p>
            <p className="text-[1.9vw] font-body text-muted">Classes photographed</p>
            <div className="w-[6vw] h-[0.5vh] bg-primary/40 rounded-full" />
            <p className="text-[1.6vw] font-body text-slate-500">vs. remaining</p>
          </div>
          <div className="flex-1 bg-slate-800/60 rounded-2xl flex flex-col items-center justify-center gap-[1.5vh]">
            <p className="text-[8vw] font-display font-bold text-accent leading-none">248</p>
            <p className="text-[1.9vw] font-body text-muted">Students matched</p>
            <div className="w-[6vw] h-[0.5vh] bg-accent/40 rounded-full" />
            <p className="text-[1.6vw] font-body text-slate-500">vs. total roster</p>
          </div>
          <div className="flex-1 bg-slate-800/60 rounded-2xl flex flex-col items-center justify-center gap-[1.5vh]">
            <p className="text-[8vw] font-display font-bold text-text leading-none">263</p>
            <p className="text-[1.9vw] font-body text-muted">Photos taken today</p>
            <div className="w-[6vw] h-[0.5vh] bg-slate-600 rounded-full" />
            <p className="text-[1.6vw] font-body text-slate-500">incl. retakes</p>
          </div>
        </div>
      </div>
    </div>
  );
}
