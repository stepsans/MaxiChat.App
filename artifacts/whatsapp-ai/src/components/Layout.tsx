import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  MessageSquare,
  BookOpen,
  Settings,
  BarChart3,
  Wifi,
  WifiOff,
  Loader2,
} from "lucide-react";
import { SiWhatsapp } from "react-icons/si";
import { cn } from "@/lib/utils";
import { useGetWhatsappStatus, useListChats } from "@workspace/api-client-react";

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/chats", label: "Chats", icon: MessageSquare },
  { href: "/knowledge", label: "Knowledge Base", icon: BookOpen },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings },
];

function useUnreadCount() {
  const { data: chats } = useListChats(
    {},
    { query: { refetchInterval: 5000 } }
  );
  if (!chats) return 0;
  return chats.reduce((sum, c) => sum + (c.unreadCount ?? 0), 0);
}

function StatusBadge() {
  const { data: status } = useGetWhatsappStatus({
    query: { refetchInterval: 5000 },
  });

  if (!status) return null;

  const isConnected = status.status === "connected";
  const isConnecting = status.status === "connecting" || status.status === "qr_ready";

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
      {isConnected
        ? status.phoneNumber ?? "Connected"
        : isConnecting
        ? "Connecting..."
        : "Disconnected"}
    </div>
  );
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const totalUnread = useUnreadCount();

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 flex flex-col border-r border-border bg-sidebar">
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-4 h-14 border-b border-border">
          <div className="flex items-center justify-center w-7 h-7 rounded-md bg-primary">
            <SiWhatsapp className="w-4 h-4 text-white" />
          </div>
          <span className="text-sm font-semibold text-foreground tracking-tight">
            Maxipro Assistant
          </span>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
          {navItems.map(({ href, label, icon: Icon }) => {
            const isActive =
              href === "/" ? location === "/" : location.startsWith(href);
            const isChats = href === "/chats";
            const showBadge = isChats && totalUnread > 0;
            return (
              <Link
                key={href}
                href={href}
                data-testid={`nav-${label.toLowerCase().replace(/\s/g, "-")}`}
                className={cn(
                  "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                )}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                <span className="flex-1">{label}</span>
                {showBadge && (
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
              </Link>
            );
          })}
        </nav>

        {/* Status */}
        <div className="px-3 py-3 border-t border-border">
          <StatusBadge />
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {children}
      </main>
    </div>
  );
}
