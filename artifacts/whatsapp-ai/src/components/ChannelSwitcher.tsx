import { Link } from "wouter";
import { Check, ChevronDown, Layers, Plus, Settings2, Wifi, WifiOff } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useActiveChannel } from "@/contexts/ChannelContext";
import { usePermissions } from "@/hooks/use-permissions";

function ChannelStatusDot({ status }: { status: string }) {
  const isConnected = status === "connected" || status === "syncing";
  return (
    <span
      className={cn(
        "inline-block w-1.5 h-1.5 rounded-full flex-shrink-0",
        isConnected ? "bg-emerald-500" : "bg-zinc-400"
      )}
      title={isConnected ? "Terhubung" : "Tidak terhubung"}
    />
  );
}

// Compact dropdown shown in the sidebar header. Color dot reflects the
// active channel (or a neutral grey for "All channels"); label shows the
// channel name. "All channels" is always offered when the user has 2+
// channels — for a single-channel account it's pointless.
export function ChannelSwitcher({ collapsed }: { collapsed: boolean }) {
  const { channels, activeChannelId, activeChannel, setActiveChannelId } =
    useActiveChannel();
  const { menus } = usePermissions();
  const canCreate = menus.channels.canCreate;
  const canViewChannels = menus.channels.canView;

  // No channels yet: an invited member who can create still needs a way to
  // reach the add flow (the dropdown below only renders once they have at
  // least one). Offer a compact add affordance; otherwise render nothing.
  if (channels.length === 0) {
    if (!canCreate) return null;
    return (
      <Link
        href="/channels?add=1"
        data-testid="channel-add-link-empty"
        className={cn(
          "flex items-center gap-2 rounded-md border border-border bg-background/40 hover:bg-sidebar-accent transition-colors",
          collapsed ? "w-9 h-9 justify-center p-0" : "w-full px-2 py-1.5"
        )}
        aria-label="Tambah channel"
      >
        <Plus className="w-3.5 h-3.5 text-foreground/70 flex-shrink-0" />
        {!collapsed && (
          <span className="flex-1 min-w-0 text-xs font-medium text-foreground/90 truncate text-left">
            Tambah channel
          </span>
        )}
      </Link>
    );
  }

  const isAll = activeChannelId === "all";
  const dotColor = isAll ? "#94a3b8" : activeChannel?.color ?? "#94a3b8";
  const label = isAll
    ? "Semua channel"
    : activeChannel?.label ?? channels[0]?.label ?? "Channel";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="channel-switcher-trigger"
          aria-label="Pilih channel"
          className={cn(
            "flex items-center gap-2 rounded-md border border-border bg-background/40 hover:bg-sidebar-accent transition-colors",
            collapsed ? "w-9 h-9 justify-center p-0" : "w-full px-2 py-1.5"
          )}
        >
          <span
            className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
            style={{ backgroundColor: dotColor }}
            aria-hidden="true"
          />
          {!collapsed && (
            <>
              <span className="flex-1 min-w-0 text-xs font-medium text-foreground/90 truncate text-left">
                {label}
              </span>
              <ChevronDown className="w-3.5 h-3.5 text-foreground/50 flex-shrink-0" />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-foreground/55">
          Channel aktif
        </DropdownMenuLabel>
        {channels.map((c) => {
          const selected = activeChannelId === c.id;
          const isConnected = c.status === "connected" || c.status === "syncing";
          return (
            <DropdownMenuItem
              key={c.id}
              data-testid={`channel-switch-${c.id}`}
              onSelect={() => setActiveChannelId(c.id)}
              className={cn("gap-2", !isConnected && "opacity-60")}
            >
              <span
                className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
                style={{ backgroundColor: c.color }}
                aria-hidden="true"
              />
              <span className="flex-1 truncate">{c.label}</span>
              <ChannelStatusDot status={c.status} />
              {selected && (
                <Check className="w-3.5 h-3.5 text-foreground/70" />
              )}
            </DropdownMenuItem>
          );
        })}
        {channels.length > 1 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-testid="channel-switch-all"
              onSelect={() => setActiveChannelId("all")}
              className="gap-2"
            >
              <Layers className="w-3.5 h-3.5 text-foreground/70" />
              <div className="flex-1 min-w-0">
                <div>Semua channel</div>
                <div className="text-[10px] text-foreground/50 flex items-center gap-1 mt-0.5">
                  <Wifi className="w-2.5 h-2.5" />
                  Hanya channel terhubung
                </div>
              </div>
              {isAll && <Check className="w-3.5 h-3.5 text-foreground/70" />}
            </DropdownMenuItem>
          </>
        )}
        {(canViewChannels || canCreate) && <DropdownMenuSeparator />}
        {canViewChannels && (
          <DropdownMenuItem asChild>
            <Link href="/channels" data-testid="channel-manage-link" className="gap-2 cursor-pointer">
              <Settings2 className="w-3.5 h-3.5 text-foreground/70" />
              <span className="flex-1">Kelola channel</span>
            </Link>
          </DropdownMenuItem>
        )}
        {canCreate && (
          <DropdownMenuItem asChild>
            <Link href="/channels?add=1" data-testid="channel-add-link" className="gap-2 cursor-pointer">
              <Plus className="w-3.5 h-3.5 text-foreground/70" />
              <span className="flex-1">Tambah channel</span>
            </Link>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
