import React, { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { Download, Image as ImageIcon, Loader2, LockKeyhole, RefreshCw } from "lucide-react";

type PublicGallery = {
  slug: string;
  status: string;
  expiresAt: string | null;
  studio: {
    name: string;
    tagline: string;
    primaryColor: string;
    accentColor: string;
  };
};

type GalleryResponse = {
  gallery: PublicGallery;
  student: { firstName: string; lastName: string };
  photos: { id: number; fileName: string; mimeType: string; fileUrl: string }[];
};

export default function Delivery() {
  const [match, params] = useRoute("/delivery/:slug");
  const slug = match ? params?.slug : undefined;
  const [gallery, setGallery] = useState<PublicGallery | null>(null);
  const [content, setContent] = useState<GalleryResponse | null>(null);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    const initialCode = new URLSearchParams(window.location.search).get("code") ?? "";
    setCode(initialCode);
    void fetch(`/api/delivery/${slug}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("This delivery gallery is not available.");
        setGallery(await response.json() as PublicGallery);
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : "This delivery gallery is not available."))
      .finally(() => setLoading(false));
  }, [slug]);

  async function openGallery(event?: React.FormEvent) {
    event?.preventDefault();
    if (!slug) return;
    setSubmitting(true);
    setError(null);
    try {
      const accessResponse = await fetch(`/api/delivery/${slug}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const accessBody = await accessResponse.json().catch(() => ({})) as { token?: string; error?: string };
      if (!accessResponse.ok || !accessBody.token) throw new Error(accessBody.error ?? "That access code is not valid.");
      const response = await fetch(`/api/delivery/${slug}/gallery`, {
        headers: { "x-delivery-token": accessBody.token },
      });
      if (!response.ok) throw new Error("The gallery could not be opened. Please try again.");
      setContent(await response.json() as GalleryResponse);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The gallery could not be opened.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-slate-500"><Loader2 className="mr-2 size-4 animate-spin" />Loading gallery…</div>;
  }

  if (!gallery || error && !content) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6"><div className="max-w-md rounded-2xl border bg-white p-8 text-center shadow-sm"><LockKeyhole className="mx-auto size-10 text-slate-400" /><h1 className="mt-4 text-xl font-semibold text-slate-900">Delivery unavailable</h1><p className="mt-2 text-sm text-slate-500">{error ?? "This gallery could not be found."}</p></div></div>;
  }

  const brandStyle = { "--delivery-primary": gallery.studio.primaryColor, "--delivery-accent": gallery.studio.accentColor } as React.CSSProperties;

  if (!content) {
    return (
      <div style={brandStyle} className="min-h-screen bg-slate-50 text-slate-900">
        <header className="border-b bg-white">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
            <div>
              <p className="font-semibold" style={{ color: "var(--delivery-primary)" }}>{gallery.studio.name}</p>
              <p className="text-sm text-slate-500">{gallery.studio.tagline}</p>
            </div>
            <LockKeyhole className="size-5 text-slate-400" />
          </div>
        </header>
        <main className="mx-auto flex max-w-md items-center px-6 py-20">
          <div className="w-full rounded-2xl border bg-white p-8 shadow-sm">
            <h1 className="text-2xl font-bold tracking-tight">Your private gallery</h1>
            <p className="mt-2 text-sm leading-6 text-slate-500">Enter the access code from your photo card to view and download your photos.</p>
            <form onSubmit={(event) => void openGallery(event)} className="mt-6 space-y-4">
              <label className="block text-sm font-medium text-slate-700">
                Access code
                <input
                  autoFocus
                  value={code}
                  onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))}
                  placeholder="ABCD2345"
                  maxLength={8}
                  className="mt-2 h-12 w-full rounded-lg border border-slate-300 px-4 text-center font-mono text-lg tracking-[0.25em] outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-100"
                />
              </label>
              {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
              <button disabled={submitting || code.length !== 8} className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-teal-700 px-4 text-sm font-semibold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50">
                {submitting ? <Loader2 className="size-4 animate-spin" /> : <LockKeyhole className="size-4" />}Open gallery
              </button>
            </form>
            <p className="mt-6 text-center text-xs text-slate-400">If you cannot find your code, please contact the photography studio.</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div style={brandStyle} className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <div>
            <p className="font-semibold" style={{ color: "var(--delivery-primary)" }}>{gallery.studio.name}</p>
            <p className="text-sm text-slate-500">{gallery.studio.tagline}</p>
          </div>
          <button onClick={() => { setContent(null); setError(null); }} className="text-sm font-medium text-slate-500 hover:text-slate-900">Use another code</button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-10">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div><p className="text-sm font-medium text-slate-500">Private delivery</p><h1 className="mt-1 text-3xl font-bold tracking-tight">{content.student.firstName} {content.student.lastName}</h1></div>
          <p className="text-sm text-slate-500">{content.photos.length} photo{content.photos.length === 1 ? "" : "s"} available</p>
        </div>
        {content.photos.length === 0 ? (
          <div className="mt-8 rounded-2xl border bg-white p-12 text-center"><ImageIcon className="mx-auto size-10 text-slate-300" /><h2 className="mt-4 font-semibold">Photos are not ready yet</h2><p className="mt-2 text-sm text-slate-500">Please check again later or contact the studio.</p><button onClick={() => void openGallery()} className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-teal-700"><RefreshCw className="size-4" />Refresh</button></div>
        ) : (
          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {content.photos.map((photo) => <a key={photo.id} href={photo.fileUrl} download={photo.fileName} className="group overflow-hidden rounded-2xl border bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"><div className="aspect-[4/5] bg-slate-100"><img src={photo.fileUrl} alt="Delivered portrait" className="h-full w-full object-cover" /></div><div className="flex items-center justify-between p-4"><span className="truncate text-sm font-medium text-slate-700">{photo.fileName}</span><Download className="ml-3 size-4 shrink-0 text-teal-700" /></div></a>)}
          </div>
        )}
      </main>
    </div>
  );
}