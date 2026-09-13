import React, { useState } from "react";
import { 
  useGetMarketingOverview, 
  useListMarketingContacts,
  useUpdateMarketingConsent,
  useUnsubscribeMarketingContact,
  useListMarketingTemplates,
  useListMarketingCampaigns,
  useGetMarketingEmailStatus,
  useSendMarketingCampaign,
  useCreateMarketingTemplate,
  useUpdateMarketingTemplate,
  useDeleteMarketingTemplate,
  useCreateMarketingCampaignDraft,
  getGetMarketingOverviewQueryKey,
  getListMarketingContactsQueryKey,
  getListMarketingTemplatesQueryKey,
  getListMarketingCampaignsQueryKey,
  type MarketingContactResponse,
  type MarketingTemplate,
  type MarketingCampaign
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Users,
  Search,
  CheckCircle2,
  XCircle,
  Activity,
  FileText,
  Megaphone,
  Plus,
  Mail,
  MoreVertical,
  Calendar,
  AlertCircle
  ,Send
} from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";

// We'll use custom tabs for cleaner aesthetic
function TabsList({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-6 border-b border-slate-200 px-6 overflow-x-auto">{children}</div>;
}

function TabTrigger({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`whitespace-nowrap pb-4 pt-5 text-sm font-medium transition-colors border-b-2 ${
        active 
          ? "border-teal-600 text-teal-600" 
          : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700"
      }`}
    >
      {children}
    </button>
  );
}

export default function Marketing() {
  const [activeTab, setActiveTab] = useState<"overview" | "campaigns" | "templates">("overview");

  return (
    <div className="flex h-full flex-col bg-white">
      <header className="border-b border-slate-200 bg-white">
        <div className="px-6 py-6">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Marketing</h1>
          <p className="mt-1 text-sm text-slate-500">
            Monitor gallery engagement, manage contacts, and prepare email campaigns.
          </p>
        </div>
        <TabsList>
          <TabTrigger active={activeTab === "overview"} onClick={() => setActiveTab("overview")}>
            <div className="flex items-center gap-2">
              <Activity className="size-4" />
              Contacts & Metrics
            </div>
          </TabTrigger>
          <TabTrigger active={activeTab === "campaigns"} onClick={() => setActiveTab("campaigns")}>
            <div className="flex items-center gap-2">
              <Megaphone className="size-4" />
              Campaigns
            </div>
          </TabTrigger>
          <TabTrigger active={activeTab === "templates"} onClick={() => setActiveTab("templates")}>
            <div className="flex items-center gap-2">
              <FileText className="size-4" />
              Templates
            </div>
          </TabTrigger>
        </TabsList>
      </header>

      <main className="flex-1 overflow-y-auto bg-slate-50/50 p-6">
        <div className="mx-auto max-w-6xl">
          {activeTab === "overview" && <MarketingOverview />}
          {activeTab === "campaigns" && <MarketingCampaigns />}
          {activeTab === "templates" && <MarketingTemplates />}
        </div>
      </main>
    </div>
  );
}

// -----------------------------------------------------------------------------
// OVERVIEW & CONTACTS
// -----------------------------------------------------------------------------

