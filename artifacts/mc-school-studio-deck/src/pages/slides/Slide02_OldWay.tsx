export default function Slide02_OldWay() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-bg flex flex-col">
      <div className="absolute top-0 left-0 right-0 h-[0.4vh] bg-primary" />
      <div className="flex flex-col h-full px-[8vw] pt-[8vh] pb-[6vh]">

        {/* Header */}
        <div className="mb-[4vh]">
          <p className="text-[1.4vw] font-display font-semibold text-red-400 tracking-widest uppercase mb-[1.5vh]">
            The problem
          </p>
          <h2 className="text-[4vw] font-display font-bold text-text leading-tight" style={{ textWrap: 'balance' }}>
            The old way is broken
          </h2>
        </div>

        {/* Bullets */}
        <div className="flex flex-col gap-[2vh] flex-1">
          <div className="flex items-center gap-[2vw] bg-red-950/30 border border-red-900/40 rounded-2xl px-[3vw] py-[2.5vh]">
            <div className="w-[0.9vw] h-[0.9vw] rounded-full bg-red-500 shrink-0" />
            <p className="text-[2.1vw] font-body text-slate-200">Paper class lists that get lost or wrong</p>
          </div>
          <div className="flex items-center gap-[2vw] bg-red-950/30 border border-red-900/40 rounded-2xl px-[3vw] py-[2.5vh]">
            <div className="w-[0.9vw] h-[0.9vw] rounded-full bg-red-500 shrink-0" />
            <p className="text-[2.1vw] font-body text-slate-200">
              Manual photo renaming:{' '}
              <span className="font-mono text-red-300 text-[1.9vw]">IMG_4892</span>
              {' '}→{' '}
              <span className="font-mono text-red-300 text-[1.9vw]">Smith_Jane_Grade3</span>
            </p>
          </div>
          <div className="flex items-center gap-[2vw] bg-red-950/30 border border-red-900/40 rounded-2xl px-[3vw] py-[2.5vh]">
            <div className="w-[0.9vw] h-[0.9vw] rounded-full bg-red-500 shrink-0" />
            <p className="text-[2.1vw] font-body text-slate-200">Hours matching faces to names after every shoot</p>
          </div>
          <div className="flex items-center gap-[2vw] bg-red-950/30 border border-red-900/40 rounded-2xl px-[3vw] py-[2.5vh]">
            <div className="w-[0.9vw] h-[0.9vw] rounded-full bg-red-500 shrink-0" />
            <p className="text-[2.1vw] font-body text-slate-200">One mistake means re-shoots or unhappy schools</p>
          </div>
        </div>
      </div>
    </div>
  );
}
