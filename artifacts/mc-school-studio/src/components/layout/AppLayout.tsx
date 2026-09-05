import React from 'react';
import { Camera, LayoutDashboard, FolderKanban, LogOut, Users, ShieldCheck, Settings } from 'lucide-react';
import { useClerk, useUser } from '@clerk/react';
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { signOut } = useClerk();
  const { user } = useUser();
  const [location] = useLocation();
  const [isPlatformOwner, setIsPlatformOwner] = useState(false);
  const [canManageStudio, setCanManageStudio] = useState(false);
  const [studioBrand, setStudioBrand] = useState<{
    name: string;
    logoObjectPath: string | null;
    primaryColor: string;
    accentColor: string;
    brandingUpdatedAt: string | null;
  } | null>(null);

  useEffect(() => {
    let active = true;
    void fetch('/api/platform')
      .then((response) => {
        if (active) setIsPlatformOwner(response.ok);
      })
      .catch(() => {
        if (active) setIsPlatformOwner(false);
      });
    return () => { active = false; };
  }, [user?.id]);

  useEffect(() => {
    const updateBrand = (event: Event) => {
      setStudioBrand((event as CustomEvent<NonNullable<typeof studioBrand>>).detail);
    };
    window.addEventListener("studio-branding-updated", updateBrand);
    return () => window.removeEventListener("studio-branding-updated", updateBrand);
  }, []);

  useEffect(() => {
    let active = true;
    void fetch('/api/studio')
      .then(async (response) => response.ok ? response.json() as Promise<{
        member: { role: string; status: string };
        studio: { name: string; logoObjectPath: string | null; primaryColor: string; accentColor: string; brandingUpdatedAt: string | null };
      }> : null)
      .then((data) => {
        if (!active) return;
        setStudioBrand(data?.studio ?? null);
        setCanManageStudio(Boolean(
          data
          && data.member.status === 'active'
          && (data.member.role === 'owner' || data.member.role === 'admin'),
        ));
      })
      .catch(() => {
        if (active) setCanManageStudio(false);
      });
    return () => { active = false; };
  }, [user?.id]);

  const handleSignOut = () => {
    signOut({ redirectUrl: import.meta.env.BASE_URL.replace(/\/$/, '') || '/' });
  };

  const navItems = [
    { label: 'Dashboard', icon: LayoutDashboard, href: '/dashboard' },
    { label: 'Projects', icon: FolderKanban, href: '/dashboard' }, // We just link to dashboard for projects list, or we could have a separate route. Let's just use dashboard for both.
    { label: 'Team', icon: Users, href: '/team' },
    ...(canManageStudio ? [{ label: 'Studio settings', icon: Settings, href: '/studio/settings' }] : []),
    ...(isPlatformOwner ? [{ label: 'Platform', icon: ShieldCheck, href: '/platform' }] : []),
  ];

  return (
    <div className="flex min-h-[100dvh] w-full bg-slate-50">
      {/* Sidebar */}
      <aside className="w-64 bg-sidebar text-sidebar-foreground flex flex-col flex-shrink-0 sticky top-0 h-[100dvh]">
        <div className="h-16 flex items-center px-6 border-b border-sidebar-border/50" style={{ borderTop: studioBrand ? `3px solid ${studioBrand.accentColor}` : undefined }}>
          {studioBrand?.logoObjectPath ? <img src={`/api/studio/branding/logo?rev=${encodeURIComponent(studioBrand.brandingUpdatedAt ?? "")}`} alt="" className="mr-3 h-9 w-9 rounded-md bg-white object-contain p-1" /> : <img src="/volume-capture-logo.png" alt="" className="mr-3 h-9 w-9 rounded-md bg-black object-cover" />}
          <span className="truncate font-semibold text-lg tracking-tight">{studioBrand?.name ?? "Volume Capture"}</span>
        </div>
        
        <nav className="flex-1 px-4 py-6 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const isActive = location === item.href;
            return (
              <Link key={item.label} href={item.href}>
                <div className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors cursor-pointer ${isActive ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'hover:bg-sidebar-accent/50 text-sidebar-foreground/80 hover:text-sidebar-foreground'}`}>
                  <item.icon className="w-5 h-5" />
                  <span className="font-medium">{item.label}</span>
                </div>
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-sidebar-border/50">
          <div className="flex items-center gap-3 px-3 py-2 mb-2">
            <div className="w-8 h-8 rounded-full bg-sidebar-primary flex items-center justify-center text-white font-semibold flex-shrink-0" style={{ backgroundColor: studioBrand?.primaryColor }}>
              {user?.firstName?.charAt(0) || 'U'}
            </div>
            <div className="flex flex-col min-w-0 overflow-hidden">
              <span className="text-sm font-medium truncate">{user?.fullName || 'User'}</span>
              <span className="text-xs text-sidebar-foreground/60 truncate">{user?.primaryEmailAddress?.emailAddress}</span>
            </div>
          </div>
          <button
            onClick={handleSignOut}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-md transition-colors hover:bg-sidebar-accent/50 text-sidebar-foreground/80 hover:text-sidebar-foreground"
          >
            <LogOut className="w-5 h-5" />
            <span className="font-medium text-sm">Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {children}
      </main>
    </div>
  );
}
