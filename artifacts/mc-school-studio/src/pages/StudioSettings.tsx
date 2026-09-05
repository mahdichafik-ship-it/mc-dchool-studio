import { useEffect, useState } from "react";
import { CheckCircle2, Cloud, Database, ExternalLink, HardDrive, ImageIcon, Loader2, Palette, Save, ShieldCheck, Unplug, Upload, X } from "lucide-react";

type StorageProvider = "platform_google_drive" | "google_drive" | "dropbox";
type StudioContext = {
  studio: {
    id: number;
    name: string;
    tagline: string | null;
    description: string | null;
    website: string | null;
    contactEmail: string | null;
    logoObjectPath: string | null;
    primaryColor: string;
    accentColor: string;
    brandingUpdatedAt: string | null;
    storageProvider: StorageProvider;
    storageStatus: "needs_setup" | "using_platform" | "connection_requested" | "connected" | "connection_error";
    storageRequestedAt: string | null;
    storageConnectedAt: string | null;
  };
  member: {
    role: string;
    status: string;
  };
  activeStorageProvider: StorageProvider;
  connections: Array<{
    id: number;
    provider: "google_drive" | "dropbox";
    providerAccountEmail: string;
    status: "active" | "revoked" | "error";
    lastVerifiedAt: string;
  }>;
  storageAudit: Array<{
    id: number;
    action: string;
    provider: StorageProvider;
    providerAccountEmail: string | null;
    detail: string | null;
    createdAt: string;
  }>;
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

function contrastColor(hex: string) {
  const value = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return "#FFFFFF";
  const [red, green, blue] = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
  return (red * 299 + green * 587 + blue * 114) / 1000 > 150 ? "#0F172A" : "#FFFFFF";
}

export default function StudioSettings() {
  const [context, setContext] = useState<StudioContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<StorageProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [branding, setBranding] = useState({
    name: "",
    tagline: "",
    website: "",
    contactEmail: "",
    logoObjectPath: null as string | null,
    primaryColor: "#0F766E",
    accentColor: "#14B8A6",
  });
  const [brandingSaving, setBrandingSaving] = useState(false);
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [brandingMessage, setBrandingMessage] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const response = await fetch("/api/studio");
      const body = await response.json().catch(() => ({})) as StudioContext & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not load studio storage.");
      setContext(body);
      setBranding({
        name: body.studio.name,
        tagline: body.studio.tagline ?? "",
        website: body.studio.website ?? "",
        contactEmail: body.studio.contactEmail ?? "",
        logoObjectPath: body.studio.logoObjectPath,
        primaryColor: body.studio.primaryColor,
        accentColor: body.studio.accentColor,
      });
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
      if (provider !== "platform_google_drive") {
        const response = await fetch(`/api/studio/storage/oauth/${provider}/start`, { method: "POST" });
        const body = await response.json().catch(() => ({})) as { authorizationUrl?: string; error?: string };
        if (!response.ok || !body.authorizationUrl) {
          throw new Error(body.error ?? "Could not start the secure connection.");
        }
        window.location.assign(body.authorizationUrl);
        return;
      }
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

  async function disconnectStorage() {
    setSaving(context?.studio.storageProvider ?? null);
    setError(null);
    try {
      const response = await fetch("/api/studio/storage/connection", { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? "Could not disconnect storage.");
      }
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not disconnect storage.");
    } finally {
      setSaving(null);
    }
  }

  async function uploadLogo(file: File) {
    setLogoUploading(true);
    setBrandingMessage(null);
    setError(null);
    try {
      const request = await fetch("/api/studio/branding/logo-upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
      });
      const upload = await request.json().catch(() => ({})) as { uploadUrl?: string; objectPath?: string; error?: string };
      if (!request.ok || !upload.uploadUrl || !upload.objectPath) throw new Error(upload.error ?? "Could not prepare the logo upload.");
      const uploaded = await fetch(upload.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!uploaded.ok) throw new Error("The logo upload did not complete.");
      setBranding((current) => ({ ...current, logoObjectPath: upload.objectPath! }));
      setLogoPreview((current) => {
        if (current) URL.revokeObjectURL(current);
        return URL.createObjectURL(file);
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not upload the logo.");
    } finally {
      setLogoUploading(false);
    }
  }

  async function saveBranding(event: React.FormEvent) {
    event.preventDefault();
    setBrandingSaving(true);
    setBrandingMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/studio/branding", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(branding),
      });
      const body = await response.json().catch(() => ({})) as { studio?: StudioContext["studio"]; error?: string };
      if (!response.ok || !body.studio) throw new Error(body.error ?? "Could not save studio branding.");
      setContext((current) => current ? { ...current, studio: body.studio! } : current);
      setBranding({
        name: body.studio.name,
        tagline: body.studio.tagline ?? "",
        website: body.studio.website ?? "",
        contactEmail: body.studio.contactEmail ?? "",
        logoObjectPath: body.studio.logoObjectPath,
        primaryColor: body.studio.primaryColor,
        accentColor: body.studio.accentColor,
      });
      if (logoPreview) URL.revokeObjectURL(logoPreview);
      setLogoPreview(null);
      setBrandingMessage("Studio branding saved.");
      window.dispatchEvent(new CustomEvent("studio-branding-updated", {
        detail: {
          name: body.studio.name,
          logoObjectPath: body.studio.logoObjectPath,
          primaryColor: body.studio.primaryColor,
          accentColor: body.studio.accentColor,
          brandingUpdatedAt: body.studio.brandingUpdatedAt,
        },
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save studio branding.");
    } finally {
      setBrandingSaving(false);
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
  const activeConnection = context.connections.find((connection) =>
    connection.provider === context.studio.storageProvider && connection.status === "active",
  );
  const callbackStatus = new URLSearchParams(window.location.search).get("storage");

  return (
    <div className="flex-1 overflow-auto bg-slate-50 p-5 sm:p-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <header>
          <p className="text-sm font-semibold text-teal-700">{context.studio.name}</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-slate-950">Studio settings</h1>
          <p className="mt-2 max-w-2xl text-slate-600">Manage your studio identity and where original JPEG and RAW files are backed up.</p>
        </header>

        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 p-5">
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-teal-50 p-2 text-teal-700"><Palette className="h-5 w-5" /></div>
              <div><h2 className="font-semibold text-slate-950">Studio branding</h2><p className="mt-1 text-sm text-slate-600">Customize the identity your team sees across the studio workspace.</p></div>
            </div>
          </div>
          <form onSubmit={(event) => void saveBranding(event)} className="grid gap-6 p-5 lg:grid-cols-[1.25fr_0.75fr]">
            <div className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block"><span className="text-sm font-medium text-slate-700">Studio name</span><input required minLength={2} maxLength={120} value={branding.name} onChange={(event) => setBranding((current) => ({ ...current, name: event.target.value }))} className="mt-1 h-10 w-full rounded-md border border-slate-300 px-3 text-sm" /></label>
                <label className="block"><span className="text-sm font-medium text-slate-700">Tagline</span><input maxLength={120} value={branding.tagline} onChange={(event) => setBranding((current) => ({ ...current, tagline: event.target.value }))} placeholder="School portraits, beautifully organized" className="mt-1 h-10 w-full rounded-md border border-slate-300 px-3 text-sm" /></label>
                <label className="block"><span className="text-sm font-medium text-slate-700">Website</span><input type="url" maxLength={200} value={branding.website} onChange={(event) => setBranding((current) => ({ ...current, website: event.target.value }))} placeholder="https://yourstudio.com" className="mt-1 h-10 w-full rounded-md border border-slate-300 px-3 text-sm" /></label>
                <label className="block"><span className="text-sm font-medium text-slate-700">Contact email</span><input type="email" maxLength={200} value={branding.contactEmail} onChange={(event) => setBranding((current) => ({ ...current, contactEmail: event.target.value }))} placeholder="hello@yourstudio.com" className="mt-1 h-10 w-full rounded-md border border-slate-300 px-3 text-sm" /></label>
              </div>
              <div>
                <span className="text-sm font-medium text-slate-700">Studio logo</span>
                <div className="mt-2 flex flex-col gap-3 rounded-xl border border-dashed border-slate-300 p-4 sm:flex-row sm:items-center">
                  <div className="flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-slate-100">
                    {logoPreview || branding.logoObjectPath ? <img src={logoPreview ?? `/api/studio/branding/logo?rev=${encodeURIComponent(context.studio.brandingUpdatedAt ?? "")}`} alt="Studio logo preview" className="h-full w-full object-contain p-2" /> : <ImageIcon className="h-6 w-6 text-slate-400" />}
                  </div>
                  <div className="flex-1"><p className="text-sm text-slate-600">PNG, JPEG, or WebP. Maximum 2 MB. A wide transparent logo works best.</p><div className="mt-3 flex flex-wrap gap-2"><label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"><Upload className="h-4 w-4" />{logoUploading ? "Uploading…" : "Choose logo"}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={logoUploading || !canManage} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadLogo(file); event.currentTarget.value = ""; }} className="sr-only" /></label>{branding.logoObjectPath && <button type="button" onClick={() => { if (logoPreview) URL.revokeObjectURL(logoPreview); setLogoPreview(null); setBranding((current) => ({ ...current, logoObjectPath: null })); }} className="inline-flex items-center gap-2 rounded-md border border-red-200 px-3 py-2 text-sm font-semibold text-red-700"><X className="h-4 w-4" />Remove</button>}</div></div>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block"><span className="text-sm font-medium text-slate-700">Primary color</span><div className="mt-1 flex gap-2"><input type="color" value={branding.primaryColor} onChange={(event) => setBranding((current) => ({ ...current, primaryColor: event.target.value.toUpperCase() }))} className="h-10 w-12 rounded border border-slate-300 bg-white p-1" /><input pattern="#[0-9A-Fa-f]{6}" value={branding.primaryColor} onChange={(event) => setBranding((current) => ({ ...current, primaryColor: event.target.value }))} className="h-10 flex-1 rounded-md border border-slate-300 px-3 font-mono text-sm uppercase" /></div></label>
                <label className="block"><span className="text-sm font-medium text-slate-700">Accent color</span><div className="mt-1 flex gap-2"><input type="color" value={branding.accentColor} onChange={(event) => setBranding((current) => ({ ...current, accentColor: event.target.value.toUpperCase() }))} className="h-10 w-12 rounded border border-slate-300 bg-white p-1" /><input pattern="#[0-9A-Fa-f]{6}" value={branding.accentColor} onChange={(event) => setBranding((current) => ({ ...current, accentColor: event.target.value }))} className="h-10 flex-1 rounded-md border border-slate-300 px-3 font-mono text-sm uppercase" /></div></label>
              </div>
              {brandingMessage && <p className="text-sm font-medium text-emerald-700">{brandingMessage}</p>}
              {canManage ? <button disabled={brandingSaving || logoUploading} className="inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold disabled:opacity-50" style={{ backgroundColor: branding.primaryColor, color: contrastColor(branding.primaryColor) }}><Save className="h-4 w-4" />{brandingSaving ? "Saving…" : "Save branding"}</button> : <p className="text-sm text-slate-600">Only the studio owner or an administrator can change branding.</p>}
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Live preview</p>
              <div className="mt-4 overflow-hidden rounded-xl border bg-white shadow-sm">
                <div className="h-2" style={{ backgroundColor: branding.accentColor }} />
                <div className="p-5">
                  <div className="flex h-14 w-24 items-center justify-center overflow-hidden rounded-lg bg-slate-50">
                    {logoPreview || branding.logoObjectPath ? <img src={logoPreview ?? `/api/studio/branding/logo?rev=${encodeURIComponent(context.studio.brandingUpdatedAt ?? "")}`} alt="" className="h-full w-full object-contain p-1" /> : <ImageIcon className="h-6 w-6 text-slate-300" />}
                  </div>
                  <h3 className="mt-4 text-xl font-bold text-slate-950">{branding.name || "Your studio"}</h3>
                  <p className="mt-1 text-sm text-slate-500">{branding.tagline || "Your studio tagline will appear here."}</p>
                  <div className="mt-5 rounded-lg px-4 py-3 text-sm font-semibold" style={{ backgroundColor: branding.primaryColor, color: contrastColor(branding.primaryColor) }}>Open project</div>
                  <div className="mt-3 h-1 rounded-full" style={{ backgroundColor: branding.accentColor }} />
                </div>
              </div>
            </div>
          </form>
        </section>

        <div>
          <h2 className="text-xl font-semibold text-slate-950">Photo storage</h2>
          <p className="mt-1 text-sm text-slate-600">Choose where this studio’s original JPEG and RAW files are protected.</p>
        </div>

        {callbackStatus === "connected" && (
          <p className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">
            Storage connected and verified. New backups will use the account shown below.
          </p>
        )}
        {(callbackStatus === "connection_failed" || callbackStatus === "invalid_state") && (
          <p className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-900">
            The storage connection could not be verified. Platform storage remains active, so there is no backup gap.
          </p>
        )}

        <section className="flex flex-col gap-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-3">
            <div className="mt-0.5 text-emerald-700"><CheckCircle2 className="h-5 w-5" /></div>
            <div>
              <h2 className="font-semibold text-emerald-950">Backup is active</h2>
              <p className="mt-1 text-sm leading-6 text-emerald-800">
                {providerDetails[context.activeStorageProvider].name} is protecting uploads now.
                {requestedProvider ? ` Your ${providerDetails[requestedProvider].name} request is pending; there is no gap in coverage.` : ""}
                {context.studio.storageStatus === "connection_error" ? " The studio connection needs attention; platform storage has taken over automatically." : ""}
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
            const connection = context.connections.find((item) => item.provider === provider && item.status === "active");
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
                {connection && (
                  <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500"><ShieldCheck className="h-3.5 w-3.5" />Verified account</p>
                    <p className="mt-1 break-all text-sm font-medium text-slate-900">{connection.providerAccountEmail}</p>
                  </div>
                )}
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
                        : connection
                          ? <>Reconnect account <ExternalLink className="h-4 w-4" /></>
                          : <>Connect securely <ExternalLink className="h-4 w-4" /></>}
                  </button>
                )}
              </article>
            );
          })}
        </section>

        {!canManage && <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">Only the studio owner or an administrator can change storage.</p>}
        {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</p>}

        {canManage && activeConnection && (
          <section className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-semibold text-slate-950">Connected as {activeConnection.providerAccountEmail}</h2>
              <p className="mt-1 text-sm text-slate-600">Disconnecting immediately returns new uploads to platform storage. Existing files are untouched.</p>
            </div>
            <button type="button" disabled={saving !== null} onClick={() => void disconnectStorage()} className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-md border border-red-200 px-4 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50">
              <Unplug className="h-4 w-4" />Disconnect
            </button>
          </section>
        )}

        <section className="rounded-2xl border border-slate-200 bg-white p-5">
          <h2 className="font-semibold text-slate-950">How fallback works</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Until a studio-owned provider is fully authorized, uploads continue to the managed platform work Drive. Changing a preference never moves, renames, or deletes files that were already backed up.
          </p>
        </section>

        {context.storageAudit.length > 0 && (
          <section className="rounded-2xl border border-slate-200 bg-white p-5">
            <h2 className="font-semibold text-slate-950">Connection history</h2>
            <div className="mt-4 divide-y divide-slate-100">
              {context.storageAudit.map((entry) => (
                <div key={entry.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-medium text-slate-900">{entry.action.replaceAll("_", " ")}</p>
                    <p className="text-xs text-slate-500">{providerDetails[entry.provider].name}{entry.providerAccountEmail ? ` · ${entry.providerAccountEmail}` : ""}</p>
                  </div>
                  <time className="text-xs text-slate-500">{new Date(entry.createdAt).toLocaleString()}</time>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}