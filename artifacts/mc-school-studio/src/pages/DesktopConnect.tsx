import { useAuth } from "@clerk/react";
import { CheckCircle2, Monitor, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

type State = "checking" | "signed-out" | "approving" | "approved" | "error";

export default function DesktopConnect() {
  const { isLoaded, isSignedIn } = useAuth();
  const [state, setState] = useState<State>("checking");
  const [message, setMessage] = useState("");
  const code = new URLSearchParams(window.location.search).get("code");
  const returnPath = `${window.location.pathname}${window.location.search}`;
  const signInPath = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/sign-in?redirect_url=${encodeURIComponent(returnPath)}`;

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      setState("signed-out");
      return;
    }
    if (!code) {
      setState("error");
      setMessage("This desktop sign-in link is missing its request code.");
      return;
    }

    let cancelled = false;
    setState("approving");
    fetch("/api/desktop/auth/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ code }),
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Could not approve this desktop sign-in.");
        if (!cancelled) setState("approved");
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState("error");
          setMessage(error instanceof Error ? error.message : "Could not approve this desktop sign-in.");
        }
      });
    return () => { cancelled = true; };
  }, [code, isLoaded, isSignedIn]);

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-6">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-teal-600">
          {state === "approved" ? <CheckCircle2 className="h-7 w-7 text-white" /> : <Monitor className="h-7 w-7 text-white" />}
        </div>
        {state === "approved" ? (
          <>
            <h1 className="text-2xl font-bold text-slate-900">Desktop app connected</h1>
            <p className="mt-3 text-sm leading-6 text-slate-500">
              You can close this browser tab and return to MC School Studio. The Mac app will finish signing in automatically.
            </p>
          </>
        ) : state === "signed-out" ? (
          <>
            <h1 className="text-2xl font-bold text-slate-900">Sign in to connect your Mac</h1>
            <p className="mt-3 text-sm leading-6 text-slate-500">
              Use your normal MC School Studio account. The desktop app will only receive the studio access allowed for that account.
            </p>
            <a href={signInPath} className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-teal-600 px-4 py-3 text-sm font-semibold text-white hover:bg-teal-700">
              Sign in securely
            </a>
          </>
        ) : state === "error" ? (
          <>
            <h1 className="text-2xl font-bold text-slate-900">Could not connect desktop app</h1>
            <p className="mt-3 text-sm leading-6 text-red-600">{message}</p>
            <p className="mt-4 text-xs text-slate-400">Return to the Mac app and start sign-in again.</p>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-bold text-slate-900">
              {state === "approving" ? "Connecting your Mac…" : "Preparing secure sign-in…"}
            </h1>
            <p className="mt-3 text-sm leading-6 text-slate-500">
              {state === "approving"
                ? "Your signed-in studio account is being checked."
                : "Please wait a moment."}
            </p>
          </>
        )}
        <div className="mt-7 flex items-center justify-center gap-2 text-xs text-slate-400">
          <ShieldCheck className="h-4 w-4 text-teal-600" />
          One-time browser authorization
        </div>
      </div>
    </div>
  );
}