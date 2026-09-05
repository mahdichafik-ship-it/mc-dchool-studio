import React, { useEffect, useRef } from "react";
import { ClerkProvider, SignIn, SignUp, Show, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { Switch, Route, useLocation, Router as WouterRouter, Redirect } from 'wouter';
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";

import Landing from "./pages/Landing";
import Dashboard from "./pages/Dashboard";
import ProjectNew from "./pages/ProjectNew";
import ProjectOverview from "./pages/ProjectOverview";
import ProjectImport from "./pages/ProjectImport";
import ProjectQrPreview from "./pages/ProjectQrPreview";
import Team from "./pages/Team";
import DesktopConnect from "./pages/DesktopConnect";
import Platform from "./pages/Platform";
import StudioInvite from "./pages/StudioInvite";
import StudioSettings from "./pages/StudioSettings";
import PlatformStudio from "./pages/PlatformStudio";
import { AppLayout } from "./components/layout/AppLayout";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "#0d9488",      // teal-600
    colorForeground: "#0f172a",   // slate-900
    colorMutedForeground: "#64748b",
    colorDanger: "#dc2626",
    colorBackground: "#f8fafc",
    colorInput: "#ffffff",
    colorInputForeground: "#0f172a",
    colorNeutral: "#cbd5e1",
    fontFamily: "Inter, sans-serif",
    borderRadius: "0.5rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-white rounded-2xl w-[440px] max-w-full overflow-hidden shadow-lg",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-slate-900 font-bold",
    headerSubtitle: "text-slate-500",
    socialButtonsBlockButtonText: "text-slate-700",
    formFieldLabel: "text-slate-700 font-medium",
    footerActionLink: "text-teal-600 font-medium",
    footerActionText: "text-slate-500",
    dividerText: "text-slate-400",
    identityPreviewEditButton: "text-teal-600",
    formFieldSuccessText: "text-teal-600",
    alertText: "text-red-600",
    logoBox: "flex justify-center pt-2",
    logoImage: "h-10 w-auto",
    socialButtonsBlockButton: "border border-slate-200 bg-white hover:bg-slate-50",
    formButtonPrimary: "bg-teal-600 hover:bg-teal-700 text-white",
    formFieldInput: "border border-slate-200 bg-white text-slate-900",
    footerAction: "bg-slate-50",
    dividerLine: "bg-slate-200",
    alert: "bg-red-50 border border-red-200",
    otpCodeFieldInput: "border border-slate-200",
    formFieldRow: "",
    main: "",
  },
};

function SignInPage() {
  const redirectUrl = new URLSearchParams(window.location.search).get("redirect_url");
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-slate-50 px-4">
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
        fallbackRedirectUrl={redirectUrl || `${basePath}/dashboard`}
      />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-slate-50 px-4">
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
    </div>
  );
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const queryClient = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (
        prevUserIdRef.current !== undefined &&
        prevUserIdRef.current !== userId
      ) {
        queryClient.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, queryClient]);

  return null;
}

function HomeRedirect() {
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/dashboard" />
      </Show>
      <Show when="signed-out">
        <Landing />
      </Show>
    </>
  );
}

function AuthenticatedRoute({ component: Component }: { component: React.ComponentType }) {
  return (
    <>
      <Show when="signed-in">
        <AppLayout>
          <Component />
        </AppLayout>
      </Show>
      <Show when="signed-out">
        <Redirect to="/sign-in" />
      </Show>
    </>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={HomeRedirect} />
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignUpPage} />
      <Route path="/desktop/connect" component={DesktopConnect} />
      <Route path="/studio-invite/:code" component={StudioInvite} />
      
      <Route path="/dashboard" component={() => <AuthenticatedRoute component={Dashboard} />} />
      <Route path="/projects/new" component={() => <AuthenticatedRoute component={ProjectNew} />} />
      <Route path="/projects/:projectId" component={() => <AuthenticatedRoute component={ProjectOverview} />} />
      <Route path="/projects/:projectId/import" component={() => <AuthenticatedRoute component={ProjectImport} />} />
      <Route path="/projects/:projectId/qr-preview" component={() => <AuthenticatedRoute component={ProjectQrPreview} />} />
      <Route path="/team" component={() => <AuthenticatedRoute component={Team} />} />
      <Route path="/studio/settings" component={() => <AuthenticatedRoute component={StudioSettings} />} />
      <Route path="/platform" component={() => <AuthenticatedRoute component={Platform} />} />
      <Route path="/platform/studios/:studioId" component={() => <AuthenticatedRoute component={PlatformStudio} />} />
      
      <Route>
        <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-500">
          404 - Page not found
        </div>
      </Route>
    </Switch>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ClerkQueryClientCacheInvalidator />
          <Router />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
