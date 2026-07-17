const base = import.meta.env.BASE_URL;

export default function Slide11_RealtimeMatching() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-bg flex flex-col">
      <div className="absolute top-0 left-0 right-0 h-[0.4vh] bg-primary" />
      <div className="flex h-full">

        {/* Left: text */}
        <div className="flex flex-col justify-center w-[52vw] px-[7vw] py-[8vh]">
          <h2 className="text-[3.4vw] font-display font-bold text-text leading-tight mb-[3.5vh]" style={{ textWrap: 'balance' }}>
            Real-time matching — how it works
          </h2>
          <div className="flex flex-col gap-[2vh]">
            <div className="flex items-start gap-[1.2vw] bg-slate-800/60 rounded-xl px-[2vw] py-[1.8vh]">
              <div className="w-[0.7vw] h-[0.7vw] rounded-full bg-primary mt-[0.8vh] shrink-0" />
              <p className="text-[1.9vw] font-body text-slate-300">Chokidar watches the folder for every new JPEG</p>
            </div>
            <div className="flex items-start gap-[1.2vw] bg-slate-800/60 rounded-xl px-[2vw] py-[1.8vh]">
              <div className="w-[0.7vw] h-[0.7vw] rounded-full bg-primary mt-[0.8vh] shrink-0" />
              <p className="text-[1.9vw] font-body text-slate-300">jsQR scans the image for a QR code</p>
            </div>
            <div className="flex items-start gap-[1.2vw] bg-primary/20 border border-primary/40 rounded-xl px-[2vw] py-[1.8vh]">
              <div className="w-[0.7vw] h-[0.7vw] rounded-full bg-accent mt-[0.8vh] shrink-0" />
              <p className="text-[1.9vw] font-body text-accent">If matched: photo assigned to the student, upload queued</p>
            </div>
            <div className="flex items-start gap-[1.2vw] bg-slate-800/60 rounded-xl px-[2vw] py-[1.8vh]">
              <div className="w-[0.7vw] h-[0.7vw] rounded-full bg-muted mt-[0.8vh] shrink-0" />
              <p className="text-[1.9vw] font-body text-muted">If no QR found: photo flagged as unmatched for review</p>
            </div>
          </div>
        </div>

        {/* Right: flow diagram image */}
        <div className="relative flex-1 overflow-hidden">
          <img
            src={`${base}flow.jpg`}
            crossOrigin="anonymous"
            className="absolute inset-0 w-full h-full object-cover"
            alt=""
          />
          <div className="absolute inset-0 bg-gradient-to-r from-bg via-bg/10 to-transparent" />
        </div>
      </div>
    </div>
  );
}
