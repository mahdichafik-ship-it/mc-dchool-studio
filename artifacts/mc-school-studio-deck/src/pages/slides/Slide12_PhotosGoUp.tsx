export default function Slide12_PhotosGoUp() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-bg flex flex-col">
      <div className="absolute top-0 left-0 right-0 h-[0.4vh] bg-primary" />
      <div className="flex flex-col h-full px-[8vw] pt-[8vh] pb-[6vh]">

        {/* Header */}
        <div className="mb-[4vh]">
          <h2 className="text-[4vw] font-display font-bold text-text leading-tight" style={{ textWrap: 'balance' }}>
            Photos go up as you shoot
          </h2>
        </div>

        {/* Bullets */}
        <div className="flex flex-col gap-[2vh] flex-1">
          <div className="flex items-center gap-[2vw] bg-slate-800/60 rounded-2xl px-[3vw] py-[2.5vh]">
            <div className="w-[0.9vw] h-[0.9vw] rounded-full bg-primary shrink-0" />
            <p className="text-[2.1vw] font-body text-slate-200">Uploads happen in the background over Wi-Fi</p>
          </div>
          <div className="flex items-center gap-[2vw] bg-slate-800/60 rounded-2xl px-[3vw] py-[2.5vh]">
            <div className="w-[0.9vw] h-[0.9vw] rounded-full bg-primary shrink-0" />
            <p className="text-[2.1vw] font-body text-slate-200">No waiting until the end of the day</p>
          </div>
          <div className="flex items-center gap-[2vw] bg-slate-800/60 rounded-2xl px-[3vw] py-[2.5vh]">
            <div className="w-[0.9vw] h-[0.9vw] rounded-full bg-primary shrink-0" />
            <p className="text-[2.1vw] font-body text-slate-200">Failed uploads are retried automatically</p>
          </div>
          <div className="flex items-center gap-[2vw] bg-slate-800/60 rounded-2xl px-[3vw] py-[2.5vh]">
            <div className="w-[0.9vw] h-[0.9vw] rounded-full bg-primary shrink-0" />
            <p className="text-[2.1vw] font-body text-slate-200">The web app reflects new photos within seconds</p>
          </div>
        </div>
      </div>
    </div>
  );
}
