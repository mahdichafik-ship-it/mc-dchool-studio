import { useEffect, useState } from "react";
import { ArrowRight, Cloud, HardDrive, Loader2 } from "lucide-react";
import { useLocation } from "wouter";

type StudioStorageContext = {
  studio: {
    name: string;
    storageStatus: "needs_setup" | "using_platform" | "connection_requested" | "connected" | "connection_error";
  };
  member: {
    role: string;
    status: string;
  };
};

export function StudioStoragePrompt() {
  const [, setLocation] = useLocation();
  const [context, setContext] = useState<StudioStorageContext | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void fetch("/api/studio")
      .then(async (response) => response.ok ? response.json() as Promise<StudioStorageContext> : null)
      .then((data) => {
        if (active) setContext(data);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  const canManage = context?.member.status === "active"
    && (context.member.role === "owner" || context.member.role === "admin");
  if (!canManage || context?.studio.storageStatus !== "needs_setup") return null;

  async function usePlatformStorage() {
    setSaving(true);
    try {
      const response = await fetch("/api/studio/storage", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "platform_google_drive" }),
      });
      if (response.ok) {
        setContext((current) => current ? {
          ...current,
          studio: { ...current.studio, storageStatus: "using_platform" },
        } : current);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-teal-200 bg-white shadow-sm">
      <div className="grid gap-6 p-6 lg:grid-cols-[1fr_auto] lg:items-center">
        <div className="flex gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-teal-100 text-teal-700">
            <Cloud className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-teal-700">Studio setup</p>
            <h2 className="mt-1 text-xl font-semibold text-slate-950">Choose where {context.studio.name} stores its photos</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              Your JPEG and RAW files are already protected by the platform work Drive. You can keep that coverage or request your own Google Drive or Dropbox connection.
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row lg:flex-col">
          <button
            type="button"
            onClick={() => setLocation("/studio/settings")}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-teal-600 px-4 text-sm font-semibold text-white hover:bg-teal-700"
          >
            Set up storage <ArrowRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void usePlatformStorage()}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <HardDrive className="h-4 w-4" />}
            Use platform storage
          </button>
        </div>
      </div>
    </section>
  );
}