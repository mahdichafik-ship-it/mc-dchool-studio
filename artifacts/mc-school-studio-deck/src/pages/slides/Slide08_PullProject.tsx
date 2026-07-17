export default function Slide08_PullProject() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-bg flex flex-col">
      <div className="absolute top-0 left-0 right-0 h-[0.4vh] bg-primary" />
      <div className="flex flex-col h-full px-[8vw] pt-[8vh] pb-[6vh]">

        {/* Header */}
        <div className="mb-[4vh]">
          <div className="inline-flex items-center gap-[0.8vw] bg-primary/20 border border-primary/40 rounded-full px-[1.5vw] py-[0.6vh] mb-[2.5vh]">
            <span className="text-[1.3vw] font-display font-bold text-primary">STEP 4</span>
          </div>
          <h2 className="text-[3.8vw] font-display font-bold text-text leading-tight" style={{ textWrap: 'balance' }}>
            Pull your project to the desktop app
          </h2>
        </div>

        {/* Bullets */}
        <div className="flex flex-col gap-[2vh] flex-1">
          <div className="flex items-center gap-[2vw] bg-slate-800/60 rounded-2xl px-[3vw] py-[2.5vh]">
            <div className="w-[0.9vw] h-[0.9vw] rounded-full bg-primary shrink-0" />
            <p className="text-[2.1vw] font-body text-slate-200">Install the MC School Studio desktop app once</p>
          </div>
          <div className="flex items-center gap-[2vw] bg-slate-800/60 rounded-2xl px-[3vw] py-[2.5vh]">
            <div className="w-[0.9vw] h-[0.9vw] rounded-full bg-primary shrink-0" />
            <p className="text-[2.1vw] font-body text-slate-200">Enter your API URL and upload key in Settings</p>
          </div>
          <div className="flex items-center gap-[2vw] bg-slate-800/60 rounded-2xl px-[3vw] py-[2.5vh]">
            <div className="w-[0.9vw] h-[0.9vw] rounded-full bg-primary shrink-0" />
            <p className="text-[2.1vw] font-body text-slate-200">
              Click <span className="text-accent font-semibold">'Sync from Cloud'</span> — your project appears immediately
            </p>
          </div>
          <div className="flex items-center gap-[2vw] bg-slate-800/60 rounded-2xl px-[3vw] py-[2.5vh]">
            <div className="w-[0.9vw] h-[0.9vw] rounded-full bg-primary shrink-0" />
            <p className="text-[2.1vw] font-body text-slate-200">Classes, students, and QR data all downloaded locally</p>
          </div>
        </div>
      </div>
    </div>
  );
}
