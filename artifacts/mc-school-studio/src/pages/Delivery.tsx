import React, { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { Check, Download, Image as ImageIcon, Loader2, LockKeyhole, RefreshCw, ShoppingBag } from "lucide-react";
import { 
  useGetDeliveryGallery,
  useEnterDeliveryAccess,
  useGetDeliveryPhotos,
  useCreateDeliveryOrder,
  useGetDeliveryOrder,
  getGetDeliveryPhotosQueryKey,
  getGetDeliveryGalleryQueryKey,
  getGetDeliveryOrderQueryKey,
  type DeliveryOffer,
  type DeliveryOrderInputDeliveryMethod
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

function formatPrice(amount: number, currency: string) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(amount / 100);
}

export default function Delivery() {
  const [match, params] = useRoute("/delivery/:slug");
  const slug = match ? params?.slug : undefined;
  
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [paidPhotoIds, setPaidPhotoIds] = useState<Set<number>>(new Set());
  const [orderIdToCheck, setOrderIdToCheck] = useState<number | null>(null);
  const [selectedOfferId, setSelectedOfferId] = useState<string>("");
  const [showCheckoutForm, setShowCheckoutForm] = useState(false);

  // Form states for checkout
  const [customerName, setCustomerName] = useState("");
  const [deliveryMethod, setDeliveryMethod] = useState<DeliveryOrderInputDeliveryMethod>("digital");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [quantity, setQuantity] = useState(1);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const initialCode = query.get("code");
    if (initialCode) setCode(initialCode);
    
    if (query.get("paid") === "1") {
      setNotice("Payment received. We are confirming your order and preparing your downloads.");
    }
    
    const orderParam = query.get("order");
    if (orderParam) {
      setOrderIdToCheck(Number(orderParam));
    }
  }, []);

  const { data: gallery, isLoading: galleryLoading, error: galleryError } = useGetDeliveryGallery(slug as string, {
    query: { enabled: !!slug, queryKey: getGetDeliveryGalleryQueryKey(slug as string) }
  });

  const enterAccess = useEnterDeliveryAccess();
  const createOrder = useCreateDeliveryOrder();

  const { data: content, isLoading: contentLoading, isError: contentIsError, error: contentError, refetch: refetchContent } = useGetDeliveryPhotos(slug as string, {
    query: { 
      enabled: !!slug && !!token,
      queryKey: [...getGetDeliveryPhotosQueryKey(slug as string), token] as any
    },
    request: { headers: { 'x-delivery-token': token as string } }
  });

  useEffect(() => {
    if (content?.offers && content.offers.length > 0 && !selectedOfferId) {
      setSelectedOfferId(content.offers[0].id);
      // Auto-select digital delivery if available
      const method = content.offers[0].deliveryMethods.includes("digital" as any) 
        ? "digital" 
        : content.offers[0].deliveryMethods[0];
      setDeliveryMethod(method as any);
    }
  }, [content?.offers, selectedOfferId]);

  const { data: orderData } = useGetDeliveryOrder(slug as string, orderIdToCheck as number, {
    query: {
      enabled: !!slug && !!token && !!orderIdToCheck,
      queryKey: getGetDeliveryOrderQueryKey(slug as string, orderIdToCheck as number),
      refetchInterval: (query) => {
        if (query.state.data?.status === "paid") return false;
        return 2500; // Poll every 2.5s until paid
      }
    },
    request: { headers: { 'x-delivery-token': token as string } }
  });

  useEffect(() => {
    if (orderData?.status === "paid") {
      setPaidPhotoIds(new Set(orderData.downloadablePhotoIds ?? []));
      
      const hasDownloads = orderData.downloadablePhotoIds && orderData.downloadablePhotoIds.length > 0;
      setNotice(
        hasDownloads 
          ? "Payment confirmed. Your paid photos are ready to download."
          : "Payment confirmed. We are preparing your order."
      );
    }
  }, [orderData]);

  async function openGallery(event?: React.FormEvent) {
    event?.preventDefault();
    if (!slug) return;
    
    enterAccess.mutate({ slug, data: { code } }, {
      onSuccess: (res) => {
        setToken(res.token);
        setSelected(new Set());
      }
    });
  }

  const activeOffer = content?.offers?.find(o => o.id === selectedOfferId) || content?.offers?.[0];

  function togglePhoto(photoId: number) {
    if (!activeOffer) return;
    
    let limit: number | null = null;
    if (activeOffer.productType === 'print') limit = 1;
    else if (activeOffer.productType === 'pack') limit = activeOffer.photoCount * quantity;

    setSelected((current) => {
      const next = new Set(current);
      if (next.has(photoId)) {
        next.delete(photoId);
      } else {
        if (limit === null) {
          next.add(photoId);
        } else if (limit === 1 && next.size === 1) {
          next.clear();
          next.add(photoId);
        } else if (next.size < limit) {
          next.add(photoId);
        }
      }
      return next;
    });
  }

  function startCheckout(e: React.FormEvent) {
    e.preventDefault();
    if (!slug || !token || selected.size === 0 || !activeOffer) return;
    
    let limit: number | null = null;
    if (activeOffer.productType === 'print') limit = 1;
    else if (activeOffer.productType === 'pack') limit = activeOffer.photoCount * quantity;

    if (limit !== null && selected.size !== limit) {
      alert(`Please select exactly ${limit} photo${limit === 1 ? '' : 's'} for this offer.`);
      return;
    }

    if (activeOffer.deliveryMethods.includes("shipping" as any) && deliveryMethod === "shipping" && !deliveryAddress.trim()) {
      return;
    }
    
    createOrder.mutate({ 
      slug, 
      data: { 
        token, 
        offerId: activeOffer.id,
        photoIds: Array.from(selected),
        quantity: activeOffer.productType === 'digital' ? 1 : quantity,
        customerName: customerName.trim() || undefined,
        deliveryMethod,
        deliveryAddress: deliveryAddress.trim() || undefined
      } 
    }, {
      onSuccess: (res) => {
        if (res.checkoutUrl) {
          window.location.assign(res.checkoutUrl);
        }
      }
    });
  }

  if (galleryLoading) {
    return <div className="flex min-h-[100dvh] items-center justify-center bg-slate-50 text-slate-500"><Loader2 className="mr-2 size-4 animate-spin" />Loading gallery…</div>;
  }

  if (!gallery || galleryError) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-slate-50 p-6">
        <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <LockKeyhole className="mx-auto size-10 text-slate-400" />
          <h1 className="mt-4 text-xl font-semibold text-slate-900">Delivery unavailable</h1>
          <p className="mt-2 text-sm text-slate-500">This gallery could not be found or is no longer active.</p>
        </div>
      </div>
    );
  }

  const brandStyle = { 
    "--delivery-primary": (gallery as any).studio?.primaryColor || "#0F766E", 
    "--delivery-accent": (gallery as any).studio?.accentColor || "#14B8A6" 
  } as React.CSSProperties;

  if (!token || !content) {
    return (
      <div style={brandStyle} className="min-h-[100dvh] bg-slate-50 text-slate-900">
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
            <div>
              <p className="font-semibold" style={{ color: "var(--delivery-primary)" }}>{(gallery as any).studio?.name || "Studio"}</p>
              {(gallery as any).studio?.tagline && <p className="text-sm text-slate-500">{(gallery as any).studio.tagline}</p>}
            </div>
            <LockKeyhole className="size-5 text-slate-400" />
          </div>
        </header>
        <main className="mx-auto flex max-w-md items-center px-6 py-20">
          <div className="w-full rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
            <h1 className="text-2xl font-bold tracking-tight">Your private gallery</h1>
            <p className="mt-2 text-sm leading-6 text-slate-500">Enter the access code from your photo card to view previews and order digital photos.</p>
            <form onSubmit={openGallery} className="mt-6 space-y-4">
              <label className="block text-sm font-medium text-slate-700">
                Access code
                <input 
                  autoFocus 
                  value={code} 
                  onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))} 
                  placeholder="ABCD2345" 
                  maxLength={8} 
                  data-testid="input-access-code"
                  className="mt-2 h-12 w-full rounded-lg border border-slate-300 px-4 text-center font-mono text-lg tracking-[0.25em] outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-100" 
                />
              </label>
              
              {enterAccess.isError && (
                <p role="alert" className="text-sm text-red-700">That access code is not valid.</p>
              )}
              {contentIsError && (
                <p role="alert" className="text-sm text-red-700">The gallery could not be opened. Please try again.</p>
              )}
              
              <button 
                type="submit"
                data-testid="button-open-gallery"
                disabled={enterAccess.isPending || code.length !== 8} 
                className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-teal-700 px-4 text-sm font-semibold text-white transition-colors hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
                style={{ backgroundColor: "var(--delivery-primary)" }}
              >
                {enterAccess.isPending || contentLoading ? <Loader2 className="size-4 animate-spin" /> : <LockKeyhole className="size-4" />}
                Open gallery
              </button>
            </form>
            <p className="mt-6 text-center text-xs text-slate-400">If you cannot find your code, please contact the photography studio.</p>
          </div>
        </main>
      </div>
    );
  }

  // Once authenticated and content is loaded
  const offers = content.offers || [];
  
  const unitAmount = activeOffer?.unitAmount || 0;
  const currency = activeOffer?.currency || "USD";
  
  let requiredPhotoCount: number | null = null;
  let selectedTotal = 0;
  if (activeOffer) {
    if (activeOffer.productType === 'digital') {
      selectedTotal = unitAmount * selected.size;
    } else if (activeOffer.productType === 'print') {
      requiredPhotoCount = 1;
      selectedTotal = unitAmount * quantity;
    } else if (activeOffer.productType === 'pack') {
      requiredPhotoCount = activeOffer.photoCount * quantity;
      selectedTotal = unitAmount * quantity;
    }
  }

  const isValidSelection = requiredPhotoCount === null ? selected.size > 0 : selected.size === requiredPhotoCount;

  return (
    <div style={brandStyle} className="min-h-[100dvh] bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <div>
            <p className="font-semibold" style={{ color: "var(--delivery-primary)" }}>{(gallery as any).studio?.name || "Studio"}</p>
            {(gallery as any).studio?.tagline && <p className="text-sm text-slate-500">{(gallery as any).studio.tagline}</p>}
          </div>
          <button 
            onClick={() => { setToken(null); setCode(""); }} 
            className="text-sm font-medium text-slate-500 transition-colors hover:text-slate-900"
          >
            Use another code
          </button>
        </div>
      </header>
      
      <main className="mx-auto max-w-6xl px-6 py-10 pb-32">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-medium text-slate-500">Private delivery</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">
              {(content.student as any)?.firstName} {(content.student as any)?.lastName}
            </h1>
          </div>
          <p className="text-sm text-slate-500">
            {content.photos.length} preview{content.photos.length === 1 ? "" : "s"}
          </p>
        </div>

        {offers.length > 0 && (
          <div className="mt-6">
            <label className="text-sm font-medium text-slate-700">Choose an offer</label>
            <div className="mt-2 flex flex-wrap gap-2">
              {offers.map(offer => (
                <button
                  key={offer.id}
                  data-testid={`button-select-offer-${offer.id}`}
                  onClick={() => {
                    setSelectedOfferId(offer.id);
                    setSelected(new Set());
                    setQuantity(1);
                    if (!offer.deliveryMethods.includes(deliveryMethod)) {
                      setDeliveryMethod(offer.deliveryMethods.includes("digital" as any) ? "digital" : offer.deliveryMethods[0] as any);
                    }
                  }}
                  className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                    selectedOfferId === offer.id
                      ? "border-teal-600 bg-teal-50 text-teal-800"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {offer.name}
                </button>
              ))}
            </div>
            {activeOffer && (
              <p className="mt-2 text-sm text-slate-500">
                {activeOffer.description}
                {activeOffer.printSize ? ` · ${activeOffer.printSize}` : ""}
                {activeOffer.productType === 'digital' 
                  ? " · 1 unit per selected photo"
                  : activeOffer.productType === 'print'
                    ? " · Select 1 photo"
                    : ` · Select ${activeOffer.photoCount} photo${activeOffer.photoCount === 1 ? "" : "s"} per pack`}
              </p>
            )}
          </div>
        )}
        
        {notice && (
          <div className="mt-6 flex items-start gap-3 rounded-xl border border-teal-200 bg-teal-50 p-4 text-sm text-teal-900">
            <Check className="mt-0.5 size-4 shrink-0 text-teal-700" />
            {notice}
          </div>
        )}
        
        {createOrder.isError && (
          <div role="alert" className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            Checkout is not available right now. Please try again.
          </div>
        )}
        
        {content.photos.length === 0 ? (
          <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-12 text-center">
            <ImageIcon className="mx-auto size-10 text-slate-300" />
            <h2 className="mt-4 font-semibold text-slate-900">Photos are not ready yet</h2>
            <p className="mt-2 text-sm text-slate-500">Please check again later or contact the studio.</p>
            <button 
              onClick={() => refetchContent()} 
              className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-teal-700 transition-colors hover:text-teal-800"
            >
              <RefreshCw className="size-4" /> Refresh
            </button>
          </div>
        ) : (
          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {content.photos.map((photo) => {
              const isSelected = selected.has(photo.id as number);
              const isPaid = paidPhotoIds.has(photo.id as number);
              
              return (
                <button 
                  key={photo.id} 
                  type="button" 
                  data-testid={`button-toggle-photo-${photo.id}`}
                  onClick={() => !isPaid && togglePhoto(photo.id as number)} 
                  disabled={isPaid}
                  className={`group relative overflow-hidden rounded-2xl border bg-white text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md ${
                    isSelected ? "border-teal-600 ring-2 ring-teal-200" : "border-slate-200"
                  } ${isPaid ? "cursor-default border-green-200 bg-green-50/30" : ""}`}
                >
                  <div className="relative aspect-[4/5] bg-slate-100">
                    <img 
                      src={photo.fileUrl} 
                      alt="Photo preview" 
                      className="h-full w-full object-cover" 
                      loading="lazy"
                    />
                    
                    {!isPaid && (
                      <span className={`absolute right-3 top-3 flex size-8 items-center justify-center rounded-full border-2 transition-colors ${
                        isSelected 
                          ? "border-teal-600 bg-teal-600 text-white" 
                          : "border-white/80 bg-white/40 text-transparent group-hover:bg-white/60"
                      }`}>
                        <Check className="size-4" />
                      </span>
                    )}
                    
                    {isPaid && (
                      <span className="absolute right-3 top-3 flex items-center gap-1.5 rounded-full bg-green-600 px-2.5 py-1 text-xs font-bold text-white shadow-sm">
                        <Check className="size-3" />
                        Purchased
                      </span>
                    )}
                    
                    <span className="absolute bottom-3 left-3 rounded bg-black/50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-white backdrop-blur-sm">
                      Preview
                    </span>
                  </div>
                  
                  <div className="flex items-center justify-between gap-3 p-4">
                    <span className="truncate text-sm font-medium text-slate-700" title={photo.fileName}>
                      {photo.fileName}
                    </span>
                    {!isPaid && unitAmount > 0 && (
                      <span className="shrink-0 text-xs font-bold text-teal-700">
                        {formatPrice(unitAmount, currency)}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
        
        {paidPhotoIds.size > 0 && (
          <section className="mt-12 rounded-2xl border border-teal-200 bg-teal-50/50 p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-teal-100">
                <Check className="size-5 text-teal-700" />
              </div>
              <div>
                <h2 className="font-semibold text-teal-950">Order Successful</h2>
                <p className="mt-1 text-sm text-teal-800">
                  {orderData?.downloadablePhotoIds?.length
                    ? "Your purchased photos are available to download below." 
                    : "Your order has been received and will be processed soon."}
                </p>
              </div>
            </div>
            {(orderData?.downloadablePhotoIds?.length ?? 0) > 0 && (
              <div className="mt-6 flex flex-wrap gap-3">
                {content.photos
                  .filter((photo) => paidPhotoIds.has(photo.id as number))
                  .map((photo) => (
                    <a 
                      key={photo.id} 
                      href={photo.downloadUrl} 
                      download={photo.fileName} 
                      data-testid={`link-download-${photo.id}`}
                      className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-teal-800 shadow-sm ring-1 ring-teal-200 transition-colors hover:bg-teal-50"
                    >
                      <Download className="size-4" />
                      Download {photo.fileName}
                    </a>
                ))}
              </div>
            )}
          </section>
        )}
      </main>
      
      {content.photos.length > 0 && selected.size > 0 && activeOffer && (
        <div className="fixed inset-x-0 bottom-0 animate-in slide-in-from-bottom-4 border-t border-slate-200 bg-white/95 px-6 py-4 shadow-lg backdrop-blur-sm">
          {!showCheckoutForm ? (
            <div className="mx-auto flex max-w-6xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-semibold text-slate-900">
                  {requiredPhotoCount === null 
                    ? `${selected.size} photo${selected.size === 1 ? "" : "s"} selected`
                    : `${selected.size} of ${requiredPhotoCount} photo${requiredPhotoCount === 1 ? "" : "s"} selected`}
                </p>
                {unitAmount > 0 && (
                  <p className="mt-0.5 text-sm font-medium text-slate-500">
                    Total: {formatPrice(selectedTotal, currency)}
                  </p>
                )}
              </div>
              <button 
                onClick={() => setShowCheckoutForm(true)} 
                disabled={!isValidSelection} 
                className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-teal-700 px-6 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
                style={{ backgroundColor: "var(--delivery-primary)" }}
              >
                Continue to Checkout
              </button>
            </div>
          ) : (
            <form onSubmit={startCheckout} className="mx-auto max-w-6xl space-y-4">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                <h3 className="font-semibold text-slate-900">Checkout Details</h3>
                <button type="button" onClick={() => setShowCheckoutForm(false)} className="text-sm text-slate-500 hover:text-slate-900">Cancel</button>
              </div>
              
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-500">Your Name *</label>
                  <input
                    required
                    type="text"
                    value={customerName}
                    onChange={e => setCustomerName(e.target.value)}
                    className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-teal-500 focus:outline-none"
                    placeholder="Jane Doe"
                  />
                </div>
                
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-500">Delivery Method *</label>
                  <select
                    required
                    value={deliveryMethod}
                    onChange={e => setDeliveryMethod(e.target.value as any)}
                    className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-teal-500 focus:outline-none"
                  >
                    {activeOffer.deliveryMethods.map(m => (
                      <option key={m} value={m} className="capitalize">{m}</option>
                    ))}
                  </select>
                </div>
                
                {activeOffer.productType !== 'digital' && (
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-500">Quantity *</label>
                    <input
                      required
                      type="number"
                      min={1}
                      value={quantity}
                      onChange={e => setQuantity(parseInt(e.target.value, 10) || 1)}
                      className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-teal-500 focus:outline-none"
                    />
                  </div>
                )}
                
                {deliveryMethod === 'shipping' && (
                  <div className="space-y-1 sm:col-span-2 lg:col-span-4">
                    <label className="text-xs font-medium text-slate-500">Shipping Address *</label>
                    <textarea
                      required
                      rows={2}
                      value={deliveryAddress}
                      onChange={e => setDeliveryAddress(e.target.value)}
                      className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-teal-500 focus:outline-none"
                      placeholder="123 Main St, City, State, ZIP"
                    />
                  </div>
                )}
              </div>
              
              <div className="flex items-center justify-between pt-2">
                <div>
                  {unitAmount > 0 && (
                    <p className="font-semibold text-slate-900">
                      Total: {formatPrice(selectedTotal, currency)}
                    </p>
                  )}
                </div>
                <button 
                  type="submit"
                  disabled={createOrder.isPending || !isValidSelection || (deliveryMethod === 'shipping' && !deliveryAddress.trim())} 
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-teal-700 px-6 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ backgroundColor: "var(--delivery-primary)" }}
                >
                  {createOrder.isPending ? <Loader2 className="size-4 animate-spin" /> : <ShoppingBag className="size-4" />}
                  Place Order
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
