import React, { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { Check, Download, Image as ImageIcon, Loader2, LockKeyhole, RefreshCw, ShoppingBag } from "lucide-react";

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
  price: { unitAmount: number; currency: string };
  photos: {
    id: number;
    fileName: string;
    mimeType: string;
    fileUrl: string;
    downloadUrl: string;
  }[];
};

function formatPrice(amount: number, currency: string) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(amount / 100);
}

export default function Delivery() {
  const [match, params] = useRoute("/delivery/:slug");
  const slug = match ? params?.slug : undefined;
  const [gallery, setGallery] = useState<PublicGallery | null>(null);
  const [content, setContent] = useState<GalleryResponse | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [paidPhotoIds, setPaidPhotoIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!slug) return;
    const query = new URLSearchParams(window.location.search);
    setCode(query.get("code") ?? "");
    if (query.get("paid") === "1") setNotice("Payment received. We are confirming your order and preparing your downloads.");
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
      const response = await fetch(`/api/delivery/${slug}/gallery`, { headers: { "x-delivery-token": accessBody.token } });
      const body = await response.json().catch(() => ({})) as GalleryResponse & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "The gallery could not be opened. Please try again.");
      setToken(accessBody.token);
      setContent(body);
      setSelected(new Set());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The gallery could not be opened.");
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    if (!slug || !token || !content) return;
    const orderId = new URLSearchParams(window.location.search).get("order");
    if (!orderId) return;
    const deliveryToken = token;
    let stopped = false;
    let attempts = 0;
    async function checkOrder() {
      const response = await fetch(`/api/delivery/${slug}/orders/${orderId}?token=${encodeURIComponent(deliveryToken)}`);
      if (!response.ok || stopped) return;
      const body = await response.json() as { status: string; photoIds?: number[] };
      if (body.status === "paid") {
        setPaidPhotoIds(new Set(body.photoIds ?? []));
        setNotice("Payment confirmed. Your paid photos are ready to download.");
        return;
      }
      if (!stopped && attempts < 10) {
        attempts += 1;
        window.setTimeout(() => void checkOrder(), 2500);
      }
    }
    void checkOrder();
    return () => { stopped = true; };
  }, [slug, token, content]);

  function togglePhoto(photoId: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(photoId)) next.delete(photoId);
      else next.add(photoId);
      return next;
    });
  }

  async function startCheckout() {
    if (!slug || !token || selected.size === 0) return;
    setCheckoutLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/delivery/${slug}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, photoIds: [...selected] }),
      });
      const body = await response.json().catch(() => ({})) as { checkoutUrl?: string; error?: string };
      if (!response.ok || !body.checkoutUrl) throw new Error(body.error ?? "Checkout is not available yet.");
      window.location.assign(body.checkoutUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Checkout is not available yet.");
      setCheckoutLoading(false);
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
        <header className="border-b bg-white"><div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5"><div><p className="font-semibold" style={{ color: "var(--delivery-primary)" }}>{gallery.studio.name}</p><p className="text-sm text-slate-500">{gallery.studio.tagline}</p></div><LockKeyhole className="size-5 text-slate-400" /></div></header>
        <main className="mx-auto flex max-w-md items-center px-6 py-20">
          <div className="w-full rounded-2xl border bg-white p-8 shadow-sm">
            <h1 className="text-2xl font-bold tracking-tight">Your private gallery</h1>
            <p className="mt-2 text-sm leading-6 text-slate-500">Enter the access code from your photo card to view previews and order digital photos.</p>
            <form onSubmit={(event) => void openGallery(event)} className="mt-6 space-y-4">
              <label className="block text-sm font-medium text-slate-700">Access code
                <input autoFocus value={code} onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))} placeholder="ABCD2345" maxLength={8} className="mt-2 h-12 w-full rounded-lg border border-slate-300 px-4 text-center font-mono text-lg tracking-[0.25em] outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-100" />
              </label>
              {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
              <button disabled={submitting || code.length !== 8} className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-teal-700 px-4 text-sm font-semibold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50">{submitting ? <Loader2 className="size-4 animate-spin" /> : <LockKeyhole className="size-4" />}Open gallery</button>
            </form>
            <p className="mt-6 text-center text-xs text-slate-400">If you cannot find your code, please contact the photography studio.</p>
          </div>
        </main>
      </div>
    );
  }

  const selectedTotal = content.price.unitAmount * selected.size;
  return (
    <div style={brandStyle} className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b bg-white"><div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5"><div><p className="font-semibold" style={{ color: "var(--delivery-primary)" }}>{gallery.studio.name}</p><p className="text-sm text-slate-500">{gallery.studio.tagline}</p></div><button onClick={() => { setContent(null); setToken(null); setError(null); }} className="text-sm font-medium text-slate-500 hover:text-slate-900">Use another code</button></div></header>
      <main className="mx-auto max-w-6xl px-6 py-10 pb-32">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-sm font-medium text-slate-500">Private delivery</p><h1 className="mt-1 text-3xl font-bold tracking-tight">{content.student.firstName} {content.student.lastName}</h1></div><p className="text-sm text-slate-500">{content.photos.length} preview{content.photos.length === 1 ? "" : "s"} · {formatPrice(content.price.unitAmount, content.price.currency)} each</p></div>
        {notice && <div className="mt-6 flex items-start gap-3 rounded-xl border border-teal-200 bg-teal-50 p-4 text-sm text-teal-900"><Check className="mt-0.5 size-4 shrink-0 text-teal-700" />{notice}</div>}
        {error && <div role="alert" className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div>}
        {content.photos.length === 0 ? (
          <div className="mt-8 rounded-2xl border bg-white p-12 text-center"><ImageIcon className="mx-auto size-10 text-slate-300" /><h2 className="mt-4 font-semibold">Photos are not ready yet</h2><p className="mt-2 text-sm text-slate-500">Please check again later or contact the studio.</p><button onClick={() => void openGallery()} className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-teal-700"><RefreshCw className="size-4" />Refresh</button></div>
        ) : (
          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {content.photos.map((photo) => {
              const isSelected = selected.has(photo.id);
              return <button key={photo.id} type="button" onClick={() => togglePhoto(photo.id)} className={`group overflow-hidden rounded-2xl border bg-white text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${isSelected ? "border-teal-600 ring-2 ring-teal-200" : "border-slate-200"}`}>
                <div className="relative aspect-[4/5] bg-slate-100"><img src={photo.fileUrl} alt="Photo preview" className="h-full w-full object-cover" /><span className={`absolute right-3 top-3 flex size-8 items-center justify-center rounded-full border-2 ${isSelected ? "border-teal-600 bg-teal-600 text-white" : "border-white bg-white/80 text-transparent"}`}><Check className="size-4" /></span><span className="absolute bottom-3 left-3 rounded bg-black/55 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-white">Preview</span></div>
                <div className="flex items-center justify-between gap-3 p-4"><span className="truncate text-sm font-medium text-slate-700">{photo.fileName}</span><span className="shrink-0 text-xs font-semibold text-teal-700">{formatPrice(content.price.unitAmount, content.price.currency)}</span></div>
              </button>;
            })}
          </div>
        )}
        {paidPhotoIds.size > 0 && <section className="mt-10 rounded-2xl border border-teal-200 bg-teal-50 p-6"><div className="flex items-center gap-3"><Check className="size-5 text-teal-700" /><div><h2 className="font-semibold text-teal-950">Downloads ready</h2><p className="mt-1 text-sm text-teal-800">Payment has been confirmed. Download your original files below.</p></div></div><div className="mt-5 flex flex-wrap gap-3">{content.photos.filter((photo) => paidPhotoIds.has(photo.id)).map((photo) => <a key={photo.id} href={photo.downloadUrl} download={photo.fileName} className="inline-flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-teal-800 shadow-sm ring-1 ring-teal-200 hover:bg-teal-100"><Download className="size-4" />{photo.fileName}</a>)}</div></section>}
      </main>
      {content.photos.length > 0 && <div className="fixed inset-x-0 bottom-0 border-t bg-white/95 px-6 py-4 shadow-lg backdrop-blur"><div className="mx-auto flex max-w-6xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-semibold text-slate-900">{selected.size ? `${selected.size} photo${selected.size === 1 ? "" : "s"} selected` : "Select photos to order"}</p>{selected.size > 0 && <p className="text-sm text-slate-500">Total: {formatPrice(selectedTotal, content.price.currency)} · Secure checkout by Stripe</p>}</div><button onClick={() => void startCheckout()} disabled={checkoutLoading || selected.size === 0} className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-teal-700 px-5 text-sm font-semibold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50">{checkoutLoading ? <Loader2 className="size-4 animate-spin" /> : <ShoppingBag className="size-4" />}Order selected photos</button></div></div>}
    </div>
  );
}