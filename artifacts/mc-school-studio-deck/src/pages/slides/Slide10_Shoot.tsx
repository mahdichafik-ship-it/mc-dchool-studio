export default function Slide10_Shoot() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-bg flex flex-col">
      <div className="absolute top-0 left-0 right-0 h-[0.4vh] bg-primary" />
      <div className="flex flex-col h-full px-[8vw] pt-[8vh] pb-[6vh]">

        {/* Header */}
        <div className="mb-[4vh]">
          <div className="inline-flex items-center gap-[0.8vw] bg-primary/20 border border-primary/40 rounded-full px-[1.5vw] py-[0.6vh] mb-[2.5vh]">
            <span className="text-[1.3vw] font-display font-bold text-primary">STEP 5</span>
          </div>
          <h2 className="text-[3.8vw] font-display font-bold text-text leading-tight" style={{ textWrap: 'balance' }}>
            Shoot. The app does the rest.
          </h2>
        </div>

        {/* Bullets */}
        <div className="flex flex-col gap-[2vh] flex-1">
          <div className="flex items-center gap-[2vw] bg-slate-800/60 rounded-2xl px-[3vw] py-[2.5vh]">
            <div className="w-[0.9vw] h-[0.9vw] rounded-full bg-primary shrink-0" />
            <p className="text-[2.1vw] font-body text-slate-200">Student sits down, holds up their QR card</p>
          </div>
          <div className="flex items-center gap-[2vw] bg-slate-800/60 rounded-2xl px-[3vw] py-[2.5vh]">
            <div className="w-[0.9vw] h-[0.9vw] rounded-full bg-primary shrink-0" />
            <p className="text-[2.1vw] font-body text-slate-200">You take the photo — it lands in the watch folder</p>
          </div>
          <div className="flex items-center gap-[2vw] bg-slate-800/60 rounded-2xl px-[3vw] py-[2.5vh]">
            <div className="w-[0.9vw] h-[0.9vw] rounded-full bg-primary shrink-0" />
            <p className="text-[2.1vw] font-body text-slate-200">App reads the QR code in the photo automatically</p>
          </div>
          <div className="flex items-center gap-[2vw] bg-primary/20 border border-primary/40 rounded-2xl px-[3vw] py-[2.5vh]">
            <div className="w-[0.9vw] h-[0.9vw] rounded-full bg-accent shrink-0" />
            <p className="text-[2.1vw] font-body text-accent font-semibold">Student is matched and photo is uploaded to the cloud</p>
          </div>
        </div>
      </div>
    </div>
  );
}
