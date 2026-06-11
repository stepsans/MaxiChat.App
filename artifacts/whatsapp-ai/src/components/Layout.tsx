import { useEffect, useRef, useState } from "react";
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
  Wallet,
  Users,
  Sparkles,
  Wifi,
  WifiOff,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  CircleDashed,
  Target,
  BrainCircuit,
  LogOut,
  Camera,
  Cpu,
  ReceiptText,
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

import { usePermissions, type PermissionMenu } from "@/hooks/use-permissions";
import { useBillingStatus } from "@/hooks/use-billing-status";
import { ChannelSwitcher } from "@/components/ChannelSwitcher";
import { useChatNotificationSound } from "@/hooks/use-notification-sound";
import { AlertTriangle } from "lucide-react";

type TeamRole = "super_admin" | "supervisor" | "agent";

// Nav menu definitions. The "menu" key maps to the per-role permission
// matrix (see hooks/use-permissions.ts) — a link is shown when the caller
// has canView=true for that menu. Super admin always sees everything (the
// matrix gates set them all true). Items with no menu/roles are always
// visible.
type NavItem = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  // Either gated by the permission matrix (`menu`) or by a static role
  // list (`roles`). Items with neither are visible to everyone.
  menu?: PermissionMenu;
  roles?: TeamRole[];
  // When true, the item is additionally hidden unless the tenant has the
  // Enterprise AI Sales Assistant entitlement (AuthUser.hasAiSalesAssistant).
  requiresAiSalesAssistant?: boolean;
};

// Sidebar is organised into sections rendered with a divider (and an
// uppercase label when expanded) between each group. Daily conversation
// work sits at the very top; AI tools are isolated in their own section.
// A group whose items are all hidden for the current role is skipped
// entirely (no stray divider/label).
type NavGroup = { id: string; label?: string; items: NavItem[] };

