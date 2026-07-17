const base = import.meta.env.BASE_URL;

export default function Slide01_Title() {
  return (
    <div className="relative w-screen h-screen overflow-hidden">
      <img
        src={`${base}hero.jpg`}
        crossOrigin="anonymous"
        className="absolute inset-0 w-full h-full object-cover"
        alt=""
      />
      <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/75 to-slate-950/20" />
      <div className="absolute top-0 left-0 right-0 h-[0.4vh] bg-primary" />

      {/* Top logo lockup */}
      <div className="absolute top-[5vh] left-[7vw] flex items-center gap-[0.8vw]">
        <div className="w-[0.35vw] h-[3.5vh] bg-accent rounded-full" />
        <span
          className="text-[1.3vw] font-display font-semibold text-accent tracking-widest uppercase"
          style={{ textWrap: 'nowrap' }}
        >
          MC School Studio
        </span>
      </div>

      {/* Main content — bottom-anchored */}
      <div className="absolute bottom-0 left-0 right-0 px-[7vw] pb-[10vh]">
        <p
          className="text-[1.5vw] font-display font-semibold text-primary tracking-widest uppercase mb-[2.5vh]"
          style={{ textWrap: 'nowrap' }}
        >
          School Photography Platform
        </p>
        <h1
          className="text-[6.2vw] font-display font-bold text-white leading-none tracking-tight mb-[3vh]"
          style={{ textWrap: 'balance' }}
        >
          The modern school<br />photography platform.
        </h1>
        <p className="text-[2.2vw] font-body text-slate-300 max-w-[52vw]" style={{ textWrap: 'pretty' }}>
          From roster to matched photos — automated, accurate, and done.
        </p>
      </div>
    </div>
  );
}
