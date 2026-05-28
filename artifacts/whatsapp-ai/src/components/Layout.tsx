import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  MessageSquare,
  BookOpen,
  Package,
  Settings,
  BarChart3,
  GitBranch,
  KeyRound,
  Users,
  Wifi,
  WifiOff,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  CircleDashed,
  LogOut,
  Sun,
  Moon,
  Monitor,
} from "lucide-react";
import { useTheme, type Theme } from "@/hooks/use-theme";
import { SiWhatsapp } from "react-icons/si";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useGetWhatsappStatus,
  useListChats,
  useLogout,
  getGetWhatsappStatusQueryKey,
  getListChatsQueryKey,
  getGetMeQueryKey,
  type AuthUser,
} from "@workspace/api-client-react";

import { usePermissions, type PermissionMenu } from "@/hooks/use-permissions";

type TeamRole = "super_admin" | "supervisor" | "agent";

// Nav menu definitions. The "menu" key maps to the per-role permission
// matrix (see hooks/use-permissions.ts) — a link is shown when the caller
// has canView=true for that menu. Super admin always sees everything (the
// matrix gates set them all true). Items with menu=null are always-visible
// (Dashboard + Agen are role-only).
const navItems: Array<{
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  // Either gated by the permission matrix (`menu`) or by a static role
  // list (`roles`). Items with neither are visible to everyone.
  menu?: PermissionMenu;
  roles?: TeamRole[];
}> = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, roles: ["super_admin", "supervisor"] },
  { href: "/chats", label: "Chats", icon: MessageSquare, menu: "chats" },
  { href: "/status", label: "Status", icon: CircleDashed, menu: "statuses" },
  { href: "/knowledge", label: "Knowledge Base", icon: BookOpen, menu: "knowledge" },
  { href: "/products", label: "Products", icon: Package, menu: "products" },
  { href: "/flows", label: "Chatbot Flow", icon: GitBranch, menu: "flows" },
  { href: "/analytics", label: "Analytics", icon: BarChart3, menu: "analytics" },
  { href: "/agents", label: "Agen & Tim", icon: Users, roles: ["super_admin", "supervisor", "agent"] },
  { href: "/credentials", label: "Credentials", icon: KeyRound, menu: "credentials" },
  { href: "/settings", label: "Settings", icon: Settings, menu: "settings" },
];

function useUnreadCount() {
  const { data: chats } = useListChats(
    {},
    { query: { queryKey: getListChatsQueryKey(), refetchInterval: 5000 } }
  );
  if (!chats) return 0;
  return chats.reduce((sum, c) => sum + (c.unreadCount ?? 0), 0);
}

function StatusBadge({ collapsed }: { collapsed: boolean }) {
  const { data: status } = useGetWhatsappStatus({
    query: { queryKey: getGetWhatsappStatusQueryKey(), refetchInterval: 5000 },
  });

  if (!status) return null;

  const isConnected = status.status === "connected";
  const isConnecting = status.status === "connecting" || status.status === "qr_ready";
  const label = isConnected
    ? status.phoneNumber ?? "Connected"
    : isConnecting
      ? "Connecting..."
      : "Disconnected";

  const dot = (
    <div
      className={cn(
        "flex items-center justify-center rounded-full",
        collapsed ? "w-8 h-8" : "w-6 h-6",
        isConnected
          ? "bg-primary/15 text-primary"
          : isConnecting
            ? "bg-yellow-500/15 text-yellow-400"
            : "bg-red-500/15 text-red-400"
      )}
    >
      {isConnected ? (
        <Wifi className="w-3 h-3" />
      ) : isConnecting ? (
        <Loader2 className="w-3 h-3 animate-spin" />
      ) : (
        <WifiOff className="w-3 h-3" />
      )}
    </div>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            data-testid="whatsapp-status-badge"
            className="flex justify-center"
          >
            {dot}
          </div>
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div
      data-testid="whatsapp-status-badge"
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium border",
        isConnected
          ? "bg-primary/10 text-primary border-primary/20"
          : isConnecting
            ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/20"
            : "bg-red-500/10 text-red-400 border-red-500/20"
      )}
    >
      {isConnected ? (
        <Wifi className="w-3 h-3" />
      ) : isConnecting ? (
        <Loader2 className="w-3 h-3 animate-spin" />
      ) : (
        <WifiOff className="w-3 h-3" />
      )}
      <span className="truncate">{label}</span>
    </div>
  );
}

const SIDEBAR_STORAGE_KEY = "vjchat:sidebar-collapsed";

