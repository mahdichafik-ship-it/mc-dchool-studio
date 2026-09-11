import React, { useState, useEffect } from "react";
import { 
  Check, Copy, Download, ExternalLink, Loader2, LockKeyhole, 
  Printer, QrCode, Send, Settings, ShoppingBag, Search, Ban, Play, Image as ImageIcon,
  Save, Plus, Trash2
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useGetDeliverySettings,
  useUpdateDeliverySettings,
  usePublishDelivery,
  useRevokeDelivery,
  useListDeliveryAccessCards,
  useListDeliveryOrders,
  useUpdateDeliveryFulfillment,
  useUpdateDeliveryPayment,
  type DeliveryOffer
} from "@workspace/api-client-react";
import { format } from "date-fns";

type StudioBranding = {
  name: string;
  tagline: string | null;
  contactEmail: string | null;
  logoObjectPath: string | null;
  primaryColor: string;
  accentColor: string;
  brandingUpdatedAt: string | null;
};

const fallbackBranding: StudioBranding = {
  name: "Volume Capture",
  tagline: "Private photo delivery",
  contactEmail: null,
  logoObjectPath: null,
  primaryColor: "#0F766E",
  accentColor: "#14B8A6",
  brandingUpdatedAt: null,
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character] ?? character);
}

export function DeliveryTab({ projectId, projectName, isCorporate }: { projectId: number; projectName?: string; isCorporate?: boolean }) {
  const [branding, setBranding] = useState<StudioBranding>(fallbackBranding);
  const [activeTab, setActiveTab] = useState("overview");

  // Fetch Studio Branding
  useEffect(() => {
    fetch("/api/studio", { credentials: "include" })
      .then((res) => { if (res.ok) return res.json(); throw new Error(); })
      .then((body: any) => { if (body.studio) setBranding(body.studio); })
      .catch(() => {});
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b bg-white px-6 pt-6">
        <div className="flex items-center gap-3 pb-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-100 text-teal-700">
            <LockKeyhole className="size-5" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-slate-900">Private Delivery</h2>
            <p className="text-sm text-slate-500">
              Manage gallery settings, print access cards, and fulfill orders.
            </p>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="w-full justify-start rounded-none border-b-0 bg-transparent p-0">
            <TabsTrigger 
              value="overview" 
              className="relative rounded-none border-b-2 border-transparent bg-transparent px-4 pb-3 pt-2 font-medium text-slate-500 shadow-none data-[state=active]:border-teal-600 data-[state=active]:text-teal-700 data-[state=active]:shadow-none"
            >
              Overview & Settings
            </TabsTrigger>
            <TabsTrigger 
              value="cards" 
              className="relative rounded-none border-b-2 border-transparent bg-transparent px-4 pb-3 pt-2 font-medium text-slate-500 shadow-none data-[state=active]:border-teal-600 data-[state=active]:text-teal-700 data-[state=active]:shadow-none"
            >
              Access Cards
            </TabsTrigger>
            <TabsTrigger 
              value="orders" 
              className="relative rounded-none border-b-2 border-transparent bg-transparent px-4 pb-3 pt-2 font-medium text-slate-500 shadow-none data-[state=active]:border-teal-600 data-[state=active]:text-teal-700 data-[state=active]:shadow-none"
            >
              Orders
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="flex-1 overflow-auto bg-slate-50 p-6">
        {activeTab === "overview" && (
          <OverviewTab projectId={projectId} />
        )}
        {activeTab === "cards" && (
          <AccessCardsTab projectId={projectId} projectName={projectName} isCorporate={isCorporate} branding={branding} />
        )}
        {activeTab === "orders" && (
          <OrdersTab projectId={projectId} />
        )}
      </div>
    </div>
  );
}

function OverviewTab({ projectId }: { projectId: number }) {
  const { data: settings, isLoading, refetch } = useGetDeliverySettings(projectId);
  
  const publishMutation = usePublishDelivery({
    mutation: {
      onSuccess: () => refetch()
    }
  });
  const revokeMutation = useRevokeDelivery({
    mutation: {
      onSuccess: () => refetch()
    }
  });
  const updateSettingsMutation = useUpdateDeliverySettings({
    mutation: {
      onSuccess: () => refetch()
    }
  });

  const [copied, setCopied] = useState(false);
  const [offers, setOffers] = useState<DeliveryOffer[]>([]);

  useEffect(() => {
    const rawPriceSheet = (settings?.gallery as any)?.priceSheetJson;
    if (rawPriceSheet) {
      try {
        const parsed = JSON.parse(rawPriceSheet);
        if (parsed?.offers) {
          setOffers(parsed.offers.map((offer: Partial<DeliveryOffer>) => ({
            ...offer,
            id: offer.id || crypto.randomUUID(),
            name: offer.name || "",
            productType: offer.productType || "digital",
            unitAmount: Number.isInteger(offer.unitAmount) ? offer.unitAmount : 0,
            currency: offer.currency || "mad",
            paymentMethods: offer.paymentMethods?.length ? offer.paymentMethods : ["stripe"],
            photoCount: offer.photoCount || 1,
            deliveryMethods: offer.deliveryMethods?.length ? offer.deliveryMethods : ["digital"],
            active: offer.active ?? true,
            includesDigitalDownloads: offer.includesDigitalDownloads ?? offer.productType === "digital",
          } as DeliveryOffer)));
        }
      } catch {}
    } else {
      setOffers([]);
    }
  }, [settings]);

  if (isLoading) {
    return <div className="flex items-center justify-center p-12 text-sm text-slate-500"><Loader2 className="mr-2 size-4 animate-spin" /> Loading delivery settings...</div>;
  }

  const gallery = settings?.gallery;
  const accessCount = settings?.accessCount || 0;
  const publicUrl = gallery?.slug ? `${window.location.origin}/delivery/${gallery.slug}` : null;
  const isPublished = gallery?.status === "published";

  const handleCopy = () => {
    if (publicUrl) {
      navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const addOffer = () => {
    setOffers([
      ...offers,
      {
        id: crypto.randomUUID(),
        name: "",
        productType: "digital",
        unitAmount: 0,
        currency: "mad",
        paymentMethods: ["stripe", "establishment", "bank_transfer"],
        photoCount: 1,
        deliveryMethods: ["digital"],
        active: true,
        includesDigitalDownloads: true,
      },
    ]);
  };

  const updateOffer = (id: string, updates: Partial<DeliveryOffer>) => {
    setOffers(offers.map((o) => (o.id === id ? { ...o, ...updates } : o)));
  };

  const removeOffer = (id: string) => {
    setOffers(offers.filter((o) => o.id !== id));
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Status Card */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 bg-slate-50/50 px-6 py-4">
          <h3 className="font-semibold text-slate-900">Gallery Status</h3>
        </div>
        <div className="p-6">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-3">
                <span className={`relative flex h-3 w-3`}>
                  {isPublished && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal-400 opacity-75"></span>}
                  <span className={`relative inline-flex h-3 w-3 rounded-full ${isPublished ? 'bg-teal-500' : 'bg-slate-300'}`}></span>
                </span>
                <span className="font-medium text-slate-900">
                  {isPublished ? "Published & Live" : gallery?.status === "revoked" ? "Revoked" : "Draft (Not Live)"}
                </span>
              </div>
              <p className="mt-2 text-sm text-slate-500">
                {accessCount} access card{accessCount === 1 ? "" : "s"} generated for this project.
              </p>
              {publicUrl && (
                <div className="mt-4 flex items-center gap-2">
                  <code className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-600 select-all">{publicUrl}</code>
                  <button 
                    onClick={handleCopy}
                    className="flex h-6 items-center gap-1 rounded border border-slate-200 bg-white px-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
                  >
                    {copied ? <Check className="size-3 text-teal-600" /> : <Copy className="size-3" />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                  <a 
                    href={publicUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex h-6 items-center gap-1 rounded border border-slate-200 bg-white px-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
                  >
                    <ExternalLink className="size-3" />
                    Open
                  </a>
                </div>
              )}
            </div>
            
            <div className="flex shrink-0 gap-3">
              {isPublished ? (
                <button
                  onClick={() => revokeMutation.mutate({ projectId })}
                  disabled={revokeMutation.isPending}
                  className="flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
                >
                  {revokeMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <Ban className="size-4" />}
                  Revoke Gallery
                </button>
              ) : (
                <button
                  onClick={() => publishMutation.mutate({ projectId })}
                  disabled={publishMutation.isPending}
                  className="flex h-10 items-center gap-2 rounded-lg bg-teal-600 px-4 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50 shadow-sm"
                >
                  {publishMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                  Publish Gallery
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Settings Form */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
         <div className="border-b border-slate-100 bg-slate-50/50 px-6 py-4">
          <h3 className="flex items-center gap-2 font-semibold text-slate-900">
            <Settings className="size-4 text-slate-500" />
            Delivery Settings
          </h3>
        </div>
        <form 
          className="space-y-8 p-6"
          onSubmit={(e) => {
            e.preventDefault();
            // Validate offers
            if (offers.some(o => !o.name.trim() || o.unitAmount < 0 || !/^[A-Za-z]{3}$/.test(o.currency) || o.photoCount < 1 || o.paymentMethods.length < 1)) {
              alert("Complete every offer with a name, valid amount and currency, photo count, and at least one payment method.");
              return;
            }
            const formData = new FormData(e.currentTarget);
            updateSettingsMutation.mutate({
              projectId,
              data: {
                watermarkEnabled: formData.get("watermarkEnabled") === "on",
                watermarkText: (formData.get("watermarkText") as string) || null,
                expiresAt: (formData.get("expiresAt") as string) ? new Date(formData.get("expiresAt") as string).toISOString() : null,
                establishmentPaymentInstructions: (formData.get("establishmentPaymentInstructions") as string) || null,
                bankTransferInstructions: (formData.get("bankTransferInstructions") as string) || null,
                offers,
              }
            });
          }}
        >
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                <input 
                  type="checkbox" 
                  name="watermarkEnabled"
                  defaultChecked={(gallery as any)?.watermarkEnabled ?? true} 
                  className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500" 
                />
                Enable Watermarks on Previews
              </label>
              
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-500">Custom Watermark Text</label>
                <input 
                  type="text" 
                  name="watermarkText"
                  defaultValue={(gallery as any)?.watermarkText || ""} 
                  placeholder="Volume Capture"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
                />
              </div>
            </div>
            
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-500">Gallery Expiration Date</label>
                <input 
                  type="date" 
                  name="expiresAt"
                  defaultValue={(gallery as any)?.expiresAt ? new Date((gallery as any).expiresAt).toISOString().split('T')[0] : ""} 
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
                />
                <p className="text-[11px] text-slate-400">Leave blank for no expiration.</p>
              </div>
            </div>
          </div>

          <div className="grid gap-6 border-t border-slate-100 pt-6 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-500">Pay at establishment instructions</label>
              <textarea
                name="establishmentPaymentInstructions"
                defaultValue={(gallery as any)?.establishmentPaymentInstructions || ""}
                rows={3}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
                placeholder="Where and when the customer can pay, and what order reference to bring."
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-500">Bank transfer instructions</label>
              <textarea
                name="bankTransferInstructions"
                defaultValue={(gallery as any)?.bankTransferInstructions || ""}
                rows={3}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
                placeholder="Bank details and instructions. Ask customers to include their order number."
              />
            </div>
          </div>

          <div className="space-y-4 pt-6 border-t border-slate-100">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="font-semibold text-slate-900">Price Sheet Offers</h4>
                <p className="text-sm text-slate-500">Configure what customers can buy.</p>
              </div>
              <button
                type="button"
                onClick={addOffer}
                data-testid="button-add-offer"
                className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                <Plus className="size-4" /> Add Offer
              </button>
            </div>

            <div className="space-y-4">
              {offers.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
                  No offers configured. Add one above.
                </div>
              ) : (
                offers.map((offer) => (
                  <div key={offer.id} data-testid={`offer-item-${offer.id}`} className="relative rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <button
                      type="button"
                      onClick={() => removeOffer(offer.id)}
                      data-testid={`button-remove-offer-${offer.id}`}
                      className="absolute right-4 top-4 text-slate-400 hover:text-red-600"
                      title="Remove offer"
                    >
                      <Trash2 className="size-4" />
                    </button>
                    
                    <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 pr-8">
                      <div className="space-y-1 md:col-span-2">
                        <label className="text-xs font-medium text-slate-500">Offer Name *</label>
                        <input
                          type="text"
                          required
                          value={offer.name}
                          data-testid={`input-offer-name-${offer.id}`}
                          onChange={(e) => updateOffer(offer.id, { name: e.target.value })}
                          className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-teal-500 focus:outline-none"
                          placeholder="e.g. Digital Single"
                        />
                      </div>
                      
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-slate-500">Product Type</label>
                        <select
                          value={offer.productType}
                          data-testid={`select-offer-product-type-${offer.id}`}
                          onChange={(e) => updateOffer(offer.id, { productType: e.target.value as any })}
                          className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-teal-500 focus:outline-none"
                        >
                          <option value="digital">Digital</option>
                          <option value="print">Print</option>
                          <option value="pack">Pack</option>
                        </select>
                      </div>

                      <div className="space-y-1">
                        <label className="text-xs font-medium text-slate-500">Price *</label>
                        <input
                          required
                          type="number"
                          min={0}
                          step="0.01"
                          value={(offer.unitAmount / 100).toFixed(2)}
                          data-testid={`input-offer-price-${offer.id}`}
                          onChange={(e) => updateOffer(offer.id, { unitAmount: Math.round((Number(e.target.value) || 0) * 100) })}
                          className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-teal-500 focus:outline-none"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-slate-500">Currency *</label>
                        <input
                          required
                          type="text"
                          maxLength={3}
                          value={offer.currency.toUpperCase()}
                          onChange={(e) => updateOffer(offer.id, { currency: e.target.value.replace(/[^A-Za-z]/g, "").slice(0, 3).toLowerCase() })}
                          className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm uppercase focus:border-teal-500 focus:outline-none"
                          placeholder="MAD"
                        />
                      </div>

                      <div className="space-y-1">
                        <label className="text-xs font-medium text-slate-500">Photo Count *</label>
                        <input
                          type="number"
                          min={1}
                          required
                          value={offer.photoCount}
                          onChange={(e) => updateOffer(offer.id, { photoCount: parseInt(e.target.value, 10) || 1 })}
                          className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-teal-500 focus:outline-none"
                        />
                      </div>
                      
                      <div className="space-y-1 md:col-span-3">
                        <label className="text-xs font-medium text-slate-500">Description (Optional)</label>
                        <input
                          type="text"
                          value={offer.description || ""}
                          onChange={(e) => updateOffer(offer.id, { description: e.target.value || undefined })}
                          className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-teal-500 focus:outline-none"
                          placeholder="e.g. High-res download of 1 photo"
                        />
                      </div>

                      {(offer.productType === "print" || offer.productType === "pack") && (
                        <div className="space-y-1 md:col-span-3">
                          <label className="text-xs font-medium text-slate-500">Print Size (Optional)</label>
                          <input
                            type="text"
                            value={offer.printSize || ""}
                            onChange={(e) => updateOffer(offer.id, { printSize: e.target.value || undefined })}
                            className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-teal-500 focus:outline-none"
                            placeholder="e.g. 8x10"
                          />
                        </div>
                      )}

                      <div className="md:col-span-3 space-y-2 mt-2">
                        <label className="text-xs font-medium text-slate-500">Delivery Methods</label>
                        <div className="flex flex-wrap gap-4">
                          {(['digital', 'school', 'collection', 'shipping'] as const).map(method => (
                            <label key={method} className="flex items-center gap-2 text-sm text-slate-700">
                              <input
                                type="checkbox"
                                checked={offer.deliveryMethods.includes(method as any)}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    updateOffer(offer.id, { deliveryMethods: [...offer.deliveryMethods, method as any] });
                                  } else {
                                    updateOffer(offer.id, { deliveryMethods: offer.deliveryMethods.filter(m => m !== method) });
                                  }
                                }}
                                className="rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                              />
                              <span className="capitalize">{method}</span>
                            </label>
                          ))}
                        </div>
                      </div>

                      <div className="md:col-span-3 space-y-2 mt-2">
                        <label className="text-xs font-medium text-slate-500">Payment Methods</label>
                        <div className="flex flex-wrap gap-4">
                          {([
                            ["stripe", "Card with Stripe"],
                            ["establishment", "Pay at establishment"],
                            ["bank_transfer", "Bank transfer"],
                          ] as const).map(([method, label]) => (
                            <label key={method} className="flex items-center gap-2 text-sm text-slate-700">
                              <input
                                type="checkbox"
                                checked={offer.paymentMethods.includes(method)}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    updateOffer(offer.id, { paymentMethods: [...offer.paymentMethods, method] });
                                  } else {
                                    updateOffer(offer.id, { paymentMethods: offer.paymentMethods.filter(value => value !== method) });
                                  }
                                }}
                                className="rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                              />
                              <span>{label}</span>
                            </label>
                          ))}
                        </div>
                        <p className="text-[11px] text-slate-400">Stripe is optional. Manual payment orders remain available when Stripe is disconnected.</p>
                      </div>

                      <div className="md:col-span-3 flex flex-wrap gap-6 mt-2 pt-4 border-t border-slate-200">
                        <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                          <input
                            type="checkbox"
                            checked={offer.active}
                            onChange={(e) => updateOffer(offer.id, { active: e.target.checked })}
                            className="rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                          />
                          Active
                        </label>

                        {offer.productType !== "digital" && (
                          <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                            <input
                              type="checkbox"
                              checked={offer.includesDigitalDownloads ?? false}
                              onChange={(e) => updateOffer(offer.id, { includesDigitalDownloads: e.target.checked })}
                              className="rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                            />
                            Includes Digital Downloads
                          </label>
                        )}
                      </div>

                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
          
          <div className="flex justify-end pt-4 border-t border-slate-100">
            <button
              type="submit"
              data-testid="button-save-settings"
              disabled={updateSettingsMutation.isPending}
              className="flex items-center gap-2 rounded-lg bg-slate-900 px-6 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {updateSettingsMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              Save Settings & Offers
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function AccessCardsTab({ projectId, projectName, isCorporate, branding }: { projectId: number, projectName?: string, isCorporate?: boolean, branding: StudioBranding }) {
  const { data: cards = [], isLoading, error } = useListDeliveryAccessCards(projectId);
  const [classFilter, setClassFilter] = useState("all");

  const classOptions = Array.from(
    new Set(cards.map((card: any) => card.className).filter((value): value is string => Boolean(value))),
  ).sort((a, b) => a.localeCompare(b));
  
  const visibleCards = classFilter === "all" ? cards : cards.filter((card: any) => card.className === classFilter);

  const downloadCards = () => {
    if (!visibleCards.length) return;
    const header = ["First name", "Last name", "Student ID", "Class / department", "Access code", "Private gallery URL"];
    const rows = visibleCards.map((card: any) => [
      card.firstName,
      card.lastName,
      card.generatedStudentId || "",
      card.className ?? "",
      card.accessCode,
      `${window.location.origin}${card.accessUrl}`,
    ]);
    const csv = [header, ...rows]
      .map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","))
      .join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    link.download = `access-cards-${projectId}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const printCards = () => {
    if (!visibleCards.length) return;
    const entity = isCorporate ? "employee" : "student";
    const entityPlural = isCorporate ? "employees" : "students";
    const publicOrigin = window.location.origin;
    const logoUrl = branding.logoObjectPath
      ? `/api/studio/branding/logo?rev=${encodeURIComponent(branding.brandingUpdatedAt ?? "")}`
      : "";
    const cardMarkup = visibleCards.map((card: any) => {
      const fullUrl = `${publicOrigin}${card.accessUrl}`;
      return `
        <article class="access-card">
          <div class="card-name">${escapeHtml(card.firstName)} ${escapeHtml(card.lastName)}</div>
          <div class="card-id">${escapeHtml(card.generatedStudentId || "")}</div>
          <img class="qr" src="${escapeHtml(card.qrDataUrl || "")}" alt="QR code" />
          <div class="scan-label">Scan to view private photos</div>
          <div class="code-label">Access code</div>
          <div class="code">${escapeHtml(card.accessCode)}</div>
          <div class="url">${escapeHtml(fullUrl)}</div>
          <p class="instruction">Keep this card private. It provides access to this ${entity}'s photos.</p>
        </article>`;
    }).join("");
    
    const html = `<!doctype html>
      <html><head><meta charset="utf-8"><title>${escapeHtml(branding.name)} — ${escapeHtml(projectName ?? "Photo delivery")}</title>
      <style>
        @page { size: letter; margin: 0.35in; }
        * { box-sizing: border-box; }
        body { margin: 0; color: #172033; font-family: Arial, Helvetica, sans-serif; background: #fff; }
        .sheet-header { display: flex; align-items: center; gap: 14px; padding: 0 0 16px; border-bottom: 4px solid ${escapeHtml(branding.accentColor)}; margin-bottom: 16px; }
        .logo { width: 58px; height: 58px; object-fit: contain; border-radius: 10px; }
        .brand-name { color: ${escapeHtml(branding.primaryColor)}; font-size: 19px; font-weight: 700; }
        .tagline { color: #657084; font-size: 11px; margin-top: 3px; }
        .sheet-title { margin-left: auto; text-align: right; }
        .sheet-title h1 { margin: 0; font-size: 16px; }
        .sheet-title p { margin: 4px 0 0; color: #657084; font-size: 11px; }
        .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
        .access-card { min-height: 3.55in; padding: 14px; border: 1px solid #dbe2ea; border-top: 5px solid ${escapeHtml(branding.primaryColor)}; border-radius: 10px; text-align: center; page-break-inside: avoid; }
        .card-name { font-size: 17px; font-weight: 700; }
        .card-id { color: #657084; font-size: 10px; margin-top: 3px; }
        .qr { display: block; width: 1.48in; height: 1.48in; margin: 10px auto 5px; image-rendering: pixelated; }
        .scan-label { color: #657084; font-size: 10px; }
        .code-label { color: #657084; font-size: 9px; text-transform: uppercase; letter-spacing: 0.12em; margin-top: 9px; }
        .code { color: ${escapeHtml(branding.primaryColor)}; font-family: monospace; font-size: 18px; font-weight: 700; letter-spacing: 0.12em; margin-top: 3px; }
        .url { color: #657084; font-size: 8px; overflow-wrap: anywhere; margin-top: 5px; }
        .instruction { color: #657084; font-size: 9px; line-height: 1.35; margin: 8px 0 0; }
        .footer { color: #657084; font-size: 9px; margin-top: 14px; text-align: center; }
        @media print { .footer { display: none; } }
      </style></head>
      <body>
        <header class="sheet-header">
          ${logoUrl ? `<img class="logo" src="${escapeHtml(logoUrl)}" alt="${escapeHtml(branding.name)} logo" />` : ""}
          <div><div class="brand-name">${escapeHtml(branding.name)}</div><div class="tagline">${escapeHtml(branding.tagline ?? "Private photo delivery")}</div></div>
          <div class="sheet-title"><h1>Private ${entity} photo access</h1><p>${escapeHtml(projectName ?? "Photo delivery")} · ${visibleCards.length} ${entityPlural}${classFilter === "all" ? "" : ` · ${escapeHtml(classFilter)}`}</p></div>
        </header>
        <main class="grid">${cardMarkup}</main>
        <div class="footer">Print this sheet and give each card only to the matching ${entity} or family.</div>
        <script>window.addEventListener("load", () => window.print());<\/script>
      </body></html>`;
      
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      alert("Allow pop-ups to print the branded QR sheet.");
      return;
    }
    printWindow.document.write(html);
    printWindow.document.close();
  };

  if (isLoading) {
    return <div className="flex items-center justify-center p-12 text-sm text-slate-500"><Loader2 className="mr-2 size-4 animate-spin" /> Loading access cards...</div>;
  }
  
  if (error) {
    return <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">Failed to load access cards. The gallery may not be published yet.</div>;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">Access Cards</h3>
          <p className="text-sm text-slate-500">
            Print QR sheets or download a CSV to distribute to {isCorporate ? "employees" : "students"}.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {classOptions.length > 0 && (
             <select 
               value={classFilter} 
               onChange={(e) => setClassFilter(e.target.value)} 
               className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
             >
               <option value="all">All Groups</option>
               {classOptions.map((className) => <option key={className} value={className}>{className}</option>)}
             </select>
           )}
           <button 
             onClick={printCards}
             disabled={visibleCards.length === 0}
             className="flex h-10 items-center gap-2 rounded-lg bg-teal-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-teal-700 disabled:opacity-50"
           >
             <Printer className="size-4" /> Print PDF
           </button>
           <button 
             onClick={downloadCards}
             disabled={visibleCards.length === 0}
             className="flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
           >
             <Download className="size-4" /> CSV
           </button>
        </div>
      </div>
      
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="px-4 py-3 font-medium text-slate-500">Name</th>
                <th className="px-4 py-3 font-medium text-slate-500">Group</th>
                <th className="px-4 py-3 font-medium text-slate-500">Access Code</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visibleCards.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-slate-500">No cards found.</td>
                </tr>
              ) : (
                visibleCards.slice(0, 100).map((card: any, i: number) => (
                  <tr key={i} className="hover:bg-slate-50/50">
                    <td className="px-4 py-3 font-medium text-slate-900">{card.lastName}, {card.firstName}</td>
                    <td className="px-4 py-3 text-slate-500">{card.className || "—"}</td>
                    <td className="px-4 py-3 font-mono text-slate-600">{card.accessCode}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {visibleCards.length > 100 && (
          <div className="border-t border-slate-100 bg-slate-50 p-3 text-center text-xs text-slate-500">
            Showing first 100 of {visibleCards.length} cards. Download CSV for full list.
          </div>
        )}
      </div>
    </div>
  );
}

function OrdersTab({ projectId }: { projectId: number }) {
  const { data: response, isLoading, refetch } = useListDeliveryOrders(projectId);
  const updateFulfillment = useUpdateDeliveryFulfillment({
    mutation: {
      onSuccess: () => refetch()
    }
  });
  const updatePayment = useUpdateDeliveryPayment({
    mutation: {
      onSuccess: () => refetch()
    }
  });

  if (isLoading) {
    return <div className="flex items-center justify-center p-12 text-sm text-slate-500"><Loader2 className="mr-2 size-4 animate-spin" /> Loading orders...</div>;
  }

  const orders = response?.orders || [];

  const handleExport = () => {
    window.open(`/api/projects/${projectId}/delivery/orders/export.csv`, "_blank");
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">Customer Orders</h3>
          <p className="text-sm text-slate-500">
            Review Stripe and manual-payment orders from this gallery.
          </p>
        </div>
        <button 
          onClick={handleExport}
          disabled={orders.length === 0}
          className="flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
        >
          <Download className="size-4" /> Export Orders
        </button>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="px-4 py-3 font-medium text-slate-500">Order #</th>
                <th className="px-4 py-3 font-medium text-slate-500">Customer</th>
                <th className="px-4 py-3 font-medium text-slate-500">Amount</th>
                <th className="px-4 py-3 font-medium text-slate-500">Payment method</th>
                <th className="px-4 py-3 font-medium text-slate-500">Date</th>
                <th className="px-4 py-3 font-medium text-slate-500">Status</th>
                <th className="px-4 py-3 font-medium text-slate-500 text-right">Fulfillment</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {orders.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-slate-500">
                    <ShoppingBag className="mx-auto mb-3 size-8 text-slate-300" />
                    No orders placed yet.
                  </td>
                </tr>
              ) : (
                orders.map((order: any) => (
                  <tr key={order.id} className="hover:bg-slate-50/50">
                    <td className="px-4 py-3 font-mono text-slate-500">#{order.id}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{order.customerName || "Unknown"}</div>
                      <div className="text-xs text-slate-500">{order.customerEmail}</div>
                    </td>
                    <td className="px-4 py-3 font-medium text-slate-900">
                      {(order.amountTotal / 100).toLocaleString('en-US', { style: 'currency', currency: order.currency || 'USD' })}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {order.paymentMethod === "establishment"
                        ? "At establishment"
                        : order.paymentMethod === "bank_transfer"
                          ? "Bank transfer"
                          : "Stripe"}
                    </td>
                    <td className="px-4 py-3 text-slate-500 whitespace-nowrap">
                      {order.createdAt ? format(new Date(order.createdAt), "MMM d, yyyy") : "—"}
                    </td>
                    <td className="px-4 py-3">
                      {order.paymentMethod === "stripe" ? (
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          order.status === 'paid' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-700'
                        }`}>
                          {order.status}
                        </span>
                      ) : (
                        <select
                          value={order.status}
                          onChange={(e) => updatePayment.mutate({
                            projectId,
                            orderId: order.id,
                            data: { status: e.target.value as any },
                          })}
                          disabled={updatePayment.isPending}
                          aria-label={`Payment status for order ${order.id}`}
                          className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 focus:border-teal-500 focus:outline-none"
                        >
                          <option value="pending">Awaiting payment</option>
                          <option value="paid">Paid</option>
                          <option value="cancelled">Cancelled</option>
                          <option value="refunded">Refunded</option>
                        </select>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <select 
                        value={order.fulfillmentStatus || 'not_required'}
                        onChange={(e) => updateFulfillment.mutate({ 
                          projectId, 
                          orderId: order.id, 
                          data: { fulfillmentStatus: e.target.value as any } 
                        })}
                        disabled={updateFulfillment.isPending}
                        className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 focus:border-teal-500 focus:outline-none"
                      >
                        <option value="not_required">Digital Only</option>
                        <option value="paid">Paid (Pending)</option>
                        <option value="preparing">Preparing</option>
                        <option value="printed">Printed</option>
                        <option value="ready">Ready</option>
                        <option value="dispatched">Dispatched</option>
                        <option value="delivered">Delivered</option>
                      </select>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
