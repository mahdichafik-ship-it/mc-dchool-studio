export default function Slide07_PrintDistribute() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-bg flex flex-col">
      <div className="absolute top-0 left-0 right-0 h-[0.4vh] bg-primary" />
      <div className="flex flex-col h-full px-[8vw] pt-[8vh] pb-[6vh]">

        {/* Header */}
        <div className="mb-[5vh]">
          <h2 className="text-[4vw] font-display font-bold text-text leading-tight" style={{ textWrap: 'balance' }}>
            Print &amp; distribute before shoot day
          </h2>
        </div>

        {/* Three large cards */}
        <div className="flex gap-[2.5vw] flex-1">
          <div className="flex-1 bg-slate-800/60 rounded-2xl px-[3vw] py-[4vh] flex flex-col gap-[2vh]">
            <div className="w-[3.5vw] h-[3.5vw] rounded-xl bg-primary/20 border border-primary/40 flex items-center justify-center">
              <div className="w-[1.8vw] h-[1.8vw] rounded bg-primary/60" />
            </div>
            <p className="text-[2vw] font-body text-slate-200 leading-snug" style={{ textWrap: 'pretty' }}>
              Download all QR codes as a ZIP or a print-ready PDF
            </p>
          </div>
          <div className="flex-1 bg-slate-800/60 rounded-2xl px-[3vw] py-[4vh] flex flex-col gap-[2vh]">
            <div className="w-[3.5vw] h-[3.5vw] rounded-xl bg-primary/20 border border-primary/40 flex items-center justify-center">
              <div className="w-[1.8vw] h-[1.8vw] rounded-full border-2 border-primary/60" />
            </div>
            <p className="text-[2vw] font-body text-slate-200 leading-snug" style={{ textWrap: 'pretty' }}>
              Print and hand cards to students before they sit down
            </p>
          </div>
          <div className="flex-1 bg-slate-800/60 rounded-2xl px-[3vw] py-[4vh] flex flex-col gap-[2vh]">
            <div className="w-[3.5vw] h-[3.5vw] rounded-xl bg-primary/20 border border-primary/40 flex items-center justify-center">
              <div className="w-[0.5vw] h-[1.8vw] bg-primary/60 rounded-full" />
            </div>
            <p className="text-[2vw] font-body text-slate-200 leading-snug" style={{ textWrap: 'pretty' }}>
              No barcodes to scan manually — students walk in with their card
            </p>
          </div>
        </div>

        {/* Footer note */}
        <p className="text-[1.6vw] font-body text-muted mt-[3vh]" style={{ textWrap: 'pretty' }}>
          Cards can be prepared days in advance and handed to teachers before photo day.
        </p>
      </div>
    </div>
  );
}