const navGroups: NavGroup[] = [
  {
    id: "main",
    items: [
      { href: "/chats", label: "Chats", icon: MessageSquare, menu: "chats" },
      { href: "/status", label: "Status", icon: CircleDashed, menu: "statuses" },
    ],
  },
  {
    id: "ai",
    label: "AI",
    items: [
      { href: "/ai-studio", label: "AI Studio", icon: Sparkles, menu: "aiStudio" },
      { href: "/ai-review", label: "AI Review", icon: ReceiptText, menu: "aiReview" },
      { href: "/usage", label: "Pemakaian Token", icon: Cpu, menu: "usage" },
    ],
  },
  {
    id: "content",
    label: "Konten & Otomasi",
    items: [
      { href: "/knowledge", label: "Knowledge Base", icon: BookOpen, menu: "knowledge" },
      { href: "/products", label: "Products", icon: Package, menu: "products" },
      { href: "/flows", label: "Chatbot Flow", icon: GitBranch, menu: "flows" },
    ],
  },
  {
    id: "sales",
    label: "AI Sales Assistant",
    items: [
      {
        href: "/pipeline",
        label: "Pipeline",
        icon: Target,
        menu: "opportunities",
        requiresAiSalesAssistant: true,
      },
      {
        href: "/ai-pipeline",
        label: "AI Pipeline",
        icon: BrainCircuit,
        menu: "opportunities",
        requiresAiSalesAssistant: true,
      },
    ],
  },
  {
    id: "insights",
    label: "Laporan",
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard, menu: "dashboard" },
      { href: "/analytics", label: "Analytics", icon: BarChart3, menu: "analytics" },
    ],
  },
  {
    id: "admin",
    label: "Pengaturan",
    items: [
      { href: "/agents", label: "Agen & Tim", icon: Users, roles: ["super_admin", "supervisor", "agent"] },
      { href: "/billing", label: "Langganan", icon: Wallet, roles: ["super_admin"] },
      { href: "/credentials", label: "Credentials", icon: KeyRound, menu: "credentials" },
      { href: "/settings", label: "Settings", icon: Settings, menu: "settings" },
    ],
  },
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
  const isSyncing = status.status === "syncing";
  const isConnecting = status.status === "connecting" || status.status === "qr_ready";
  const label = isConnected
    ? status.phoneNumber ?? "Connected"
    : isSyncing
      ? "Sinkronisasi..."
      : isConnecting
        ? "Connecting..."
        : "Disconnected";

  const dotColor = isConnected
    ? "bg-primary/15 text-primary"
    : isSyncing || isConnecting
      ? "bg-yellow-500/15 text-yellow-400"
      : "bg-red-500/15 text-red-400";

  const dotIcon = isConnected ? (
    <Wifi className="w-3 h-3" />
  ) : isSyncing || isConnecting ? (
    <Loader2 className="w-3 h-3 animate-spin" />
  ) : (
    <WifiOff className="w-3 h-3" />
  );

  const dot = (
    <div
      className={cn(
        "flex items-center justify-center rounded-full",
        collapsed ? "w-8 h-8" : "w-6 h-6",
        dotColor,
      )}
    >
      {dotIcon}
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

  const badgeColor = isConnected
    ? "bg-primary/10 text-primary border-primary/20"
    : isSyncing || isConnecting
      ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/20"
      : "bg-red-500/10 text-red-400 border-red-500/20";

  return (
    <div
      data-testid="whatsapp-status-badge"
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium border",
        badgeColor,
      )}
    >
      {dotIcon}
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
  useChatNotificationSound();
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
                Maxichat.app
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

        {/* Channel switcher — multi-channel omnichannel header. */}
        <div
          className={cn(
            "border-b border-border",
            collapsed ? "p-2 flex justify-center" : "px-3 py-2"
          )}
        >
          <ChannelSwitcher collapsed={collapsed} />
        </div>

        {/* Nav */}
        <nav
          className={cn(
            "flex-1 py-3 overflow-y-auto",
            collapsed ? "px-1.5" : "px-2"
          )}
        >
          {(() => {
            const tr = (user?.teamRole ?? "agent") as TeamRole;
            const isVisible = (it: NavItem) => {
              // Enterprise AI Sales Assistant items are hidden entirely unless
              // the tenant has the entitlement, regardless of role/matrix.
              if (it.requiresAiSalesAssistant && !user?.hasAiSalesAssistant)
                return false;
              // Settings is always visible: every role has personal items
              // there (theme, bio, shortcuts). Every other matrix-gated item
              // (incl. AI Studio, Dashboard, AI Review, Pemakaian Token) goes
              // through the canView check below.
              if (it.menu === "settings") return true;
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
            };

            // Drop hidden items first, then drop any group left empty so a
            // section's divider/label never renders without links under it.
            const visibleGroups = navGroups
              .map((g) => ({ ...g, items: g.items.filter(isVisible) }))
              .filter((g) => g.items.length > 0);

            const renderItem = ({ href, label, icon: Icon }: NavItem) => {
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
            };

            return visibleGroups.map((group, gi) => (
              <div
                key={group.id}
                className={cn(gi > 0 && "mt-2 pt-2 border-t border-border/60")}
              >
                {!collapsed && group.label && (
                  <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/40">
                    {group.label}
                  </p>
                )}
                <div className="space-y-0.5">{group.items.map(renderItem)}</div>
              </div>
            ));
          })()}
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
              <Link
                href="/profile"
                className="flex-1 min-w-0 text-[11px] leading-tight hover:bg-sidebar-accent/40 rounded-md px-2 py-1 -mx-1 transition-colors"
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
              </Link>
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
      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        <ImpersonateBanner user={user} />
        <ReadOnlyBanner />
        {children}
      </main>
    </div>
  );
}