function MarketingOverview() {
  const { data: overview, isLoading: overviewLoading } = useGetMarketingOverview();
  
  const [search, setSearch] = useState("");
  const [engagement, setEngagement] = useState<"all" | "visited" | "repeat" | "purchaser">("all");
  const [consent, setConsent] = useState<"all" | "consented" | "unconsented">("all");
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const { data: contactsData, isLoading: contactsLoading } = useListMarketingContacts({
    search: search || undefined,
    engagement,
    consent,
    page,
    pageSize
  });

  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const updateConsent = useUpdateMarketingConsent();
  const unsubscribeContact = useUnsubscribeMarketingContact();

  function refreshMarketingData() {
    void queryClient.invalidateQueries({ queryKey: getGetMarketingOverviewQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListMarketingContactsQueryKey() });
  }

  function toggleConsent(contact: MarketingContactResponse, newConsent: boolean) {
    updateConsent.mutate(
      { contactId: contact.id, data: { consented: newConsent, source: "studio_manual" } },
      {
        onSuccess: () => {
          refreshMarketingData();
          toast({
            title: "Consent updated",
            description: `Marketing consent for ${contact.email} is now ${newConsent ? "granted" : "revoked"}.`
          });
        }
      }
    );
  }

  function markUnsubscribed(contact: MarketingContactResponse) {
    unsubscribeContact.mutate(
      { contactId: contact.id },
      {
        onSuccess: () => {
          refreshMarketingData();
          toast({
            title: "Contact unsubscribed",
            description: `${contact.email} will be excluded from promotional campaigns.`,
          });
        },
      },
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard 
          title="Total Contacts" 
          value={overview?.uniqueContacts ?? "-"} 
          loading={overviewLoading}
        />
        <MetricCard 
          title="Identified Visits"
          value={overview?.identifiedVisits ?? "-"}
          loading={overviewLoading}
        />
        <MetricCard
          title="Repeat Visitors"
          value={overview?.repeatVisitors ?? "-"}
          loading={overviewLoading}
        />
        <MetricCard
          title="Purchasers"
          value={overview?.purchasers ?? "-"}
          loading={overviewLoading}
        />
        <MetricCard
          title="Conversion Rate"
          value={overview ? `${(overview.conversionRate * 100).toFixed(1)}%` : "-"}
          loading={overviewLoading}
        />
        <MetricCard
          title="Consented"
          value={overview?.consentedContacts ?? "-"} 
          loading={overviewLoading}
          valueColor="text-teal-600"
        />
        <MetricCard 
          title="Unsubscribed" 
          value={overview?.unsubscribedContacts ?? "-"} 
          loading={overviewLoading}
          valueColor="text-red-600"
        />
      </div>

      {overview && overview.projects.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 p-5">
            <h2 className="text-lg font-semibold text-slate-900">Performance by project</h2>
            <p className="mt-1 text-sm text-slate-500">Compare gallery interest and paid-order conversion across school and corporate projects.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-5 py-3 font-medium">Project</th>
                  <th className="px-5 py-3 font-medium">Type</th>
                  <th className="px-5 py-3 text-right font-medium">Visits</th>
                  <th className="px-5 py-3 text-right font-medium">Contacts</th>
                  <th className="px-5 py-3 text-right font-medium">Purchasers</th>
                  <th className="px-5 py-3 text-right font-medium">Conversion</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {overview.projects.map((project) => (
                  <tr key={project.projectId} className="transition-colors hover:bg-slate-50/70">
                    <td className="px-5 py-4 font-medium text-slate-900">{project.projectName}</td>
                    <td className="px-5 py-4 capitalize text-slate-500">{project.projectType}</td>
                    <td className="px-5 py-4 text-right text-slate-700">{project.identifiedVisits}</td>
                    <td className="px-5 py-4 text-right text-slate-700">{project.uniqueContacts}</td>
                    <td className="px-5 py-4 text-right text-slate-700">{project.purchasers}</td>
                    <td className="px-5 py-4 text-right font-medium text-slate-900">{(project.conversionRate * 100).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-4 border-b border-slate-200 p-5 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg font-semibold text-slate-900">Contact Directory</h2>
          
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
              <input 
                type="text"
                placeholder="Search emails..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                className="h-9 rounded-md border border-slate-300 pl-9 pr-3 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 w-full sm:w-64"
              />
            </div>
            
            <select
              value={engagement}
              onChange={(e) => { setEngagement(e.target.value as any); setPage(1); }}
              className="h-9 rounded-md border border-slate-300 bg-white px-3 py-1 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
            >
              <option value="all">All Engagement</option>
              <option value="visited">Visited Gallery</option>
              <option value="repeat">Repeat Visitor</option>
              <option value="purchaser">Purchaser</option>
            </select>
            
            <select
              value={consent}
              onChange={(e) => { setConsent(e.target.value as any); setPage(1); }}
              className="h-9 rounded-md border border-slate-300 bg-white px-3 py-1 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
            >
              <option value="all">All Consent Status</option>
              <option value="consented">Consented</option>
              <option value="unconsented">No Consent / Unsubscribed</option>
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-5 py-3 font-medium">Email</th>
                <th className="px-5 py-3 font-medium">First Seen</th>
                <th className="px-5 py-3 font-medium">Gallery Accesses</th>
                <th className="px-5 py-3 font-medium">Last Order</th>
                <th className="px-5 py-3 font-medium text-right">Marketing Consent</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {contactsLoading ? (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-slate-500">Loading contacts...</td>
                </tr>
              ) : contactsData?.contacts.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-slate-500">No contacts found matching your criteria.</td>
                </tr>
              ) : (
                contactsData?.contacts.map((contact) => (
                  <tr key={contact.id} className="hover:bg-slate-50/50 transition-colors">
                    <td className="px-5 py-4 font-medium text-slate-900">{contact.email}</td>
                    <td className="px-5 py-4 text-slate-500">{format(new Date(contact.firstSeenAt), "MMM d, yyyy")}</td>
                    <td className="px-5 py-4 text-slate-500">{contact.successfulGalleryAccesses}</td>
                    <td className="px-5 py-4 text-slate-500">
                      {contact.lastOrderAt ? format(new Date(contact.lastOrderAt), "MMM d, yyyy") : "-"}
                    </td>
                    <td className="px-5 py-4 text-right">
                      <div className="flex flex-wrap justify-end gap-2">
                        <button
                          onClick={() => toggleConsent(contact, !(contact.marketingConsent === true && !contact.unsubscribedAt))}
                          className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-1"
                          style={{
                            backgroundColor: contact.marketingConsent === true && !contact.unsubscribedAt ? "#f0fdfa" : "#f1f5f9",
                            color: contact.marketingConsent === true && !contact.unsubscribedAt ? "#0f766e" : "#64748b",
                          }}
                        >
                          {contact.marketingConsent === true && !contact.unsubscribedAt ? (
                            <><CheckCircle2 className="size-3.5" /> Consented</>
                          ) : contact.unsubscribedAt ? (
                            <><XCircle className="size-3.5 text-red-500" /> Unsubscribed</>
                          ) : (
                            <><AlertCircle className="size-3.5" /> Unknown</>
                          )}
                        </button>
                        {!contact.unsubscribedAt && (
                          <button
                            type="button"
                            onClick={() => markUnsubscribed(contact)}
                            disabled={unsubscribeContact.isPending}
                            className="rounded-full border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-500 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
                          >
                            Unsubscribe
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {contactsData && contactsData.totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-slate-200 px-5 py-3">
            <span className="text-sm text-slate-500">
              Showing page {contactsData.page} of {contactsData.totalPages}
            </span>
            <div className="flex gap-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage(p => p - 1)}
                className="rounded border border-slate-300 px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Previous
              </button>
              <button
                disabled={page >= contactsData.totalPages}
                onClick={() => setPage(p => p + 1)}
                className="rounded border border-slate-300 px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MetricCard({ title, value, loading, valueColor = "text-slate-900" }: { title: string; value: string | number; loading?: boolean; valueColor?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="text-sm font-medium text-slate-500">{title}</h3>
      <div className={`mt-2 text-3xl font-bold ${valueColor}`}>
        {loading ? <span className="animate-pulse bg-slate-200 text-transparent rounded">0000</span> : value}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// CAMPAIGNS
// -----------------------------------------------------------------------------

function MarketingCampaigns() {
  const { data, isLoading } = useListMarketingCampaigns();
  const { data: templatesData } = useListMarketingTemplates();
  const { data: emailStatus } = useGetMarketingEmailStatus();
  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [audienceEngagement, setAudienceEngagement] = useState<"all" | "visited" | "repeat" | "purchaser">("all");
  
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createCampaign = useCreateMarketingCampaignDraft();
  const sendCampaign = useSendMarketingCampaign();

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name || !templateId) return;
    
    createCampaign.mutate(
      {
        data: {
          name,
          templateId: Number(templateId),
          audienceFilter: {
            engagement: audienceEngagement,
            consent: "consented",
          }
        }
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMarketingCampaignsQueryKey() });
          setIsCreating(false);
          setName("");
          setTemplateId("");
          toast({ title: "Draft campaign created" });
        }
      }
    );
  }

  function handleSend(campaign: MarketingCampaign) {
    if (!window.confirm(`Send “${campaign.name}” to ${campaign.recipientCount} currently eligible contacts? This cannot be undone.`)) return;
    sendCampaign.mutate(
      { campaignId: campaign.id },
      {
        onSuccess: ({ sentCount }) => {
          queryClient.invalidateQueries({ queryKey: getListMarketingCampaignsQueryKey() });
          toast({
            title: "Campaign sent",
            description: `${sentCount} consented contact${sentCount === 1 ? "" : "s"} received the email.`,
          });
        },
        onError: (error) => {
          queryClient.invalidateQueries({ queryKey: getListMarketingCampaignsQueryKey() });
          toast({
            title: "Campaign could not be sent",
            description: error instanceof Error ? error.message : "Resend rejected the campaign.",
            variant: "destructive",
          });
        },
      },
    );
  }

  return (
    <div className="space-y-6">
      <div className={`rounded-xl border p-5 shadow-sm ${emailStatus?.configured ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
        <div className="flex gap-4">
          <Mail className={`size-6 shrink-0 ${emailStatus?.configured ? "text-emerald-600" : "text-amber-600"}`} />
          <div>
            <h3 className={`text-sm font-bold ${emailStatus?.configured ? "text-emerald-900" : "text-amber-900"}`}>
              {emailStatus?.configured ? "Resend is ready" : "Resend sender setup is incomplete"}
            </h3>
            <p className={`mt-1 text-sm ${emailStatus?.configured ? "text-emerald-800" : "text-amber-800"}`}>
              {emailStatus?.configured
                ? `Campaigns will be sent from ${emailStatus.fromEmail}. Eligible recipients are checked again immediately before sending.`
                : "Add RESEND_FROM_EMAIL after verifying a sender domain in Resend. Draft preparation remains available."}
            </p>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">Campaign Drafts</h2>
        <button
          onClick={() => setIsCreating(true)}
          className="flex items-center gap-2 rounded-md bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700"
        >
          <Plus className="size-4" />
          New Draft
        </button>
      </div>

      {isCreating && (
        <form onSubmit={handleCreate} className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h3 className="mb-4 font-semibold text-slate-900">Create Campaign Draft</h3>
          
          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-4">
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Campaign Name</span>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={e => setName(e.target.value)}
                  className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
                  placeholder="e.g. Fall Mini Sessions Announce"
                />
              </label>

              <label className="block">
                <span className="text-sm font-medium text-slate-700">Template</span>
                <select
                  required
                  value={templateId}
                  onChange={e => setTemplateId(e.target.value)}
                  className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
                >
                  <option value="">Select a template...</option>
                  {templatesData?.map(t => (
                    <option key={t.id} value={t.id}>{t.name} ({t.category})</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="space-y-4">
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Audience Engagement</span>
                <select
                  value={audienceEngagement}
                  onChange={e => setAudienceEngagement(e.target.value as any)}
                  className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
                >
                  <option value="all">Everyone</option>
                  <option value="visited">Visited a Gallery</option>
                  <option value="repeat">Repeat Visitors</option>
                  <option value="purchaser">Purchased Before</option>
                </select>
              </label>

              <div className="rounded-lg border border-teal-200 bg-teal-50 p-4">
                <p className="text-sm font-medium text-teal-900">Consented contacts only</p>
                <p className="mt-1 text-xs leading-5 text-teal-800">
                  Draft audiences always exclude contacts without marketing consent and anyone who has unsubscribed.
                </p>
              </div>
            </div>
          </div>

          <div className="mt-6 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setIsCreating(false)}
              className="rounded-md px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createCampaign.isPending}
              className="rounded-md bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
            >
              {createCampaign.isPending ? "Computing..." : "Create Draft"}
            </button>
          </div>
        </form>
      )}

      {isLoading ? (
        <div className="flex justify-center p-8 text-slate-500">Loading campaigns...</div>
      ) : data?.campaigns?.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center shadow-sm">
          <Megaphone className="mx-auto size-12 text-slate-300" />
          <h3 className="mt-4 text-lg font-medium text-slate-900">No campaigns yet</h3>
          <p className="mt-2 text-sm text-slate-500">Create your first campaign draft to calculate audience sizes.</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {data?.campaigns?.map(campaign => {
            const template = templatesData?.find(t => t.id === campaign.templateId);
            return (
              <div key={campaign.id} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition-shadow hover:shadow-md flex flex-col">
                <div className="mb-2 flex items-center justify-between">
                  <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-800 capitalize">
                    {campaign.status}
                  </span>
                  <span className="text-xs text-slate-500">
                    {format(new Date(campaign.createdAt), "MMM d")}
                  </span>
                </div>
                <h3 className="text-base font-semibold text-slate-900">{campaign.name}</h3>
                <p className="mt-1 text-sm text-slate-500 line-clamp-1">{template?.subject ?? "Unknown template"}</p>
                
                <div className="mt-auto pt-6 flex items-end justify-between gap-4">
                  <div>
                    <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Recipients</p>
                    <p className="text-2xl font-bold text-slate-900 mt-0.5">
                      {campaign.status === "sent" ? campaign.sentCount : campaign.recipientCount}
                    </p>
                  </div>
                  {campaign.status === "draft" ? (
                    <button
                      type="button"
                      onClick={() => handleSend(campaign)}
                      disabled={!emailStatus?.configured || campaign.recipientCount < 1 || sendCampaign.isPending}
                      className="inline-flex items-center gap-2 rounded-md bg-teal-600 px-3 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Send className="size-4" />
                      {sendCampaign.isPending ? "Sending..." : "Send now"}
                    </button>
                  ) : (
                    <span className={`text-xs font-medium ${campaign.status === "failed" ? "text-red-600" : "text-slate-500"}`}>
                      {campaign.status === "sent" && campaign.sentAt
                        ? `Sent ${format(new Date(campaign.sentAt), "MMM d")}`
                        : campaign.status === "sending"
                          ? "Sending…"
                          : campaign.lastError || "Send failed"}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// TEMPLATES
// -----------------------------------------------------------------------------

function MarketingTemplates() {
  const { data, isLoading } = useListMarketingTemplates();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const createTemplate = useCreateMarketingTemplate();
  const updateTemplate = useUpdateMarketingTemplate();
  const deleteTemplate = useDeleteMarketingTemplate();

  const [form, setForm] = useState({ name: "", subject: "", bodyText: "", category: "marketing" });

  function resetForm() {
    setForm({ name: "", subject: "", bodyText: "", category: "marketing" });
    setIsCreating(false);
    setEditingId(null);
  }

  function startEdit(template: MarketingTemplate) {
    setForm({
      name: template.name,
      subject: template.subject,
      bodyText: template.bodyText,
      category: template.category
    });
    setEditingId(template.id);
    setIsCreating(false);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (editingId) {
      updateTemplate.mutate(
        { templateId: editingId, data: form },
        {
          onSuccess: (res) => {
            queryClient.setQueryData(getListMarketingTemplatesQueryKey(), (old: any) => {
              if (!old) return old;
              return old.map((t: any) => t.id === editingId ? res : t);
            });
            toast({ title: "Template updated" });
            resetForm();
          }
        }
      );
    } else {
      createTemplate.mutate(
        { data: form },
        {
          onSuccess: (res) => {
            queryClient.setQueryData(getListMarketingTemplatesQueryKey(), (old: any) => {
              if (!old) return [res];
              return [...old, res];
            });
            toast({ title: "Template created" });
            resetForm();
          }
        }
      );
    }
  }

  function handleDelete(id: number) {
    if (!confirm("Are you sure you want to delete this template?")) return;
    deleteTemplate.mutate(
      { templateId: id },
      {
        onSuccess: () => {
          queryClient.setQueryData(getListMarketingTemplatesQueryKey(), (old: any) => {
            if (!old) return old;
            return old.filter((t: any) => t.id !== id);
          });
          toast({ title: "Template deleted" });
        }
      }
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">Email Templates</h2>
        {!isCreating && !editingId && (
          <button
            onClick={() => { resetForm(); setIsCreating(true); }}
            className="flex items-center gap-2 rounded-md bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700"
          >
            <Plus className="size-4" />
            New Template
          </button>
        )}
      </div>

      {(isCreating || editingId) && (
        <form onSubmit={handleSubmit} className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h3 className="mb-4 font-semibold text-slate-900">{editingId ? "Edit Template" : "Create Template"}</h3>
          
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Internal Name</span>
                <input
                  type="text"
                  required
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
                  placeholder="e.g. Black Friday Sale"
                />
              </label>

              <label className="block">
                <span className="text-sm font-medium text-slate-700">Category</span>
                <select
                  required
                  value={form.category}
                  onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                  className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
                >
                  <option value="marketing">Marketing</option>
                  <option value="transactional">Transactional</option>
                  <option value="followup">Follow-up</option>
                </select>
              </label>
            </div>

            <label className="block">
              <span className="text-sm font-medium text-slate-700">Email Subject</span>
              <input
                type="text"
                required
                value={form.subject}
                onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
                placeholder="e.g. Your photos are ready!"
              />
            </label>

            <label className="block">
              <span className="text-sm font-medium text-slate-700">Body Text (Plain text / Markdown)</span>
              <textarea
                required
                rows={8}
                value={form.bodyText}
                onChange={e => setForm(f => ({ ...f, bodyText: e.target.value }))}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 font-mono"
                placeholder="Hi {{firstName}},&#10;&#10;We're excited to announce..."
              />
            </label>
          </div>

          <div className="mt-6 flex justify-end gap-3">
            <button
              type="button"
              onClick={resetForm}
              className="rounded-md px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createTemplate.isPending || updateTemplate.isPending}
              className="rounded-md bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
            >
              {createTemplate.isPending || updateTemplate.isPending ? "Saving..." : "Save Template"}
            </button>
          </div>
        </form>
      )}

      {isLoading ? (
        <div className="flex justify-center p-8 text-slate-500">Loading templates...</div>
      ) : data?.length === 0 && !isCreating ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center shadow-sm">
          <FileText className="mx-auto size-12 text-slate-300" />
          <h3 className="mt-4 text-lg font-medium text-slate-900">No templates yet</h3>
          <p className="mt-2 text-sm text-slate-500">Create message templates to reuse in your campaigns.</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {data?.map(template => (
            <div key={template.id} className="rounded-xl border border-slate-200 bg-white shadow-sm flex flex-col overflow-hidden">
              <div className="p-5 flex-1">
                <div className="mb-2 flex items-center justify-between">
                  <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-800 capitalize">
                    {template.category}
                  </span>
                </div>
                <h3 className="text-base font-semibold text-slate-900">{template.name}</h3>
                <p className="mt-1 text-sm font-medium text-slate-700 line-clamp-1">{template.subject}</p>
                <p className="mt-3 text-sm text-slate-500 line-clamp-3 font-mono text-xs bg-slate-50 p-2 rounded">{template.bodyText}</p>
              </div>
              <div className="border-t border-slate-100 bg-slate-50 px-5 py-3 flex justify-end gap-4">
                <button
                  onClick={() => startEdit(template)}
                  className="text-sm font-medium text-teal-600 hover:text-teal-700"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(template.id)}
                  className="text-sm font-medium text-red-600 hover:text-red-700"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
