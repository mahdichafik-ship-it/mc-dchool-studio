import { useEffect, useState } from "react";
import { CheckCircle2, Cloud, Database, ExternalLink, HardDrive, Loader2 } from "lucide-react";

type StorageProvider = "platform_google_drive" | "google_drive" | "dropbox";
type StudioContext = {
  studio: {
    id: number;
    name: string;
    storageProvider: StorageProvider;
    storageStatus: "needs_setup" | "using_platform" | "connection_requested" | "connected";
    storageRequestedAt: string | null;
    storageConnectedAt: string | null;
  };
  member: {
    role: string;
    status: string;
  };
  activeStorageProvider: StorageProvider;
};

const providerDetails: Record<StorageProvider, {
  name: string;
  description: string;
  icon: typeof Cloud;
}> = {
  platform_google_drive: {
    name: "Platform work Drive",
    description: "Files are backed up to the managed Volume Capture workspace. No setup is required.",
    icon: HardDrive,
  },
  google_drive: {
    name: "Your Google Drive",
    description: "Request a studio-owned Google Drive connection while platform storage continues protecting new uploads.",
    icon: Cloud,
  },
  dropbox: {
    name: "Your Dropbox",
    description: "Request a studio-owned Dropbox connection while platform storage continues protecting new uploads.",
    icon: Database,
  },
};

export default function StudioSettings() {
  const [context, setContext] = useState<StudioContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<StorageProvider | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const response = await fetch("/api/studio");
      const body = await response.json().catch(() => ({})) as StudioContext & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not load studio storage.");
      setContext(body);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load studio storage.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function chooseProvider(provider: StorageProvider) {
    setSaving(provider);
    setError(null);
    try {
      const response = await fetch("/api/studio/storage", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const body = await response.json().catch(() => ({})) as {
        studio?: StudioContext["studio"];
        activeStorageProvider?: StorageProvider;
        error?: string;
      };
      if (!response.ok || !body.studio || !body.activeStorageProvider) {
        throw new Error(body.error ?? "Could not update the storage choice.");
      }
      setContext((current) => current ? {
        ...current,
        studio: body.studio!,
        activeStorageProvider: body.activeStorageProvider!,
      } : current);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update the storage choice.");
    } finally {
      setSaving(null);
    }
  }

  if (loading) {
    return <div className="flex flex-1 items-center justify-center bg-slate-50 text-slate-500"><Loader2 className="mr-2 h-5 w-5 animate-spin" />Loading studio storage…</div>;
  }
  if (!context) {
    return <div className="flex-1 bg-slate-50 p-8"><div className="mx-auto max-w-4xl rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800">{error ?? "Studio storage is unavailable."}</div></div>;
  }

  const canManage = context.member.status === "active"
    && (context.member.role === "owner" || context.member.role === "admin");
  const requestedProvider = context.studio.storageStatus === "connection_requested"
    ? context.studio.storageProvider
    : null;

  return (
    <div className="flex-1 overflow-auto bg-slate-50 p-5 sm:p-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <header>
          <p className="text-sm font-semibold text-teal-700">{context.studio.name}</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-slate-950">Storage</h1>
          <p className="mt-2 max-w-2xl text-slate-600">Choose where this studio’s original JPEG and RAW files are backed up.</p>
        </header>

        <section className="flex flex-col gap-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-3">
            <div className="mt-0.5 text-emerald-700"><CheckCircle2 className="h-5 w-5" /></div>
            <div>
              <h2 className="font-semibold text-emerald-950">Backup is active</h2>
              <p className="mt-1 text-sm leading-6 text-emerald-800">
                {providerDetails[context.activeStorageProvider].name} is protecting uploads now.
                {requestedProvider ? ` Your ${providerDetails[requestedProvider].name} request is pending; there is no gap in coverage.` : ""}
              </p>
            </div>
          </div>
          <span className="inline-flex w-fit items-center gap-2 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-emerald-800 shadow-sm">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />Active
          </span>
        </section>

        <section className="grid gap-4 lg:grid-cols-3">
          {(Object.keys(providerDetails) as StorageProvider[]).map((provider) => {
            const details = providerDetails[provider];
            const Icon = details.icon;
            const isActive = context.activeStorageProvider === provider;
            const isRequested = requestedProvider === provider;
            return (
              <article key={provider} className={`flex min-h-64 flex-col rounded-2xl border bg-white p-5 shadow-sm ${isActive ? "border-teal-300 ring-1 ring-teal-200" : "border-slate-200"}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${isActive ? "bg-teal-100 text-teal-700" : "bg-slate-100 text-slate-600"}`}>
                    <Icon className="h-5 w-5" />
                  </div>
                  {isActive && <span className="rounded-full bg-teal-50 px-2.5 py-1 text-xs font-semibold text-teal-700">Active now</span>}
                  {isRequested && <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700">Requested</span>}
                </div>
                <h2 className="mt-5 text-lg font-semibold text-slate-950">{details.name}</h2>
                <p className="mt-2 flex-1 text-sm leading-6 text-slate-600">{details.description}</p>
                {canManage && (
                  <button
                    type="button"
                    disabled={saving !== null || (provider === "platform_google_drive" && isActive && !requestedProvider) || isRequested}
                    onClick={() => void chooseProvider(provider)}
                    className={`mt-5 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold disabled:opacity-50 ${provider === "platform_google_drive" ? "bg-teal-600 text-white hover:bg-teal-700" : "border border-slate-300 text-slate-800 hover:bg-slate-50"}`}
                  >
                    {saving === provider && <Loader2 className="h-4 w-4 animate-spin" />}
                    {provider === "platform_google_drive"
                      ? "Use platform storage"
                      : isRequested
                        ? "Connection requested"
                        : <>Request connection <ExternalLink className="h-4 w-4" /></>}
                  </button>
                )}
              </article>
            );
          })}
        </section>

        {!canManage && <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">Only the studio owner or an administrator can change storage.</p>}
        {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</p>}

        <section className="rounded-2xl border border-slate-200 bg-white p-5">
          <h2 className="font-semibold text-slate-950">How fallback works</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Until a studio-owned provider is fully authorized, uploads continue to the managed platform work Drive. Changing a preference never moves, renames, or deletes files that were already backed up.
          </p>
        </section>
      </div>
    </div>
  );
}