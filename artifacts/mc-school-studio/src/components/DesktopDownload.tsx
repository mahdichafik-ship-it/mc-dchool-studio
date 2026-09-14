import { useEffect, useState } from "react";
import {
  getGetDesktopReleaseQueryKey,
  useGetDesktopRelease,
} from "@workspace/api-client-react";
import { Apple, Monitor } from "lucide-react";
import {
  detectDesktopPlatform,
  detectDesktopPlatformBestEffort,
  type DesktopArchitecture,
  type DesktopPlatformDetection,
} from "@/lib/desktopArchitecture";

type DesktopDownloadProps = {
  variant: "landing" | "dashboard";
};

const architectureLabels: Record<DesktopArchitecture, string> = {
  arm64: "Apple Silicon",
  x64: "Intel",
};

export function DesktopDownload({ variant }: DesktopDownloadProps) {
  const releaseQuery = useGetDesktopRelease({
    query: { queryKey: getGetDesktopReleaseQueryKey() },
  });
  const [platform, setPlatform] = useState<DesktopPlatformDetection>(() => detectDesktopPlatform());

  useEffect(() => {
    let active = true;
    void detectDesktopPlatformBestEffort().then((detected) => {
      if (active) setPlatform(detected);
    });
    return () => {
      active = false;
    };
  }, []);

  const release = releaseQuery.data;
  const wrapperClass =
    variant === "landing"
      ? "rounded-2xl border border-teal-200 bg-teal-50 px-8 py-7 flex flex-col sm:flex-row items-center justify-between gap-6"
      : "rounded-xl border border-teal-200 bg-teal-50 p-6 flex flex-col sm:flex-row items-center justify-between gap-6";
  const iconClass = variant === "landing" ? "w-12 h-12" : "w-11 h-11";
  const buttonClass =
    variant === "landing"
      ? "inline-flex items-center gap-2 bg-white border border-slate-200 text-slate-700 text-sm font-semibold px-5 py-2.5 rounded-lg hover:bg-slate-50 hover:border-slate-300 transition-colors shadow-sm"
      : "inline-flex items-center gap-2 bg-white border border-slate-200 text-slate-700 text-sm font-medium px-4 py-2 rounded-lg hover:bg-slate-50 hover:border-slate-300 transition-colors shadow-sm";

  return (
    <section className={variant === "landing" ? "pb-16 px-8 max-w-6xl mx-auto" : undefined}>
      <div className={wrapperClass} data-testid={`card-desktop-download-${variant}`}>
        <div className="flex items-center gap-4">
          <div className={`${iconClass} rounded-xl bg-teal-600 flex items-center justify-center shrink-0`}>
            <Monitor className={variant === "landing" ? "w-6 h-6 text-white" : "w-5 h-5 text-white"} />
          </div>
          <div>
            <h2 className={`${variant === "landing" ? "text-lg" : "text-base"} font-bold text-slate-900`}>
              {variant === "landing" ? "Download the Desktop App" : "Desktop App — for shoot day"}
            </h2>
            <p className="text-sm text-slate-600 mt-0.5">
              {variant === "landing"
                ? "Shoot-day tool — auto-matches QR codes as photos land in your camera folder."
                : "Watch your camera folder, auto-match QR codes, and upload photos live during the shoot."}
            </p>
          </div>
        </div>

        <div
          className="w-full sm:w-auto shrink-0"
          data-testid={`status-desktop-release-${variant}`}
          role="status"
          aria-live="polite"
          aria-busy={releaseQuery.isLoading}
        >
          {releaseQuery.isLoading ? (
            <p className="text-sm text-slate-600 animate-pulse" data-testid="status-desktop-release-loading">
              Checking for the latest macOS release…
            </p>
          ) : releaseQuery.isError || !release ? (
            <p className="max-w-xs text-sm text-slate-600" data-testid="status-desktop-release-unavailable">
              The desktop release is temporarily unavailable. Please try again later.
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-sm font-medium text-slate-700" data-testid="text-desktop-release-version">
                macOS installers · v{release.version}
              </p>
              {!platform.isMac && (
                <p className="max-w-xs text-xs text-slate-600" data-testid="text-desktop-macos-only">
                  macOS only. Select the installer that matches your Mac.
                </p>
              )}
              {platform.isMac && !platform.architecture && (
                <p className="max-w-xs text-xs text-slate-600" data-testid="text-desktop-architecture-help">
                  Not sure which Mac you have? Choose Apple Silicon for M-series Macs, or Intel for older Macs.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {(["arm64", "x64"] as const).map((architecture) => {
                  const releaseArchitecture = release.architectures[architecture];
                  if (!releaseArchitecture) {
                    return (
                      <span
                        key={architecture}
                        className="text-xs text-slate-500"
                        data-testid={`status-desktop-asset-unavailable-${architecture}`}
                      >
                        {architectureLabels[architecture]} unavailable
                      </span>
                    );
                  }
                  const recommended = platform.architecture === architecture;
                  return (
                    <a
                      key={architecture}
                      href={releaseArchitecture.asset.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`${buttonClass} ${recommended ? "ring-2 ring-teal-500/40" : ""}`}
                      data-testid={`link-desktop-download-${architecture}`}
                    >
                      <Apple className="w-4 h-4" />
                      {architectureLabels[architecture]} (.dmg)
                      {recommended && <span className="text-xs text-teal-700">(Recommended)</span>}
                    </a>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
