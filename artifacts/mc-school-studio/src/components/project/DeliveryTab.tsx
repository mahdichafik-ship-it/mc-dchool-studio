import React, { useState, useEffect, useRef } from "react";
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
  useListDeliveryPriceSheets,
  useCreateDeliveryPriceSheet,
  useUpdateDeliveryPriceSheet,
  getListDeliveryPriceSheetsQueryKey,
  type DeliveryOffer
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
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
  const { data: settings, isLoading: settingsLoading, refetch: refetchSettings } = useGetDeliverySettings(projectId);
  const { data: priceSheets, isLoading: sheetsLoading } = useListDeliveryPriceSheets(projectId);
  const queryClient = useQueryClient();
  
  const publishMutation = usePublishDelivery({
    mutation: { onSuccess: () => refetchSettings() }
  });
  const revokeMutation = useRevokeDelivery({
    mutation: { onSuccess: () => refetchSettings() }
  });
  const updateSettingsMutation = useUpdateDeliverySettings();
  const createSheetMutation = useCreateDeliveryPriceSheet();
  const updateSheetMutation = useUpdateDeliveryPriceSheet();

  const [copied, setCopied] = useState(false);
  
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [saveMessage, setSaveMessage] = useState("");

  const [selectedSheetId, setSelectedSheetId] = useState<number | "new">("new");
  const [sheetName, setSheetName] = useState("");
  const [offers, setOffers] = useState<DeliveryOffer[]>([]);

  const initializedForId = useRef<number | null>(null);

  useEffect(() => {
    if (settings && priceSheets && initializedForId.current !== projectId) {
      initializedForId.current = projectId;
      const gallery = settings.gallery as any;
      const assignedId = gallery?.priceSheetId;
      const rawPriceSheet = gallery?.priceSheetJson;

      if (assignedId && priceSheets.find((s: any) => s.id === assignedId)) {
        const sheet = priceSheets.find((s: any) => s.id === assignedId)!;
        setSelectedSheetId(sheet.id);
        setSheetName(sheet.name);
        setOffers(sheet.offers || []);
      } else if (rawPriceSheet) {
        try {
          const parsed = JSON.parse(rawPriceSheet);
          setSheetName(parsed.name || "Legacy Offers");
          setOffers(parsed.offers || []);
          setSelectedSheetId("new");
        } catch {}
      } else if (priceSheets.length > 0) {
        setSelectedSheetId("new");
      }
    }
  }, [settings, priceSheets, projectId]);

  if (settingsLoading || sheetsLoading) {
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

  const handleSheetSelect = (id: string) => {
    if (id === "new") {
      setSelectedSheetId("new");
      setSheetName("");
      setOffers([]);
    } else {
      const numId = Number(id);
      const sheet = priceSheets?.find((s: any) => s.id === numId);
      if (sheet) {
        setSelectedSheetId(sheet.id);
        setSheetName(sheet.name);
        setOffers(sheet.offers || []);
      }
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

  const handleSave = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaveStatus("saving");

    if (!sheetName.trim()) {
      setSaveStatus("error");
      setSaveMessage("Please provide a name for the price sheet.");
      return;
    }

    if (offers.length === 0) {
      setSaveStatus("error");
      setSaveMessage("Please add at least one offer.");
      return;
    }

    if (offers.some(o => !o.name.trim() || o.unitAmount < 0 || !/^[A-Za-z]{3}$/.test(o.currency) || o.photoCount < 1 || o.paymentMethods.length < 1 || o.deliveryMethods.length < 1)) {
      setSaveStatus("error");
      setSaveMessage("Complete every offer with a name, valid amount and currency, photo count, delivery and payment methods.");
      return;
    }

    const formData = new FormData(e.currentTarget);
    const watermarkEnabled = formData.get("watermarkEnabled") === "on";
    const watermarkText = (formData.get("watermarkText") as string) || null;
    const expiresAt = (formData.get("expiresAt") as string) ? new Date(formData.get("expiresAt") as string).toISOString() : null;
    const establishmentPaymentInstructions = (formData.get("establishmentPaymentInstructions") as string) || null;
    const bankTransferInstructions = (formData.get("bankTransferInstructions") as string) || null;

    try {
      let sheetId = selectedSheetId === "new" ? null : (selectedSheetId as number);
      
      if (sheetId === null) {
        const newSheet = await createSheetMutation.mutateAsync({
          projectId,
          data: { name: sheetName, offers }
        });
        sheetId = newSheet.id;
        setSelectedSheetId(sheetId);
      } else {
        await updateSheetMutation.mutateAsync({
          projectId,
          priceSheetId: sheetId,
          data: { name: sheetName, offers }
        });
      }

      await updateSettingsMutation.mutateAsync({
        projectId,
        data: {
          watermarkEnabled,
          watermarkText,
          expiresAt,
          establishmentPaymentInstructions,
          bankTransferInstructions,
          priceSheetId: sheetId,
          offers // Fallback for backwards compatibility if needed
        }
      });

      queryClient.invalidateQueries({ queryKey: getListDeliveryPriceSheetsQueryKey(projectId) });
      refetchSettings();
      setSaveStatus("success");
      setSaveMessage("Settings and price sheet saved.");
      setTimeout(() => setSaveStatus("idle"), 3000);
    } catch (err) {
      setSaveStatus("error");
      setSaveMessage("Failed to save settings. Please try again.");
    }
  };

  const isSaving = saveStatus === "saving";

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
                  type="button"
                  onClick={() => revokeMutation.mutate({ projectId })}
                  disabled={revokeMutation.isPending}
                  className="flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
                >
                  {revokeMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <Ban className="size-4" />}
                  Revoke Gallery
                </button>
              ) : (
                <button
                  type="button"
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
        <form className="space-y-8 p-6" onSubmit={handleSave}>
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

          <div className="space-y-6 pt-6 border-t border-slate-100">
            <div>
              <h4 className="font-semibold text-slate-900">Price Sheet</h4>
              <p className="text-sm text-slate-500">Select an existing price sheet to assign, or create a new one.</p>
            </div>

            <div className="grid gap-6 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-500">Selected Price Sheet</label>
                <select
                  value={selectedSheetId}
                  onChange={(e) => handleSheetSelect(e.target.value)}
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
                >
                  <option value="new">+ Create New Price Sheet</option>
                  {priceSheets?.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-500">Sheet Name *</label>
                <input
                  type="text"
                  required
                  value={sheetName}
                  onChange={(e) => setSheetName(e.target.value)}
                  placeholder="e.g. Fall Portraits 2024"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-slate-100 pt-6">
              <h5 className="font-medium text-slate-900">Offers</h5>
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
                                checked={offer.paymentMethods.includes(method as any)}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    updateOffer(offer.id, { paymentMethods: [...offer.paymentMethods, method as any] });
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
          
          <div className="pt-6 border-t border-slate-100">
            {saveStatus === "error" && (
              <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 border border-red-200">
                {saveMessage}
              </div>
            )}
            {saveStatus === "success" && (
              <div className="mb-4 rounded-lg bg-teal-50 p-3 text-sm text-teal-800 border border-teal-200">
                {saveMessage}
              </div>
            )}
            <div className="flex justify-end">
              <button
                type="submit"
                data-testid="button-save-settings"
                disabled={isSaving}
                className="flex items-center gap-2 rounded-lg bg-slate-900 px-6 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {isSaving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                Save Settings & Offers
              </button>
            </div>
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
  };

  const printCards = () => {
    if (!visibleCards.length) return;

    const cardsHtml = visibleCards.map((card: any) => {
      const url = `${window.location.origin}${card.accessUrl}`;
      const escapedUrl = escapeHtml(url);
      const isCardCorporate = isCorporate || false;
      const organizationType = isCardCorporate ? "Company" : "School";
      const orgNameLabel = isCardCorporate ? "Company" : "School";
      const subjectLabel = isCardCorporate ? "Employee" : "Student";
      const departmentLabel = isCardCorporate ? "Department" : "Class";

      return `
        <div class="card">
          <div class="card-inner">
            <div class="card-header" style="background-color: ${escapeHtml(branding.primaryColor)};">
              <h1 class="studio-name">${escapeHtml(branding.name)}</h1>
              ${branding.tagline ? `<p class="studio-tagline">${escapeHtml(branding.tagline)}</p>` : ''}
            </div>
            
            <div class="card-body">
              <h2 class="card-title">Private Photo Gallery</h2>
              
              <div class="student-info">
                <div class="info-row">
                  <span class="info-label">${subjectLabel}:</span>
                  <span class="info-value"><strong>${escapeHtml(card.firstName)} ${escapeHtml(card.lastName)}</strong></span>
                </div>
                ${card.className ? `
                <div class="info-row">
                  <span class="info-label">${departmentLabel}:</span>
                  <span class="info-value">${escapeHtml(card.className)}</span>
                </div>
                ` : ''}
                ${projectName ? `
                <div class="info-row">
                  <span class="info-label">${orgNameLabel}:</span>
                  <span class="info-value">${escapeHtml(projectName)}</span>
                </div>
                ` : ''}
              </div>

              <div class="access-section">
                <div class="qr-container">
                  ${card.qrDataUrl ? `<img src="${card.qrDataUrl}" alt="QR Code" class="qr-code" />` : '<div class="qr-placeholder">QR Code</div>'}
                </div>
                
                <div class="instructions">
                  <p class="step"><strong>1.</strong> Scan the QR code or visit:</p>
                  <p class="url">${escapedUrl}</p>
                  <p class="step"><strong>2.</strong> Enter your secure access code:</p>
                  <div class="code-box">
                    <span class="code-text" style="color: ${escapeHtml(branding.primaryColor)};">${escapeHtml(card.accessCode)}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join("");

    const printWindow = window.open("", "_blank");
    if (!printWindow) return;

    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Print Access Cards - ${escapeHtml(projectName || "Project")}</title>
          <style>
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
            
            :root {
              --primary: ${escapeHtml(branding.primaryColor)};
              --accent: ${escapeHtml(branding.accentColor)};
            }

            body {
              margin: 0;
              padding: 0;
              background-color: #fff;
              font-family: 'Inter', sans-serif;
              color: #0f172a;
              -webkit-print-color-adjust: exact !important;
              print-color-adjust: exact !important;
            }

            @page {
              size: A4;
              margin: 0;
            }

            .print-grid {
              display: grid;
              grid-template-columns: repeat(2, 1fr);
              gap: 0;
              width: 210mm;
              margin: 0 auto;
            }

            .card {
              width: 105mm;
              height: 148.5mm; /* A4 height divided by 2 */
              padding: 10mm;
              box-sizing: border-box;
              page-break-inside: avoid;
              border-right: 1px dashed #e2e8f0;
              border-bottom: 1px dashed #e2e8f0;
            }

            /* Remove borders from edges to keep it clean */
            .card:nth-child(even) { border-right: none; }
            
            .card-inner {
              height: 100%;
              border: 1px solid #cbd5e1;
              border-radius: 12px;
              overflow: hidden;
              display: flex;
              flex-direction: column;
            }

            .card-header {
              padding: 20px;
              text-align: center;
              color: white;
            }

            .studio-name {
              margin: 0;
              font-size: 20px;
              font-weight: 700;
              letter-spacing: -0.02em;
            }

            .studio-tagline {
              margin: 4px 0 0 0;
              font-size: 12px;
              opacity: 0.9;
            }

            .card-body {
              padding: 24px;
              flex: 1;
              display: flex;
              flex-direction: column;
              background-color: white;
            }

            .card-title {
              margin: 0 0 20px 0;
              font-size: 16px;
              font-weight: 600;
              text-align: center;
              color: #334155;
            }

            .student-info {
              background-color: #f8fafc;
              border-radius: 8px;
              padding: 16px;
              margin-bottom: 24px;
            }

            .info-row {
              display: flex;
              justify-content: space-between;
              font-size: 14px;
              margin-bottom: 8px;
              line-height: 1.4;
            }
            .info-row:last-child { margin-bottom: 0; }

            .info-label { color: #64748b; }
            .info-value { color: #0f172a; text-align: right; }

            .access-section {
              display: flex;
              gap: 20px;
              align-items: center;
              margin-top: auto;
            }

            .qr-container {
              flex-shrink: 0;
              width: 100px;
              height: 100px;
              padding: 8px;
              border: 1px solid #e2e8f0;
              border-radius: 8px;
              background: white;
            }

            .qr-code {
              width: 100%;
              height: 100%;
              display: block;
            }

            .instructions {
              flex: 1;
            }

            .step {
              margin: 0 0 4px 0;
              font-size: 12px;
              color: #475569;
            }

            .url {
              margin: 0 0 16px 0;
              font-size: 11px;
              font-weight: 500;
              color: #0f172a;
              word-break: break-all;
            }

            .code-box {
              background-color: #f1f5f9;
              border: 1px solid #e2e8f0;
              border-radius: 6px;
              padding: 10px;
              text-align: center;
            }

            .code-text {
              font-family: monospace;
              font-size: 20px;
              font-weight: 700;
              letter-spacing: 0.1em;
            }
          </style>
        </head>
        <body>
          <div class="print-grid">
            ${cardsHtml}
          </div>
          <script>
            window.onload = () => {
              setTimeout(() => {
                window.print();
              }, 500);
            };
          </script>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  if (isLoading) {
    return <div className="flex items-center justify-center p-12 text-sm text-slate-500"><Loader2 className="mr-2 size-4 animate-spin" /> Loading access cards...</div>;
  }

  if (error) {
    return <div className="p-6 text-sm text-red-600">Failed to load access cards.</div>;
  }

  if (cards.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-16 text-center">
        <QrCode className="mb-4 size-10 text-slate-300" />
        <h3 className="font-semibold text-slate-900">No Access Cards</h3>
        <p className="mt-2 text-sm text-slate-500 max-w-sm">
          Access cards are generated automatically when a gallery is published. To generate cards, go to the Overview tab and publish the gallery.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <select 
            value={classFilter} 
            onChange={(e) => setClassFilter(e.target.value)}
            className="h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
          >
            <option value="all">All Classes ({cards.length})</option>
            {classOptions.map((className) => (
              <option key={className} value={className}>{className}</option>
            ))}
          </select>
        </div>
        
        <div className="flex gap-3">
          <button 
            onClick={downloadCards}
            className="flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
          >
            <Download className="size-4" /> Download CSV
          </button>
          <button 
            onClick={printCards}
            className="flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-medium text-white shadow-sm hover:bg-slate-800"
          >
            <Printer className="size-4" /> Print Cards
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              <th className="px-4 py-3 font-semibold text-slate-900">Name</th>
              <th className="px-4 py-3 font-semibold text-slate-900">Class</th>
              <th className="px-4 py-3 font-semibold text-slate-900">Access Code</th>
              <th className="px-4 py-3 font-semibold text-slate-900">Gallery Link</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visibleCards.map((card: any, idx: number) => (
              <tr key={idx} className="hover:bg-slate-50/50">
                <td className="px-4 py-3 font-medium text-slate-900">{card.firstName} {card.lastName}</td>
                <td className="px-4 py-3 text-slate-500">{card.className || "—"}</td>
                <td className="px-4 py-3">
                  <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-600">{card.accessCode}</code>
                </td>
                <td className="px-4 py-3">
                  <a href={card.accessUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-teal-600 hover:text-teal-700">
                    Open <ExternalLink className="size-3" />
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function OrdersTab({ projectId }: { projectId: number }) {
  const { data, isLoading, refetch } = useListDeliveryOrders(projectId);
  const updateFulfillment = useUpdateDeliveryFulfillment({ mutation: { onSuccess: () => refetch() } });
  const updatePayment = useUpdateDeliveryPayment({ mutation: { onSuccess: () => refetch() } });

  if (isLoading) {
    return <div className="flex items-center justify-center p-12 text-sm text-slate-500"><Loader2 className="mr-2 size-4 animate-spin" /> Loading orders...</div>;
  }

  const orders = data?.orders || [];

  if (orders.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-16 text-center">
        <ShoppingBag className="mb-4 size-10 text-slate-300" />
        <h3 className="font-semibold text-slate-900">No Orders Yet</h3>
        <p className="mt-2 text-sm text-slate-500">
          When parents place orders through the private delivery gallery, they will appear here.
        </p>
      </div>
    );
  }

  const statusColors: Record<string, string> = {
    pending: "bg-amber-100 text-amber-800 border-amber-200",
    paid: "bg-green-100 text-green-800 border-green-200",
    cancelled: "bg-slate-100 text-slate-600 border-slate-200",
    refunded: "bg-slate-100 text-slate-600 border-slate-200",
  };

  const fulfillmentColors: Record<string, string> = {
    not_required: "bg-slate-100 text-slate-600 border-slate-200",
    paid: "bg-slate-100 text-slate-800 border-slate-200",
    preparing: "bg-blue-100 text-blue-800 border-blue-200",
    printed: "bg-indigo-100 text-indigo-800 border-indigo-200",
    ready: "bg-purple-100 text-purple-800 border-purple-200",
    dispatched: "bg-teal-100 text-teal-800 border-teal-200",
    delivered: "bg-green-100 text-green-800 border-green-200",
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              <th className="px-4 py-3 font-semibold text-slate-900">Order ID</th>
              <th className="px-4 py-3 font-semibold text-slate-900">Date</th>
              <th className="px-4 py-3 font-semibold text-slate-900">Customer</th>
              <th className="px-4 py-3 font-semibold text-slate-900">Amount</th>
              <th className="px-4 py-3 font-semibold text-slate-900">Payment</th>
              <th className="px-4 py-3 font-semibold text-slate-900">Fulfillment</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {orders.map((order: any) => (
              <tr key={order.id} className="hover:bg-slate-50/50">
                <td className="px-4 py-3 font-mono font-medium text-slate-900">#{order.id}</td>
                <td className="px-4 py-3 text-slate-500">{format(new Date(order.createdAt), "MMM d, yyyy")}</td>
                <td className="px-4 py-3">
                  <div className="font-medium text-slate-900">{order.customerName}</div>
                  {order.customerEmail && <div className="text-xs text-slate-500">{order.customerEmail}</div>}
                </td>
                <td className="px-4 py-3 font-medium text-slate-900">
                  {new Intl.NumberFormat(undefined, { style: "currency", currency: order.currency.toUpperCase() }).format(order.amountTotal / 100)}
                </td>
                <td className="px-4 py-3">
                  <select
                    value={order.status}
                    onChange={(e) => updatePayment.mutate({ projectId, orderId: order.id, data: { status: e.target.value as any } })}
                    className={`rounded-md border px-2 py-1 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-teal-500 ${statusColors[order.status] || statusColors.pending}`}
                  >
                    <option value="pending">Pending</option>
                    <option value="paid">Paid</option>
                    <option value="cancelled">Cancelled</option>
                    <option value="refunded">Refunded</option>
                  </select>
                </td>
                <td className="px-4 py-3">
                  <select
                    value={order.fulfillmentStatus}
                    onChange={(e) => updateFulfillment.mutate({ projectId, orderId: order.id, data: { fulfillmentStatus: e.target.value as any } })}
                    className={`rounded-md border px-2 py-1 text-xs font-medium capitalize focus:outline-none focus:ring-2 focus:ring-teal-500 ${fulfillmentColors[order.fulfillmentStatus] || fulfillmentColors.not_required}`}
                  >
                    <option value="not_required">Not Required</option>
                    <option value="paid">Paid</option>
                    <option value="preparing">Preparing</option>
                    <option value="printed">Printed</option>
                    <option value="ready">Ready</option>
                    <option value="dispatched">Dispatched</option>
                    <option value="delivered">Delivered</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