function ImpersonateBanner({ user }: { user?: AuthUser }) {
  const u = user as any;
  if (!u?.isImpersonated) return null;
  return (
    <div className="flex items-center justify-center gap-4 px-4 py-2.5 bg-amber-400 text-amber-900 text-sm font-medium sticky top-0 z-50">
      <AlertTriangle className="w-4 h-4 flex-shrink-0" />
      <span>
        Mode {u.impersonateMode === "read_only" ? "Read Only" : "Full Access"} — Anda melihat dashboard tenant ini sebagai Owner
      </span>
      <button
        onClick={async () => {
          await fetch("/api/admin/impersonate/stop", { method: "POST", credentials: "include" });
          window.location.href = "/";
        }}
        className="bg-amber-900 text-amber-100 px-3 py-1 rounded-lg text-xs font-semibold hover:bg-amber-800 ml-2"
      >
        Kembali ke Admin Panel
      </button>
    </div>
  );
}

// Tenant-wide read-only banner. Shown to every role when the owner's
// subscription has lapsed (expired/suspended). Viewing stays allowed; the
// banner explains why writes are blocked and tells members to contact the
// account owner.
function ReadOnlyBanner() {
  const { readOnly } = useBillingStatus();
  if (!readOnly) return null;
  return (
    <div
      data-testid="banner-read-only"
      className="flex items-start gap-2.5 px-4 py-2.5 bg-destructive/10 border-b border-destructive/30 text-destructive text-sm"
    >
      <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
      <div className="min-w-0">
        <span className="font-semibold">Mode baca-saja.</span>{" "}
        Langganan akun ini sudah tidak aktif, jadi pengiriman pesan, perubahan
        data, dan balasan otomatis dinonaktifkan. Hubungi pemilik akun untuk
        mengaktifkan kembali pada menu Langganan.
      </div>
    </div>
  );
}

// Round account avatar shown in the sidebar footer. Clicking it opens a
// file picker so the signed-in user — including super_admin, who has no
// row in the "Agen & Tim" page — can change their own photo. Two-step
// flow: upload bytes to /api/agents/upload-photo, then PATCH the new URL
// to /api/auth/me/photo and invalidate the cached /auth/me query.
function AccountAvatar({
  url,
  name,
}: {
  url?: string | null;
  name?: string | null;
}) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initial = (name?.trim()[0] ?? "?").toUpperCase();

  async function handleFile(file: File) {
    setError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const up = await fetch("/api/agents/upload-photo", {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!up.ok) throw new Error("Upload gagal");
      const { url: newUrl } = (await up.json()) as { url: string };
      const patch = await fetch("/api/auth/me/photo", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ profilePhotoUrl: newUrl }),
      });
      if (!patch.ok) throw new Error("Simpan foto gagal");
      await qc.invalidateQueries({ queryKey: getGetMeQueryKey() });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal mengganti foto");
    } finally {
      setUploading(false);
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          aria-label="Ganti foto profil"
          data-testid="button-change-photo"
          className="relative group w-9 h-9 rounded-full flex-shrink-0 ring-2 ring-sidebar-border overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:opacity-70"
        >
          {url ? (
            <img
              src={url}
              alt={name ?? "Akun"}
              className="w-full h-full object-cover"
              data-testid="account-avatar"
            />
          ) : (
            <div
              className="w-full h-full bg-gradient-to-br from-orange-400 to-amber-500 flex items-center justify-center text-white text-sm font-bold"
              data-testid="account-avatar-fallback"
              aria-hidden
            >
              {initial}
            </div>
          )}
          <div
            className={cn(
              "absolute inset-0 flex items-center justify-center bg-black/45 text-white transition-opacity",
              uploading ? "opacity-100" : "opacity-0 group-hover:opacity-100",
            )}
          >
            {uploading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Camera className="w-3.5 h-3.5" />
            )}
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              e.target.value = "";
            }}
            data-testid="input-account-photo"
          />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">
        {error ?? (uploading ? "Mengunggah…" : "Ganti foto profil")}
      </TooltipContent>
    </Tooltip>
  );
}
