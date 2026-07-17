const base = import.meta.env.BASE_URL;

export default function Slide09_ShootDaySetup() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-bg flex flex-col">
      <div className="absolute top-0 left-0 right-0 h-[0.4vh] bg-primary" />
      <div className="flex h-full">

        {/* Left: text */}
        <div className="flex flex-col justify-center w-[50vw] px-[7vw] py-[8vh]">
          <h2 className="text-[3.4vw] font-display font-bold text-text leading-tight mb-[3.5vh]" style={{ textWrap: 'balance' }}>
            Shoot-day setup takes 30 seconds
          </h2>
          <div className="flex flex-col gap-[2vh]">
            <div className="flex items-start gap-[1.2vw]">
              <div className="w-[0.7vw] h-[0.7vw] rounded-full bg-primary mt-[0.9vh] shrink-0" />
              <p className="text-[2vw] font-body text-slate-300">Open the project on the desktop app</p>
            </div>
            <div className="flex items-start gap-[1.2vw]">
              <div className="w-[0.7vw] h-[0.7vw] rounded-full bg-primary mt-[0.9vh] shrink-0" />
              <p className="text-[2vw] font-body text-slate-300">Set your watch folder (wherever your tethered camera saves)</p>
            </div>
            <div className="flex items-start gap-[1.2vw]">
              <div className="w-[0.7vw] h-[0.7vw] rounded-full bg-primary mt-[0.9vh] shrink-0" />
              <p className="text-[2vw] font-body text-slate-300">App starts watching — you're ready to shoot</p>
            </div>
          </div>
          <div className="mt-[4vh] inline-flex items-center gap-[1vw] bg-primary/20 border border-primary/40 rounded-full px-[1.8vw] py-[0.8vh] self-start">
            <div className="w-[0.8vw] h-[0.8vw] rounded-full bg-primary animate-pulse" />
            <span className="text-[1.5vw] font-display font-semibold text-accent">Watch folder active</span>
          </div>
        </div>

        {/* Right: tether image */}
        <div className="relative flex-1 overflow-hidden">
          <img
            src={`${base}tether.jpg`}
            crossOrigin="anonymous"
            className="absolute inset-0 w-full h-full object-cover"
            alt=""
          />
          <div className="absolute inset-0 bg-gradient-to-r from-bg via-bg/20 to-transparent" />
        </div>
      </div>
    </div>
  );
}
