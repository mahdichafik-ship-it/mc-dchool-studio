import { useEffect, useState } from "react";
import { Building2, CheckCircle2, Loader2 } from "lucide-react";
import { useAuth, useUser } from "@clerk/react";
import { Link, useLocation, useParams } from "wouter";

type InviteData = { email: string; status: "pending" | "accepted" | "cancelled"; createdAt: string };

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function StudioInvite() {
  const { code = "" } = useParams<{ code: string }>();
  const { isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const [, setLocation] = useLocation();
  const [invite, setInvite] = useState<InviteData | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [website, setWebsite] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch(`/api/platform/invites/${encodeURIComponent(code)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("This invitation could not be found.");
        setInvite(await response.json() as InviteData);
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, [code]);

  async function complete(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/platform/invites/${encodeURIComponent(code)}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, website }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        setError(body.error ?? "Could not create your studio.");
        return;
      }
      setLocation("/dashboard");
    } finally {
      setSaving(false);
    }
  }

  const signInPath = `${basePath}/sign-in?redirect_url=${encodeURIComponent(`${basePath}/studio-invite/${code}`)}`;

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-8 shadow-lg">
        <div className="flex items-center gap-3"><div className="rounded-xl bg-teal-100 p-3 text-teal-700"><Building2 className="h-6 w-6" /></div><div><p className="text-sm font-semibold uppercase tracking-wide text-teal-700">MC School Studio</p><h1 className="text-2xl font-bold text-slate-900">Create your studio</h1></div></div>
        {loading || !isLoaded ? <div className="mt-8 flex items-center gap-2 text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Checking invitation…</div> : error ? <div className="mt-8 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div> : invite?.status !== "pending" ? <div className="mt-8 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">This invitation is no longer available. Ask the platform owner for a new invitation.</div> : !isSignedIn ? <div className="mt-8 space-y-5"><p className="text-slate-600">You’ve been invited to create and manage your own independent photography studio.</p><div className="rounded-lg bg-slate-50 p-4 text-sm text-slate-600">Invitation for <strong className="text-slate-900">{invite.email}</strong></div><Link href={signInPath} className="inline-flex h-10 w-full items-center justify-center rounded-md bg-teal-600 px-4 text-sm font-medium text-white hover:bg-teal-700">Sign in to continue</Link></div> : <form onSubmit={(event) => void complete(event)} className="mt-8 space-y-5"><div><p className="text-slate-600">Welcome, {user?.firstName || "there"}. Set up the studio page your schools and collaborators will use.</p><p className="mt-2 text-sm text-slate-500">Signed in as {user?.primaryEmailAddress?.emailAddress}</p></div><label className="block"><span className="text-sm font-medium text-slate-700">Studio name</span><input required minLength={2} maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="Atlas School Photography" className="mt-1 h-10 w-full rounded-md border border-slate-300 px-3 text-sm" /></label><label className="block"><span className="text-sm font-medium text-slate-700">Short description <span className="font-normal text-slate-400">(optional)</span></span><textarea maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="School portraits with a calm, organized workflow." className="mt-1 min-h-24 w-full resize-y rounded-md border border-slate-300 px-3 py-2 text-sm" /></label><label className="block"><span className="text-sm font-medium text-slate-700">Website <span className="font-normal text-slate-400">(optional)</span></span><input type="url" maxLength={200} value={website} onChange={(event) => setWebsite(event.target.value)} placeholder="https://yourstudio.com" className="mt-1 h-10 w-full rounded-md border border-slate-300 px-3 text-sm" /></label>{error && <p role="alert" className="text-sm text-red-700">{error}</p>}<button disabled={saving} className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-teal-600 px-4 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-60">{saving ? <><Loader2 className="h-4 w-4 animate-spin" />Creating studio…</> : <><CheckCircle2 className="h-4 w-4" />Create my studio</>}</button></form>}
      </div>
    </div>
  );
}