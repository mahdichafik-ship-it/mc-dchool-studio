import React, { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { Check, Download, Image as ImageIcon, Loader2, LockKeyhole, RefreshCw, ShoppingBag, X } from "lucide-react";
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
  type DeliveryOrderInputDeliveryMethod,
  type DeliveryOrderInputPaymentMethod,
  type DeliveryBasketItem
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { deliveryLocales, formatDeliveryPrice, getStoredDeliveryLocale, translate, type DeliveryLocale, type DeliveryMessageKey } from "../lib/deliveryLocale";

// Local Basket Item representation
type LocalBasketItem = {
  id: string; // unique local ID
  offerId: string;
  photoIds: number[];
  quantity: number;
};

type DeliveryNotice =
  | { kind: "message"; key: DeliveryMessageKey }
  | { kind: "added"; offerName: string }
  | { kind: "order"; orderId: number; paymentInstructions?: string };

function getCommonMethods(basketItems: LocalBasketItem[], contentOffers: DeliveryOffer[]) {
  if (basketItems.length === 0) return { delivery: [] as string[], payment: [] as string[], currency: null as string | null };

  const firstOffer = contentOffers.find(o => o.id === basketItems[0].offerId);
  if (!firstOffer) return { delivery: [] as string[], payment: [] as string[], currency: null as string | null };

  let commonDelivery = [...firstOffer.deliveryMethods] as string[];
  let commonPayment = [...firstOffer.paymentMethods] as string[];
  const currency = firstOffer.currency;

  for (const item of basketItems) {
    const offer = contentOffers.find(o => o.id === item.offerId);
    if (offer) {
      commonDelivery = commonDelivery.filter(m => offer.deliveryMethods.includes(m as any));
      commonPayment = commonPayment.filter(m => offer.paymentMethods.includes(m as any));
    }
  }

  return { delivery: commonDelivery, payment: commonPayment, currency };
}

export default function Delivery() {
  const [match, params] = useRoute("/delivery/:slug");
  const slug = match ? params?.slug : undefined;
  
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [notice, setNotice] = useState<DeliveryNotice | null>(null);
  const [paidPhotoIds, setPaidPhotoIds] = useState<Set<number>>(new Set());
  const [orderIdToCheck, setOrderIdToCheck] = useState<number | null>(null);
  const [selectedOfferId, setSelectedOfferId] = useState<string>("");
  const [quantity, setQuantity] = useState(1);

  // Basket State
  const [basket, setBasket] = useState<LocalBasketItem[]>([]);
  const [viewingBasket, setViewingBasket] = useState(false);

  // Checkout Form State
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [deliveryMethod, setDeliveryMethod] = useState<DeliveryOrderInputDeliveryMethod>("digital");
  const [paymentMethod, setPaymentMethod] = useState<DeliveryOrderInputPaymentMethod>("establishment");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [locale, setLocale] = useState<DeliveryLocale>(getStoredDeliveryLocale);
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const formatPrice = (amount: number, currency: string) => formatDeliveryPrice(amount, currency, locale);
  const noticeText = notice?.kind === "message"
    ? t(notice.key)
    : notice?.kind === "added"
      ? `${notice.offerName} ${t("added")}`
      : notice?.kind === "order"
        ? `${t("orderReceived")} #${notice.orderId}. ${notice.paymentInstructions || t("paymentFallback")}`
        : null;

  function LanguageSelector() {
    return <label className="flex items-center gap-2 text-sm text-slate-500">
      <span className="sr-only">{t("card")}</span>
      <select aria-label={t("card")} value={locale} onChange={event => {
        const next = event.target.value as DeliveryLocale;
        setLocale(next);
        localStorage.setItem("delivery-locale", next);
        document.documentElement.lang = next;
      }} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-sm">
        {deliveryLocales.map(item => <option key={item} value={item}>{item.toUpperCase()}</option>)}
      </select>
    </label>;
  }

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const initialCode = query.get("code");
    if (initialCode) setCode(initialCode);
    
    if (query.get("paid") === "1") {
      setNotice({ kind: "message", key: "paymentReceived" });
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
    }
  }, [content?.offers, selectedOfferId]);

  const { data: orderData } = useGetDeliveryOrder(slug as string, orderIdToCheck as number, {
    query: {
      enabled: !!slug && !!token && !!orderIdToCheck,
      queryKey: getGetDeliveryOrderQueryKey(slug as string, orderIdToCheck as number),
      refetchInterval: (query) => {
        if (["paid", "cancelled", "refunded", "expired"].includes(query.state.data?.status || "")) return false;
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
          ? { kind: "message", key: "paidReady" }
          : { kind: "message", key: "paidPreparing" }
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
        setBasket([]);
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

  const { delivery: commonDelivery, payment: commonPayment, currency: basketCurrency } = getCommonMethods(basket, content?.offers || []);

  useEffect(() => {
    if (viewingBasket && basket.length > 0 && content) {
      if (!commonDelivery.includes(deliveryMethod as any)) {
        setDeliveryMethod(commonDelivery.includes("digital" as any) ? "digital" : commonDelivery[0] as any);
      }
      const availablePayments = commonPayment.filter(m => m !== "stripe" || content.stripeAvailable);
      if (!availablePayments.includes(paymentMethod as any)) {
        setPaymentMethod((availablePayments[0] || commonPayment[0]) as any);
      }
    }
  }, [viewingBasket, basket, commonDelivery, commonPayment, content?.stripeAvailable]);

  function canAddOffer(offer: DeliveryOffer) {
    if (basket.length === 0) return true;
    if (basketCurrency !== offer.currency) return false;
    
    const intersectionDelivery = commonDelivery.filter(m => offer.deliveryMethods.includes(m as any));
    const intersectionPayment = commonPayment.filter(m => offer.paymentMethods.includes(m as any));
    
    return intersectionDelivery.length > 0 && intersectionPayment.length > 0;
  }

  let requiredPhotoCount: number | null = null;
  let selectedTotal = 0;
  if (activeOffer) {
    if (activeOffer.productType === 'digital') {
      selectedTotal = activeOffer.unitAmount * selected.size;
    } else if (activeOffer.productType === 'print') {
      requiredPhotoCount = 1;
      selectedTotal = activeOffer.unitAmount * quantity;
    } else if (activeOffer.productType === 'pack') {
      requiredPhotoCount = activeOffer.photoCount * quantity;
      selectedTotal = activeOffer.unitAmount * quantity;
    }
  }

  const isValidSelection = requiredPhotoCount === null ? selected.size > 0 : selected.size === requiredPhotoCount;

  function addToBasket(e?: React.FormEvent) {
    e?.preventDefault();
    if (!activeOffer || !isValidSelection || !canAddOffer(activeOffer)) return;
    
    const newItem: LocalBasketItem = {
      id: crypto.randomUUID(),
      offerId: activeOffer.id,
      photoIds: Array.from(selected),
      quantity: activeOffer.productType === 'digital' ? selected.size : quantity
    };
    
    setBasket(prev => [...prev, newItem]);
    setSelected(new Set());
    setQuantity(1);
    setNotice({ kind: "added", offerName: activeOffer.name });
    setTimeout(() => setNotice(null), 3000);
  }

  function removeFromBasket(id: string) {
    setBasket(prev => prev.filter(item => item.id !== id));
  }

  function updateQuantityInBasket(id: string, newQuantity: number) {
    setBasket(prev => prev.map(item => item.id === id ? { ...item, quantity: Math.max(1, newQuantity) } : item));
  }

  const basketTotal = basket.reduce((sum, item) => {
    const offer = content?.offers?.find(o => o.id === item.offerId);
    if (!offer) return sum;
    return sum + (offer.productType === 'digital' ? offer.unitAmount * item.photoIds.length : offer.unitAmount * item.quantity);
  }, 0);

  function startCheckout(e: React.FormEvent) {
    e.preventDefault();
    if (!slug || !token || basket.length === 0) return;

    if (deliveryMethod === "shipping" && !deliveryAddress.trim()) {
      return;
    }
    
    const items: DeliveryBasketItem[] = basket.map(item => ({
      offerId: item.offerId,
      photoIds: item.photoIds,
      quantity: item.quantity
    }));

    createOrder.mutate({ 
      slug, 
      data: { 
        token, 
        items,
        customerName: customerName.trim(),
        customerEmail: customerEmail.trim() || undefined,
        paymentMethod,
        deliveryMethod,
        deliveryAddress: deliveryAddress.trim() || undefined
      } 
    }, {
      onSuccess: (res) => {
        if (res.checkoutUrl) {
          window.location.assign(res.checkoutUrl);
          return;
        }
        setOrderIdToCheck(res.orderId);
        setViewingBasket(false);
        setBasket([]);
        setNotice({ kind: "order", orderId: res.orderId, paymentInstructions: res.paymentInstructions || undefined });
      }
    });
  }

  if (galleryLoading) {
    return <div className="flex min-h-[100dvh] flex-col gap-4 items-center justify-center bg-slate-50 text-slate-500"><LanguageSelector /><div><Loader2 className="mr-2 size-4 animate-spin" />{t("loading")}</div></div>;
  }

  if (!gallery || galleryError) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-slate-50 p-6">
          <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
           <div className="mb-4 flex justify-end"><LanguageSelector /></div>
          <LockKeyhole className="mx-auto size-10 text-slate-400" />
           <h1 className="mt-4 text-xl font-semibold text-slate-900">{t("unavailable")}</h1>
           <p className="mt-2 text-sm text-slate-500">{t("unavailableText")}</p>
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
             <p className="font-semibold" style={{ color: "var(--delivery-primary)" }}>{(gallery as any).studio?.name || t("studio")}</p>
              {(gallery as any).studio?.tagline && <p className="text-sm text-slate-500">{(gallery as any).studio.tagline}</p>}
            </div>
             <div className="flex items-center gap-4"><LanguageSelector /><LockKeyhole className="size-5 text-slate-400" /></div>
          </div>
        </header>
        <main className="mx-auto flex max-w-md items-center px-6 py-20">
          <div className="w-full rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
             <h1 className="text-2xl font-bold tracking-tight">{t("privateGallery")}</h1>
             <p className="mt-2 text-sm leading-6 text-slate-500">{t("accessText")}</p>
            <form onSubmit={openGallery} className="mt-6 space-y-4">
              <label className="block text-sm font-medium text-slate-700">
                 {t("accessCode")}
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
                <p role="alert" className="text-sm text-red-700">{t("invalidCode")}</p>
              )}
              {contentIsError && (
                <p role="alert" className="text-sm text-red-700">{t("openError")}</p>
              )}
              
              <button 
                type="submit"
                data-testid="button-open-gallery"
                disabled={enterAccess.isPending || code.length !== 8} 
                className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-teal-700 px-4 text-sm font-semibold text-white transition-colors hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
                style={{ backgroundColor: "var(--delivery-primary)" }}
              >
                {enterAccess.isPending || contentLoading ? <Loader2 className="size-4 animate-spin" /> : <LockKeyhole className="size-4" />}
                 {t("openGallery")}
              </button>
            </form>
             <p className="mt-6 text-center text-xs text-slate-400">{t("contact")}</p>
          </div>
        </main>
      </div>
    );
  }

  if (viewingBasket) {
    const availablePayments = commonPayment.filter(m => m !== "stripe" || content.stripeAvailable);
    const checkoutUnavailable = commonDelivery.length === 0 || availablePayments.length === 0;
    
    return (
      <div style={brandStyle} className="min-h-[100dvh] bg-slate-50 text-slate-900 pb-32">
        <header className="border-b border-slate-200 bg-white sticky top-0 z-10 shadow-sm">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
             <h1 className="text-xl font-bold">{t("checkout")}</h1>
             <LanguageSelector />
            <button 
              type="button"
              onClick={() => setViewingBasket(false)} 
              className="flex items-center gap-1.5 text-sm font-medium text-slate-500 transition-colors hover:text-slate-900"
            >
               <X className="size-4" /> {t("back")}
            </button>
          </div>
        </header>

        <main className="mx-auto max-w-5xl px-6 py-10">
          {basket.length === 0 ? (
            <div className="text-center py-20 rounded-2xl border border-slate-200 bg-white p-12">
              <ShoppingBag className="mx-auto size-12 text-slate-300" />
               <h2 className="mt-4 text-lg font-semibold text-slate-900">{t("empty")}</h2>
              <button 
                onClick={() => setViewingBasket(false)}
                className="mt-6 rounded-lg bg-slate-900 px-6 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
              >
                 {t("returnGallery")}
              </button>
            </div>
          ) : (
            <div className="grid gap-10 md:grid-cols-12">
              <div className="md:col-span-7 space-y-6">
                 <h2 className="text-lg font-semibold text-slate-900">{t("basket")}</h2>
                <div className="space-y-4">
                  {basket.map((item) => {
                    const offer = content.offers.find(o => o.id === item.offerId);
                    if (!offer) return null;
                    const lineTotal = offer.productType === 'digital' ? offer.unitAmount * item.photoIds.length : offer.unitAmount * item.quantity;
                    
                    return (
                      <div key={item.id} className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                        <div className="flex justify-between items-start gap-4">
                          <div>
                            <h3 className="font-semibold text-slate-900">{offer.name}</h3>
                            <p className="text-sm text-slate-500 mt-1">
                               {item.photoIds.length} {t("selected")}
                            </p>
                          </div>
                          <div className="text-right">
                            <span className="font-bold text-slate-900">{formatPrice(lineTotal, offer.currency)}</span>
                          </div>
                        </div>

                        <div className="flex items-center justify-between border-t border-slate-100 pt-4">
                          {offer.productType === 'print' ? (
                            <div className="flex items-center gap-3">
                               <label className="text-sm font-medium text-slate-700">{t("qty")}</label>
                              <div className="flex items-center rounded-lg border border-slate-200 bg-slate-50">
                                <button type="button" onClick={() => updateQuantityInBasket(item.id, item.quantity - 1)} className="px-3 py-1 text-slate-500 hover:bg-slate-100">-</button>
                                <span className="px-3 text-sm font-medium">{item.quantity}</span>
                                <button type="button" onClick={() => updateQuantityInBasket(item.id, item.quantity + 1)} className="px-3 py-1 text-slate-500 hover:bg-slate-100">+</button>
                              </div>
                            </div>
                          ) : offer.productType === 'pack' ? (
                             <span className="text-xs font-medium text-slate-500 uppercase tracking-wider">{t("qty")} {item.quantity} (Pack)</span>
                          ) : (
                             <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">{t("digitalDelivery")}</span>
                          )}
                          <button type="button" onClick={() => removeFromBasket(item.id)} className="text-sm font-medium text-red-600 hover:text-red-700 transition-colors">
                             {t("remove")}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="md:col-span-5">
                <form onSubmit={startCheckout} className="sticky top-24 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
                   <h2 className="text-lg font-semibold text-slate-900 mb-6">{t("deliveryPayment")}</h2>
                  
                  <div className="space-y-5">
                    <div className="space-y-1.5">
                       <label className="text-sm font-medium text-slate-700">{t("name")}</label>
                      <input
                        required
                        type="text"
                        value={customerName}
                        onChange={e => setCustomerName(e.target.value)}
                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
                         placeholder={{ fr: "Marie Dupont", en: "Jane Doe", sv: "Anna Andersson", es: "Ana García" }[locale]}
                      />
                    </div>

                    <div className="space-y-1.5">
                        <label className="text-sm font-medium text-slate-700">
                           {t("email")} {paymentMethod === "stripe" ? "*" : ""}
                        </label>
                      <input
                        type="email"
                          required={paymentMethod === "stripe"}
                        value={customerEmail}
                        onChange={e => setCustomerEmail(e.target.value)}
                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
                         placeholder={{ fr: "vous@exemple.com", en: "you@example.com", sv: "du@exempel.se", es: "tu@ejemplo.com" }[locale]}
                      />
                    </div>
                    
                    <div className="space-y-1.5">
                       <label className="text-sm font-medium text-slate-700">{t("deliveryMethod")}</label>
                      <select
                        required
                        value={deliveryMethod}
                        onChange={e => setDeliveryMethod(e.target.value as any)}
                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm capitalize focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
                      >
                        {commonDelivery.map(m => (
                           <option key={m} value={m} className="capitalize">{m === "digital" ? t("digitalDelivery") : m === "shipping" ? ({ fr: "Expédition", en: "Shipping", sv: "Frakt", es: "Envío" }[locale]) : m}</option>
                        ))}
                      </select>
                    </div>
                    {checkoutUnavailable && (
                      <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                         {t("checkoutUnavailable")}
                      </div>
                    )}

                    {deliveryMethod === 'shipping' && (
                      <div className="space-y-1.5">
                         <label className="text-sm font-medium text-slate-700">{t("address")}</label>
                        <textarea
                          required
                          rows={2}
                          value={deliveryAddress}
                          onChange={e => setDeliveryAddress(e.target.value)}
                          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
                           placeholder={{ fr: "12 rue principale, ville, code postal", en: "123 Main St, City, State, ZIP", sv: "Huvudgatan 12, stad, postnummer", es: "Calle Principal 123, ciudad, código postal" }[locale]}
                        />
                      </div>
                    )}

                    <div className="space-y-1.5">
                       <label className="text-sm font-medium text-slate-700">{t("paymentMethod")}</label>
                      <select
                        required
                        value={paymentMethod}
                        onChange={e => setPaymentMethod(e.target.value as any)}
                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
                      >
                        {availablePayments.map(method => (
                          <option key={method} value={method}>
                            {method === "stripe"
                               ? t("payStripe")
                               : method === "establishment" ? t("payEstablishment") : t("payBank")}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="mt-8 border-t border-slate-100 pt-6">
                    <div className="flex items-center justify-between mb-6">
                       <span className="text-base font-semibold text-slate-900">{t("total")}</span>
                      <span className="text-xl font-bold text-slate-900">{formatPrice(basketTotal, basketCurrency || 'USD')}</span>
                    </div>
                    
                    {createOrder.isError && (
                      <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 border border-red-200">
                         {t("orderError")}
                      </div>
                    )}

                    <button 
                      type="submit"
                      disabled={createOrder.isPending || checkoutUnavailable || (paymentMethod === "stripe" && !customerEmail.trim()) || (deliveryMethod === 'shipping' && !deliveryAddress.trim())} 
                      className="flex w-full items-center justify-center gap-2 rounded-lg bg-teal-700 px-6 py-3.5 text-sm font-semibold text-white shadow-sm transition-all hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
                      style={{ backgroundColor: "var(--delivery-primary)" }}
                    >
                      {createOrder.isPending ? <Loader2 className="size-4 animate-spin" /> : <LockKeyhole className="size-4" />}
                       {t("placeOrder")}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </main>
      </div>
    );
  }

  const offers = content.offers || [];
  const deliveryContent = content as typeof content & {
    gallery?: { projectType?: string; subjectLabel?: string; groupLabel?: string };
    subject?: { displayName?: string; label?: string; departmentName?: string | null };
  };
  const subject: {
    displayName?: string;
    label?: string;
    departmentName?: string | null;
    companyName?: string | null;
    firstName?: string;
    lastName?: string;
  } = (deliveryContent.subject as {
    displayName?: string;
    label?: string;
    departmentName?: string | null;
    companyName?: string | null;
    firstName?: string;
    lastName?: string;
  } | undefined) ?? (content.student as { firstName?: string; lastName?: string });
  const subjectLabel = subject.label
    ?? deliveryContent.gallery?.subjectLabel
    ?? "Student";
  const subjectName = deliveryContent.subject?.displayName
    ?? `${subject?.firstName ?? ""} ${subject?.lastName ?? ""}`.trim();
  const isCorporate = deliveryContent.gallery?.projectType === "corporate";

  return (
    <div style={brandStyle} className="min-h-[100dvh] bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <div>
            <p className="font-semibold" style={{ color: "var(--delivery-primary)" }}>{(gallery as any).studio?.name || t("studio")}</p>
            {(gallery as any).studio?.tagline && <p className="text-sm text-slate-500">{(gallery as any).studio.tagline}</p>}
          </div>
          <LanguageSelector />
          <button 
            onClick={() => { setToken(null); setCode(""); setBasket([]); setSelected(new Set()); }} 
            className="text-sm font-medium text-slate-500 transition-colors hover:text-slate-900"
          >
            {t("anotherCode")}
          </button>
        </div>
      </header>
      
      <main className="mx-auto max-w-6xl px-6 py-10 pb-40">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-medium text-slate-500">{subjectLabel} {t("privateDelivery")}</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">
              {subjectName}
            </h1>
            {isCorporate && subject?.companyName && (
              <p className="mt-1 text-sm text-slate-500">{subject.companyName}</p>
            )}
            {isCorporate && subject.departmentName && (
              <p className="mt-1 text-sm text-slate-500">
                {deliveryContent.gallery?.groupLabel ?? "Department"}: {subject.departmentName}
              </p>
            )}
          </div>
          <p className="text-sm text-slate-500">
            {content.photos.length} {content.photos.length === 1 ? t("preview") : t("previews")}
          </p>
        </div>

        {offers.length > 0 && (
          <div className="mt-8 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <label className="text-base font-semibold text-slate-900">{t("chooseProduct")}</label>
            <div className="mt-4 flex flex-wrap gap-2">
              {offers.map(offer => (
                <button
                  key={offer.id}
                  data-testid={`button-select-offer-${offer.id}`}
                  onClick={() => {
                    setSelectedOfferId(offer.id);
                    setSelected(new Set());
                    setQuantity(1);
                  }}
                  className={`rounded-lg border px-5 py-2.5 text-sm font-medium transition-all ${
                    selectedOfferId === offer.id
                      ? "border-teal-600 bg-teal-50 text-teal-800 shadow-sm"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {offer.name}
                </button>
              ))}
            </div>
            {activeOffer && (
              <div className="mt-5 space-y-4 border-t border-slate-100 pt-5">
                <p className="text-sm text-slate-600">
                  <span className="font-medium text-slate-900">{formatPrice(activeOffer.unitAmount, activeOffer.currency)}</span>
                  <span className="mx-2 text-slate-300">|</span>
                  {activeOffer.description}
                  {activeOffer.printSize ? ` · ${activeOffer.printSize}` : ""}
                  {activeOffer.productType === 'digital' 
                    ? ` · ${t("perPhoto")}`
                    : activeOffer.productType === 'print'
                      ? ` · ${t("selectOne")}`
                      : ` · ${t("selectOne").replace("1", String(activeOffer.photoCount))} ${t("perPack")}`}
                </p>

                {activeOffer.productType !== 'digital' && (
                  <div className="flex items-center gap-3">
                    <label className="text-sm font-medium text-slate-700">{t("quantity")}</label>
                    <div className="flex items-center rounded-lg border border-slate-200 bg-slate-50">
                      <button type="button" onClick={() => setQuantity(Math.max(1, quantity - 1))} className="px-3 py-1.5 text-slate-500 hover:bg-slate-100">-</button>
                      <span className="px-3 text-sm font-medium">{quantity}</span>
                      <button type="button" onClick={() => setQuantity(quantity + 1)} className="px-3 py-1.5 text-slate-500 hover:bg-slate-100">+</button>
                    </div>
                  </div>
                )}

                {!canAddOffer(activeOffer) && (
                  <p className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 border border-amber-200">
                    {t("cannotCombine")}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
        
        {notice && (
          <div className="mt-6 flex items-start gap-3 rounded-xl border border-teal-200 bg-teal-50 p-4 text-sm text-teal-900 shadow-sm animate-in fade-in zoom-in duration-300">
            <Check className="mt-0.5 size-4 shrink-0 text-teal-700" />
            {noticeText}
          </div>
        )}

        {content.orderingAvailable === false && (
          <div role="status" className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            {t("accessAvailable")}
          </div>
        )}
        
        {content.photos.length === 0 ? (
          <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-12 text-center">
            <ImageIcon className="mx-auto size-10 text-slate-300" />
            <h2 className="mt-4 font-semibold text-slate-900">{t("notReady")}</h2>
            <p className="mt-2 text-sm text-slate-500">{t("checkLater")}</p>
            <button 
              onClick={() => refetchContent()} 
              className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-teal-700 transition-colors hover:text-teal-800"
            >
              <RefreshCw className="size-4" /> {t("refresh")}
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
              alt={t("photoPreview")}
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
                        {t("purchased")}
                      </span>
                    )}
                    
                    <span className="absolute bottom-3 left-3 rounded bg-black/50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-white backdrop-blur-sm">
                      {t("preview")}
                    </span>
                  </div>
                  
                  <div className="flex items-center justify-between gap-3 p-4">
                    <span className="truncate text-sm font-medium text-slate-700" title={photo.fileName}>
                      {photo.fileName}
                    </span>
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
                <h2 className="font-semibold text-teal-950">{t("success")}</h2>
                <p className="mt-1 text-sm text-teal-800">
                  {orderData?.downloadablePhotoIds?.length
                     ? t("downloadsReady")
                     : t("processing")}
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
                      {t("download")} {photo.fileName}
                    </a>
                ))}
              </div>
            )}
          </section>
        )}
      </main>
      
      {(selected.size > 0 || basket.length > 0) && (
        <div className="fixed inset-x-0 bottom-0 animate-in slide-in-from-bottom-4 border-t border-slate-200 bg-white/95 px-6 py-4 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] backdrop-blur-sm z-50">
          <div className="mx-auto flex max-w-6xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              {selected.size > 0 ? (
                <>
                  <p className="font-semibold text-slate-900">
                    {requiredPhotoCount === null 
                      ? `${selected.size} ${t("selected")}`
                      : `${selected.size} of ${requiredPhotoCount} ${t("selected")}`}
                  </p>
                  {activeOffer && activeOffer.unitAmount > 0 && (
                    <p className="mt-0.5 text-sm font-medium text-slate-500">
                      {t("current")}: {formatPrice(selectedTotal, activeOffer.currency)}
                    </p>
                  )}
                </>
              ) : (
                <>
                  <p className="font-semibold text-slate-900">
                    {basket.length} {t("item")}
                  </p>
                  <p className="mt-0.5 text-sm font-medium text-slate-500">
                    {t("basketTotal")}: {formatPrice(basketTotal, basketCurrency || 'USD')}
                  </p>
                </>
              )}
            </div>
            
            <div className="flex flex-col sm:flex-row gap-3">
              {selected.size > 0 && (
                <button 
                  onClick={addToBasket} 
                  disabled={!isValidSelection || (activeOffer && !canAddOffer(activeOffer))} 
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-teal-50 px-6 text-sm font-semibold text-teal-800 shadow-sm transition-colors hover:bg-teal-100 disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ color: "var(--delivery-primary)" }}
                >
                  {t("add")}
                </button>
              )}
              {basket.length > 0 && (
                <button 
                  onClick={() => {
                    if (selected.size > 0 && isValidSelection && activeOffer && canAddOffer(activeOffer)) {
                      addToBasket();
                    }
                    setViewingBasket(true);
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }} 
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-teal-700 px-6 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-teal-800"
                  style={{ backgroundColor: "var(--delivery-primary)" }}
                >
                  <ShoppingBag className="size-4" />
                  {t("checkout")} ({basket.length + (selected.size > 0 && isValidSelection && activeOffer && canAddOffer(activeOffer) ? 1 : 0)})
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
