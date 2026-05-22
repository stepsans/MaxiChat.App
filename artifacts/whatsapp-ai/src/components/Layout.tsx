import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  MessageSquare,
  BookOpen,
  Package,
  Settings,
  BarChart3,
  Wifi,
  WifiOff,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  CircleDashed,
  LogOut,
} from "lucide-react";
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

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/chats", label: "Chats", icon: MessageSquare },
  { href: "/status", label: "Status", icon: CircleDashed },
  { href: "/knowledge", label: "Knowledge Base", icon: BookOpen },
  { href: "/products", label: "Products", icon: Package },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings },
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
                VJ-Chat
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
          {navItems.map(({ href, label, icon: Icon }) => {
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

        {/* Account: email + logout */}
        {user && (
          <div
            className={cn(
              "border-t border-border flex items-center",
              collapsed ? "px-2 py-3 justify-center" : "px-3 py-2 gap-2"
            )}
          >
            {!collapsed && (
              <div
                className="flex-1 min-w-0 text-[11px] leading-tight"
                data-testid="account-email"
              >
                <div className="text-foreground/60">Masuk sebagai</div>
                <div className="font-medium truncate text-foreground/90">
                  {user.email}
                </div>
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
