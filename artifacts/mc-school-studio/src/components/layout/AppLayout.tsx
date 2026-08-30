import React from 'react';
import { Camera, LayoutDashboard, FolderKanban, LogOut, Users, ShieldCheck } from 'lucide-react';
import { useClerk, useUser } from '@clerk/react';
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { signOut } = useClerk();
  const { user } = useUser();
  const [location] = useLocation();
  const [isPlatformOwner, setIsPlatformOwner] = useState(false);

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

  const handleSignOut = () => {
    signOut({ redirectUrl: import.meta.env.BASE_URL.replace(/\/$/, '') || '/' });
  };

  const navItems = [
    { label: 'Dashboard', icon: LayoutDashboard, href: '/dashboard' },
    { label: 'Projects', icon: FolderKanban, href: '/dashboard' }, // We just link to dashboard for projects list, or we could have a separate route. Let's just use dashboard for both.
    { label: 'Team', icon: Users, href: '/team' },
    ...(isPlatformOwner ? [{ label: 'Platform', icon: ShieldCheck, href: '/platform' }] : []),
  ];

  return (
    <div className="flex min-h-[100dvh] w-full bg-slate-50">
      {/* Sidebar */}
      <aside className="w-64 bg-sidebar text-sidebar-foreground flex flex-col flex-shrink-0 sticky top-0 h-[100dvh]">
        <div className="h-16 flex items-center px-6 border-b border-sidebar-border/50">
          <Camera className="w-6 h-6 text-sidebar-primary mr-3" />
          <span className="font-semibold text-lg tracking-tight">MC Studio</span>
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
            <div className="w-8 h-8 rounded-full bg-sidebar-primary flex items-center justify-center text-sidebar-primary-foreground font-semibold flex-shrink-0">
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