export default function Layout({
  children,
  user,
}: {
  children: React.ReactNode;
  user?: AuthUser;
}) {
  const [location] = useLocation();
  const totalUnread = useUnreadCount();
  const queryClient = useQueryClient();
  const { menus: permMenus } = usePermissions();
  const logoutMut = useLogout({
    mutation: {
      onSettled: async () => {
        // Drop all cached per-user data so the next signed-in user can't
        // briefly see the previous user's chats / products / etc.
        await queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
        queryClient.clear();
      },
    },
  });

  // Persist collapse state across reloads so the user's preference sticks.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1";
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? "1" : "0");
    } catch {
      // ignore — private mode / quota etc shouldn't break the UI
    }
  }, [collapsed]);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      {/* Sidebar — collapses to a 56px icon rail like WhatsApp Web. */}
      <aside
        className={cn(
          "flex-shrink-0 flex flex-col border-r border-border bg-sidebar transition-[width] duration-200 ease-out",
          collapsed ? "w-14" : "w-56"
        )}
      >
        {/* Logo + collapse toggle */}
        <div
          className={cn(
            "flex items-center h-14 border-b border-border",
            collapsed ? "justify-center px-2" : "justify-between px-3 gap-2"
          )}
        >
          {!collapsed && (
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="flex items-center justify-center w-7 h-7 rounded-md bg-primary flex-shrink-0">
                <SiWhatsapp className="w-4 h-4 text-white" />
              </div>
              <span className="text-sm font-semibold text-foreground tracking-tight truncate">
                MaxiChat
              </span>
            </div>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-testid="button-toggle-sidebar"
                aria-label={collapsed ? "Buka sidebar" : "Sembunyikan sidebar"}
                onClick={() => setCollapsed((v) => !v)}
                className="flex items-center justify-center w-8 h-8 rounded-md text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
              >
                {collapsed ? (
                  <PanelLeftOpen className="w-4 h-4" />
                ) : (
                  <PanelLeftClose className="w-4 h-4" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {collapsed ? "Buka sidebar" : "Sembunyikan sidebar"}
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Nav */}
        <nav
          className={cn(
            "flex-1 py-3 space-y-0.5 overflow-y-auto",
            collapsed ? "px-1.5" : "px-2"
          )}
        >
          {navItems
            .filter((it) => {
              const tr = (user?.teamRole ?? "super_admin") as TeamRole;
              // Static-role items (Dashboard, Agen) are gated by `roles`.
              if (it.roles) return it.roles.includes(tr);
              // Matrix-gated items: super_admin always sees them; everyone
              // else needs canView=true. While the matrix is loading we
              // hide the link to avoid a flash of a forbidden page.
              if (it.menu) {
                if (tr === "super_admin") return true;
                return permMenus[it.menu]?.canView ?? false;
              }
              return true;
            })
            .map(({ href, label, icon: Icon }) => {
            const isActive =
              href === "/" ? location === "/" : location.startsWith(href);
            const isChats = href === "/chats";
            const showBadge = isChats && totalUnread > 0;
            const link = (
              <Link
                key={href}
                href={href}
                data-testid={`nav-${label.toLowerCase().replace(/\s/g, "-")}`}
                className={cn(
                  "flex items-center rounded-md text-sm font-medium transition-colors relative",
                  collapsed
                    ? "justify-center h-10 w-full"
                    : "gap-2.5 px-3 py-2",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                )}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                {!collapsed && <span className="flex-1">{label}</span>}
                {showBadge && !collapsed && (
                  <span
                    className={cn(
                      "inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold leading-none",
                      isActive
                        ? "bg-white text-primary"
                        : "bg-primary text-white"
                    )}
                  >
                    {totalUnread > 99 ? "99+" : totalUnread}
                  </span>
                )}
                {showBadge && collapsed && (
                  <span className="absolute top-1 right-1 min-w-[14px] h-[14px] px-1 rounded-full bg-primary text-white text-[9px] font-bold leading-none flex items-center justify-center">
                    {totalUnread > 9 ? "9+" : totalUnread}
                  </span>
                )}
              </Link>
            );
            if (collapsed) {
              return (
                <Tooltip key={href}>
                  <TooltipTrigger asChild>{link}</TooltipTrigger>
                  <TooltipContent side="right">{label}</TooltipContent>
                </Tooltip>
              );
            }
            return link;
          })}
        </nav>

        {/* Status */}
        <div
          className={cn(
            "border-t border-border",
            collapsed ? "px-2 py-3 flex justify-center" : "px-3 py-3"
          )}
        >
          <StatusBadge collapsed={collapsed} />
        </div>

        {/* Theme switcher: light / dark / system. Sits above the account
            row so it's reachable both when the sidebar is expanded
            (segmented control) and collapsed (single icon cycling through
            modes via tooltip). */}
        <div
          className={cn(
            "border-t border-border",
            collapsed ? "px-2 py-3 flex justify-center" : "px-3 py-3"
          )}
        >
          <ThemeSwitcher collapsed={collapsed} />
        </div>

        {/* Account: avatar + role/name/company + logout */}
        {user && (
          <div
            className={cn(
              "border-t border-border flex items-center",
              collapsed ? "px-2 py-3 justify-center" : "px-3 py-2.5 gap-2.5"
            )}
          >
            <AccountAvatar
              url={user.profilePhotoUrl}
              name={user.name ?? user.email}
            />
            {!collapsed && (
              <div
                className="flex-1 min-w-0 text-[11px] leading-tight"
                data-testid="account-email"
              >
                <div className="text-foreground/60 text-[10px]">
                  {user.teamRole === "super_admin"
                    ? "Super Admin"
                    : user.teamRole === "supervisor"
                      ? "Supervisor"
                      : "Agen"}
                </div>
                <div className="font-semibold truncate text-foreground/95">
                  {user.name ?? user.email}
                </div>
                {user.companyName && (
                  <div className="text-foreground/55 text-[10px] truncate">
                    {user.companyName}
                  </div>
                )}
              </div>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  data-testid="button-logout"
                  aria-label="Keluar"
                  disabled={logoutMut.isPending}
                  onClick={() => logoutMut.mutate()}
                  className="flex items-center justify-center w-8 h-8 rounded-md text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors disabled:opacity-60"
                >
                  {logoutMut.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <LogOut className="w-4 h-4" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">Keluar</TooltipContent>
            </Tooltip>
          </div>
        )}
      </aside>
      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {children}
      </main>
    </div>
  );
}

// Round account avatar shown in the sidebar footer. Falls back to a
// gradient circle with the user's initial when no photo is set so the
// row always renders something recognizable.
function AccountAvatar({
  url,
  name,
}: {
  url?: string | null;
  name?: string | null;
}) {
  const initial = (name?.trim()[0] ?? "?").toUpperCase();
  if (url) {
    return (
      <img
        src={url}
        alt={name ?? "Akun"}
        className="w-9 h-9 rounded-full object-cover ring-2 ring-sidebar-border flex-shrink-0"
        data-testid="account-avatar"
      />
    );
  }
  return (
    <div
      className="w-9 h-9 rounded-full bg-gradient-to-br from-orange-400 to-amber-500 flex items-center justify-center text-white text-sm font-bold flex-shrink-0 ring-2 ring-sidebar-border"
      data-testid="account-avatar-fallback"
      aria-label={name ?? "Akun"}
    >
      {initial}
    </div>
  );
}

// Tri-state theme switcher (Light / Dark / System) used in the sidebar
// footer. Expanded → segmented control with three icon buttons. Collapsed
// → single icon button cycling light → dark → system → light on click,
// with a tooltip surfacing the current mode.
function ThemeSwitcher({ collapsed }: { collapsed: boolean }) {
  const { theme, setTheme } = useTheme();
  const options: Array<{ value: Theme; label: string; Icon: typeof Sun }> = [
    { value: "light", label: "Terang", Icon: Sun },
    { value: "dark", label: "Gelap", Icon: Moon },
    { value: "system", label: "Sistem", Icon: Monitor },
  ];

  if (collapsed) {
    const current = options.find((o) => o.value === theme) ?? options[1];
    const Icon = current.Icon;
    const next: Theme =
      theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`Tema: ${current.label}. Klik untuk ganti.`}
            data-testid="button-theme-cycle"
            onClick={() => setTheme(next)}
            className="flex items-center justify-center w-8 h-8 rounded-md text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
          >
            <Icon className="w-4 h-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Tema: {current.label}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="theme-switcher">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/50">
        Tema
      </div>
      <div
        role="radiogroup"
        aria-label="Pilih tema"
        className="flex items-center bg-sidebar-accent/40 rounded-md p-0.5 gap-0.5"
      >
        {options.map(({ value, label, Icon }) => {
          const active = theme === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={label}
              data-testid={`button-theme-${value}`}
              onClick={() => setTheme(value)}
              className={cn(
                "flex-1 flex items-center justify-center gap-1 h-7 rounded text-[11px] font-medium transition-colors",
                active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/60"
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              <span className="hidden xl:inline">{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
