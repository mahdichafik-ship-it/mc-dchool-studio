export default function Slide05_ImportRoster() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-bg flex flex-col">
      <div className="absolute top-0 left-0 right-0 h-[0.4vh] bg-primary" />
      <div className="flex h-full">

        {/* Left: text */}
        <div className="flex flex-col justify-center w-[55vw] px-[7vw] py-[8vh]">
          <div className="inline-flex items-center gap-[0.8vw] bg-primary/20 border border-primary/40 rounded-full px-[1.5vw] py-[0.6vh] mb-[3vh] self-start">
            <span className="text-[1.3vw] font-display font-bold text-primary">STEP 2</span>
          </div>
          <h2 className="text-[3.4vw] font-display font-bold text-text leading-tight mb-[3.5vh]" style={{ textWrap: 'balance' }}>
            Import the student roster
          </h2>
          <div className="flex flex-col gap-[2vh]">
            <div className="flex items-start gap-[1.2vw]">
              <div className="w-[0.7vw] h-[0.7vw] rounded-full bg-primary mt-[0.9vh] shrink-0" />
              <p className="text-[2vw] font-body text-slate-300">Upload the school's CSV or Excel file directly</p>
            </div>
            <div className="flex items-start gap-[1.2vw]">
              <div className="w-[0.7vw] h-[0.7vw] rounded-full bg-primary mt-[0.9vh] shrink-0" />
              <p className="text-[2vw] font-body text-slate-300">Map columns: Last Name, First Name, Class, ID, Email, Phone</p>
            </div>
            <div className="flex items-start gap-[1.2vw]">
              <div className="w-[0.7vw] h-[0.7vw] rounded-full bg-primary mt-[0.9vh] shrink-0" />
              <p className="text-[2vw] font-body text-slate-300">Handles French headers, alternate column names, extra columns</p>
            </div>
            <div className="flex items-start gap-[1.2vw]">
              <div className="w-[0.7vw] h-[0.7vw] rounded-full bg-primary mt-[0.9vh] shrink-0" />
              <p className="text-[2vw] font-body text-slate-300">Students and classes created in seconds</p>
            </div>
          </div>
        </div>

        {/* Right: column-mapping visual */}
        <div className="flex items-center justify-center flex-1 pr-[5vw]">
          <div className="flex flex-col gap-[1.4vh] w-full max-w-[28vw]">
            <div className="bg-slate-800/80 rounded-xl px-[2vw] py-[1.4vh] flex items-center justify-between">
              <span className="text-[1.7vw] font-body text-muted">nom_famille</span>
              <span className="text-[1.4vw] text-slate-600 mx-[0.8vw]">→</span>
              <span className="text-[1.7vw] font-body font-semibold text-accent">Last Name</span>
            </div>
            <div className="bg-slate-800/80 rounded-xl px-[2vw] py-[1.4vh] flex items-center justify-between">
              <span className="text-[1.7vw] font-body text-muted">prenom</span>
              <span className="text-[1.4vw] text-slate-600 mx-[0.8vw]">→</span>
              <span className="text-[1.7vw] font-body font-semibold text-accent">First Name</span>
            </div>
            <div className="bg-slate-800/80 rounded-xl px-[2vw] py-[1.4vh] flex items-center justify-between">
              <span className="text-[1.7vw] font-body text-muted">classe</span>
              <span className="text-[1.4vw] text-slate-600 mx-[0.8vw]">→</span>
              <span className="text-[1.7vw] font-body font-semibold text-accent">Class</span>
            </div>
            <div className="bg-slate-800/80 rounded-xl px-[2vw] py-[1.4vh] flex items-center justify-between">
              <span className="text-[1.7vw] font-body text-muted">numero</span>
              <span className="text-[1.4vw] text-slate-600 mx-[0.8vw]">→</span>
              <span className="text-[1.7vw] font-body font-semibold text-accent">Student ID</span>
            </div>
            <div className="bg-slate-800/80 rounded-xl px-[2vw] py-[1.4vh] flex items-center justify-between">
              <span className="text-[1.7vw] font-body text-muted">courriel</span>
              <span className="text-[1.4vw] text-slate-600 mx-[0.8vw]">→</span>
              <span className="text-[1.7vw] font-body font-semibold text-accent">Email</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
