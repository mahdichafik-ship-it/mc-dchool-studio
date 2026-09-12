import React, { useState, useEffect, useRef } from "react";
import { Link } from "wouter";
import { 
  Check, Copy, Download, ExternalLink, Loader2, LockKeyhole, 
  Printer, QrCode, Send, Settings, ShoppingBag, Search, Ban, Play, Image as ImageIcon,
  Save, FileText, AlertCircle
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
  useListStudioPriceSheets,
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
  const { data: settings, isLoading: settingsLoading, refetch: refetchSettings } = useGetDeliverySettings(projectId);
  const { data: priceSheets, isLoading: sheetsLoading } = useListStudioPriceSheets();
  const publishMutation = usePublishDelivery({
    mutation: { onSuccess: () => refetchSettings() }
  });
  const revokeMutation = useRevokeDelivery({
    mutation: { onSuccess: () => refetchSettings() }
  });
  const updateSettingsMutation = useUpdateDeliverySettings();

  const [copied, setCopied] = useState(false);
  
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [saveMessage, setSaveMessage] = useState("");

  const [selectedSheetId, setSelectedSheetId] = useState<number | "">("");

  const initializedForId = useRef<number | null>(null);

  useEffect(() => {
    if (settings && initializedForId.current !== projectId) {
      initializedForId.current = projectId;
      const gallery = settings.gallery as any;
      const assignedId = gallery?.priceSheetId;

      if (assignedId) {
        setSelectedSheetId(assignedId);
      }
    }
  }, [settings, projectId]);

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

  const handleSave = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaveStatus("saving");

    const formData = new FormData(e.currentTarget);
    const watermarkEnabled = formData.get("watermarkEnabled") === "on";
    const watermarkText = (formData.get("watermarkText") as string) || null;
    const expiresAt = (formData.get("expiresAt") as string) ? new Date(formData.get("expiresAt") as string).toISOString() : null;
    const establishmentPaymentInstructions = (formData.get("establishmentPaymentInstructions") as string) || null;
    const bankTransferInstructions = (formData.get("bankTransferInstructions") as string) || null;

    try {
      await updateSettingsMutation.mutateAsync({
        projectId,
        data: {
          watermarkEnabled,
          watermarkText,
          expiresAt,
          establishmentPaymentInstructions,
          bankTransferInstructions,
          priceSheetId: selectedSheetId ? Number(selectedSheetId) : null,
        }
      });

      refetchSettings();
      setSaveStatus("success");
      setSaveMessage("Settings saved.");
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
                  disabled={publishMutation.isPending || !selectedSheetId}
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
         <div className="border-b border-slate-100 bg-slate-50/50 px-6 py-4 flex items-center justify-between">
          <h3 className="flex items-center gap-2 font-semibold text-slate-900">
            <Settings className="size-4 text-slate-500" />
            Delivery Settings
          </h3>
          {saveMessage && (
            <span className={`text-sm ${saveStatus === 'success' ? 'text-teal-600' : 'text-red-600'}`}>
              {saveMessage}
            </span>
          )}
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

          <div className="space-y-4 pt-6 border-t border-slate-100">
            <div>
              <h4 className="font-semibold text-slate-900 flex items-center gap-2">
                <FileText className="w-4 h-4 text-slate-500" />
                Price Sheet
              </h4>
              <p className="text-sm text-slate-500">Assign a price sheet to determine what products and prices are offered for this project.</p>
            </div>

            <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
              <div className="flex flex-col sm:flex-row gap-4 sm:items-end">
                <div className="flex-1 space-y-1">
                  <label className="text-xs font-medium text-slate-500">Selected Price Sheet</label>
                  <select
                    value={selectedSheetId}
                    onChange={(e) => setSelectedSheetId(e.target.value ? Number(e.target.value) : "")}
                    disabled={isPublished}
                    className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
                    required
                  >
                    <option value="" disabled>Select a price sheet...</option>
                    {priceSheets?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                <div className="shrink-0 pb-[1px]">
                  <Link href="/price-sheets" className="text-sm font-medium text-teal-600 hover:text-teal-700">
                    Manage price sheets &rarr;
                  </Link>
                </div>
              </div>
              
              {isPublished && (
                <div className="mt-4 flex gap-2 text-xs text-amber-700 bg-amber-50 p-3 rounded border border-amber-200">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <p>This gallery uses a fixed pricing snapshot. Revoke it before selecting another price sheet and publishing again.</p>
                </div>
              )}
            </div>
          </div>
          
          <div className="flex justify-end pt-4 border-t border-slate-100">
            <button
              type="submit"
              disabled={isSaving}
              className="flex items-center justify-center gap-2 rounded-lg bg-teal-600 px-6 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
            >
              {isSaving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              {isSaving ? "Saving..." : "Save Settings"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function AccessCardsTab({ projectId, projectName, isCorporate, branding }: { projectId: number; projectName?: string; isCorporate?: boolean; branding: StudioBranding }) {
  const { data: cards, isLoading } = useListDeliveryAccessCards(projectId);
  const [printLoading, setPrintLoading] = useState(false);
  const [search, setSearch] = useState("");
  const subjectLabel = isCorporate ? "Employee" : "Student";
  const groupLabel = isCorporate ? "Department" : "Class";

  if (isLoading) {
    return <div className="flex items-center justify-center p-12 text-sm text-slate-500"><Loader2 className="mr-2 size-4 animate-spin" /> Loading access cards...</div>;
  }

  const filteredCards = (cards || []).filter((card: any) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (card.firstName?.toLowerCase().includes(q)
      || card.lastName?.toLowerCase().includes(q)
      || card.departmentName?.toLowerCase().includes(q)
      || card.accessCode?.toLowerCase().includes(q));
  });

  const handlePrint = async () => {
    setPrintLoading(true);
    try {
      const w = window.open("", "_blank");
      if (!w) throw new Error("Popup blocked");
      
      w.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Access Cards - ${escapeHtml(projectName || "Project")}</title>
          <style>
            @page { size: A4; margin: 0; }
            body { 
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
              margin: 0; padding: 10mm; background: #fff;
              -webkit-print-color-adjust: exact; color-adjust: exact;
            }
            .grid {
              display: grid; grid-template-columns: repeat(2, 1fr); gap: 10mm;
            }
            .card {
              border: 2px solid ${escapeHtml(branding.primaryColor)};
              border-radius: 12px; padding: 24px;
              page-break-inside: avoid;
              position: relative;
              overflow: hidden;
            }
            .card::before {
              content: ''; position: absolute; top: 0; left: 0; right: 0; height: 6px;
              background: ${escapeHtml(branding.primaryColor)};
            }
            .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; }
            .studio-name { font-size: 16px; font-weight: 700; color: #0f172a; margin: 0; }
            .project-name { font-size: 12px; color: #64748b; margin-top: 4px; }
            .logo { height: 32px; object-fit: contain; }
            .content { display: flex; gap: 24px; }
            .qr-code { width: 120px; height: 120px; flex-shrink: 0; }
            .details { flex: 1; }
            .subject-name { font-size: 20px; font-weight: 700; color: #0f172a; margin: 0 0 6px 0; }
            .subject-group { font-size: 12px; color: #64748b; margin: 0 0 12px 0; }
            .instructions { font-size: 13px; color: #475569; margin: 0 0 12px 0; line-height: 1.5; }
            .code-box {
              background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px;
              padding: 12px; text-align: center; margin-top: auto;
            }
            .code-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-bottom: 4px; }
            .code-value { font-size: 24px; font-weight: 700; color: #0f172a; letter-spacing: 0.1em; font-family: monospace; }
          </style>
        </head>
        <body>
          <div class="grid">
            ${filteredCards.map((card: any) => `
              <div class="card">
                <div class="header">
                  <div>
                    <div class="studio-name">${escapeHtml(branding.name)}</div>
                    <div class="project-name">${escapeHtml(projectName || "")}</div>
                  </div>
                  ${branding.logoObjectPath ? `<img src="${window.location.origin}/api/studio/branding/logo" class="logo" />` : ''}
                </div>
                <div class="content">
                  ${card.qrDataUrl ? `<img src="${card.qrDataUrl}" class="qr-code" />` : '<div class="qr-code" style="background:#f1f5f9"></div>'}
                  <div class="details">
                    <h3 class="subject-name">${escapeHtml(card.firstName || "")} ${escapeHtml(card.lastName || "")}</h3>
                    ${card.departmentName ? `<p class="subject-group">${escapeHtml(groupLabel)}: ${escapeHtml(card.departmentName)}</p>` : ""}
                    <p class="instructions">Scan the QR code or visit:<br/><strong>${window.location.host}/delivery</strong></p>
                    <div class="code-box">
                      <div class="code-label">Your Private Access Code</div>
                      <div class="code-value">${escapeHtml(card.accessCode || "")}</div>
                    </div>
                  </div>
                </div>
              </div>
            `).join("")}
          </div>
          <script>
            window.onload = () => { setTimeout(() => { window.print(); window.close(); }, 500); };
          </script>
        </body>
        </html>
      `);
      w.document.close();
    } finally {
      setPrintLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="relative max-w-sm w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search subjects or codes..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-slate-300 pl-10 pr-4 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
          />
        </div>
        <button
          onClick={handlePrint}
          disabled={printLoading || filteredCards.length === 0}
          className="flex items-center justify-center gap-2 rounded-lg bg-white border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {printLoading ? <Loader2 className="size-4 animate-spin" /> : <Printer className="size-4" />}
          Print {filteredCards.length} Cards
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {filteredCards.map((card: any) => (
          <div key={card.accessCode} className="flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-1 items-start gap-4 p-5">
              {card.qrDataUrl ? (
                <img src={card.qrDataUrl} alt="QR Code" className="size-20 shrink-0 rounded-lg border border-slate-100" />
              ) : (
                <div className="flex size-20 shrink-0 items-center justify-center rounded-lg bg-slate-100">
                  <QrCode className="size-8 text-slate-300" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <h4 className="truncate font-semibold text-slate-900" title={`${card.firstName} ${card.lastName}`}>
                  {card.firstName} {card.lastName}
                </h4>
                {card.departmentName && (
                  <div className="mt-1 truncate text-xs text-slate-500">
                    {groupLabel}: {card.departmentName}
                  </div>
                )}
                <div className="mt-2">
                  <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">{subjectLabel} Access Code</div>
                  <div className="mt-0.5 font-mono text-lg font-bold tracking-widest text-slate-700">{card.accessCode}</div>
                </div>
              </div>
            </div>
            {card.accessUrl && (
              <div className="border-t border-slate-100 bg-slate-50 p-3 flex justify-between items-center">
                <span className="truncate text-xs text-slate-500 pr-4">Direct link ready</span>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(card.accessUrl!);
                    alert("Link copied!");
                  }}
                  className="flex shrink-0 items-center gap-1.5 rounded bg-white px-2 py-1 text-xs font-medium text-teal-600 border border-teal-100 hover:bg-teal-50"
                >
                  <Copy className="size-3" /> Copy Link
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      
      {filteredCards.length === 0 && (
        <div className="rounded-xl border border-dashed border-slate-300 p-12 text-center text-slate-500">
          No access cards found matching your search.
        </div>
      )}
    </div>
  );
}

function OrdersTab({ projectId }: { projectId: number }) {
  const { data, isLoading } = useListDeliveryOrders(projectId);
  const updateFulfillment = useUpdateDeliveryFulfillment();
  const updatePayment = useUpdateDeliveryPayment();

  if (isLoading) {
    return <div className="flex items-center justify-center p-12 text-sm text-slate-500"><Loader2 className="mr-2 size-4 animate-spin" /> Loading orders...</div>;
  }

  const orders = data?.orders || [];

  if (orders.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center">
        <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-slate-100">
          <ShoppingBag className="size-6 text-slate-400" />
        </div>
        <h3 className="font-semibold text-slate-900">No orders yet</h3>
        <p className="mt-1 text-sm text-slate-500">Orders placed by customers will appear here.</p>
      </div>
    );
  }

  const statusColors: Record<string, string> = {
    pending: "bg-amber-100 text-amber-800 border-amber-200",
    paid: "bg-green-100 text-green-800 border-green-200",
    cancelled: "bg-slate-100 text-slate-800 border-slate-200",
    refunded: "bg-red-100 text-red-800 border-red-200",
  };
  
  const fulfillmentColors: Record<string, string> = {
    not_required: "bg-slate-100 text-slate-500 border-slate-200 opacity-50",
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
