const base = import.meta.env.BASE_URL;

export default function Slide06_QRCodes() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-bg flex flex-col">
      <div className="absolute top-0 left-0 right-0 h-[0.4vh] bg-primary" />
      <div className="flex h-full">

        {/* Left: text */}
        <div className="flex flex-col justify-center w-[50vw] px-[7vw] py-[8vh]">
          <div className="inline-flex items-center gap-[0.8vw] bg-primary/20 border border-primary/40 rounded-full px-[1.5vw] py-[0.6vh] mb-[3vh] self-start">
            <span className="text-[1.3vw] font-display font-bold text-primary">STEP 3</span>
          </div>
          <h2 className="text-[3.4vw] font-display font-bold text-text leading-tight mb-[3.5vh]" style={{ textWrap: 'balance' }}>
            QR codes, auto-generated
          </h2>
          <div className="flex flex-col gap-[2vh]">
            <div className="flex items-start gap-[1.2vw]">
              <div className="w-[0.7vw] h-[0.7vw] rounded-full bg-primary mt-[0.9vh] shrink-0" />
              <p className="text-[2vw] font-body text-slate-300">Every student gets a unique QR code the moment they're added</p>
            </div>
            <div className="flex items-start gap-[1.2vw]">
              <div className="w-[0.7vw] h-[0.7vw] rounded-full bg-primary mt-[0.9vh] shrink-0" />
              <p className="text-[2vw] font-body text-slate-300">QR codes are stored in the cloud — accessible from any browser</p>
            </div>
            <div className="flex items-start gap-[1.2vw]">
              <div className="w-[0.7vw] h-[0.7vw] rounded-full bg-primary mt-[0.9vh] shrink-0" />
              <p className="text-[2vw] font-body text-slate-300">No extra software or generation step needed</p>
            </div>
          </div>
        </div>

        {/* Right: QR card image */}
        <div className="relative flex-1 overflow-hidden">
          <img
            src={`${base}qr-cards.jpg`}
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
