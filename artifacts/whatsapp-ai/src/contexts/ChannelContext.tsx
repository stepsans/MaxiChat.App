import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListChannels,
  setChannelIdGetter,
  type Channel,
} from "@workspace/api-client-react";

const STORAGE_KEY = "maxichat:active-channel";

// 'all' = aggregate view across every channel. null = not chosen yet
// (loading or no channels); backend falls back to the user's primary
// channel when no X-Channel-Id header is sent.
export type ActiveChannelSelection = number | "all" | null;

type Ctx = {
  channels: Channel[];
  isLoading: boolean;
  activeChannelId: ActiveChannelSelection;
  activeChannel: Channel | null;
  setActiveChannelId: (id: ActiveChannelSelection) => void;
  refetch: () => void;
};

const ChannelContext = createContext<Ctx | null>(null);

function loadStored(): ActiveChannelSelection {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    if (raw === "all") return "all";
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function persist(sel: ActiveChannelSelection): void {
  if (typeof window === "undefined") return;
  try {
    if (sel == null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, String(sel));
  } catch {
    // localStorage can throw in private-browsing / sandboxed iframes;
    // selection still works for the in-memory session.
  }
}

export function ChannelProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data: channels, isLoading, refetch } = useListChannels();
  const [activeChannelId, setActiveChannelIdState] =
    useState<ActiveChannelSelection>(() => loadStored());

  // The fetch interceptor reads from a ref so the getter is always
  // current without re-registering on every state change. CRITICAL:
  // every code path that mutates `activeChannelId` must update this ref
  // BEFORE triggering refetches (invalidateQueries) — otherwise the
  // immediate refetch fires with the previous channel id (the ref only
  // catches up at the next render). See setActiveChannelId below.
  const activeRef = useRef<ActiveChannelSelection>(activeChannelId);

  useEffect(() => {
    setChannelIdGetter(() => activeRef.current);
    return () => setChannelIdGetter(null);
  }, []);

  // Queries that are NOT scoped to the active channel and so don't need
  // to be refetched when the user switches. Keeps switch cost low when
  // the user toggles between channels frequently.
  const CHANNEL_AGNOSTIC_PATHS = [
    "/api/auth/me",
    "/api/channels",
    "/api/permissions/me",
    "/api/agents",
  ];
  const isChannelAgnosticKey = useCallback((key: readonly unknown[]) => {
    const first = key[0];
    if (typeof first !== "string") return false;
    return CHANNEL_AGNOSTIC_PATHS.some((p) => first === p || first.startsWith(`${p}/`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Centralised "switch to this channel" — keeps the ref, state,
  // localStorage, and query cache in sync in the correct order. Used by
  // both the explicit setter and the auto-fallback effect below.
  const switchTo = useCallback(
    (sel: ActiveChannelSelection) => {
      // 1. Update the ref FIRST so any refetch triggered by the
      //    invalidation below picks up the new header.
      activeRef.current = sel;
      // 2. Persist before React commits — survives a hard refresh
      //    even if the user navigates away immediately.
      persist(sel);
      // 3. Remove channel-scoped queries from cache immediately so active
      //    subscribers enter loading state instead of showing the previous
      //    channel's data while the new fetch is in-flight. Skips
      //    static-per-user data (auth/me, permissions, channels list).
      queryClient.removeQueries({
        predicate: (q) => !isChannelAgnosticKey(q.queryKey),
      });
      // 4. Finally update React state so the UI reflects the change.
      setActiveChannelIdState(sel);
    },
    [queryClient, isChannelAgnosticKey]
  );

  // Once the channel list arrives, default to the channel marked isDefault
  // (if any), otherwise fall back to the lowest-id channel. If the stored
  // selection points at a channel that no longer exists (deleted in another
  // tab / different user) fall back the same way and persist immediately so
  // subsequent requests stop sending the stale id.
  useEffect(() => {
    if (!channels || channels.length === 0) return;
    if (activeChannelId === "all") return;
    if (
      activeChannelId != null &&
      channels.some((c) => c.id === activeChannelId)
    ) {
      return;
    }
    const defaultChannel = channels.find((c) => c.isDefault) ?? channels[0];
    switchTo(defaultChannel.id);
  }, [channels, activeChannelId, switchTo]);

  const setActiveChannelId = useCallback(
    (sel: ActiveChannelSelection) => {
      if (sel === activeRef.current) return;
      switchTo(sel);
    },
    [switchTo]
  );

  const activeChannel = useMemo(() => {
    if (!channels || activeChannelId == null || activeChannelId === "all") {
      return null;
    }
    return channels.find((c) => c.id === activeChannelId) ?? null;
  }, [channels, activeChannelId]);

  const value = useMemo<Ctx>(
    () => ({
      channels: channels ?? [],
      isLoading,
      activeChannelId,
      activeChannel,
      setActiveChannelId,
      refetch: () => {
        void refetch();
      },
    }),
    [channels, isLoading, activeChannelId, activeChannel, setActiveChannelId, refetch]
  );

  return (
    <ChannelContext.Provider value={value}>{children}</ChannelContext.Provider>
  );
}

export function useActiveChannel(): Ctx {
  const ctx = useContext(ChannelContext);
  if (!ctx) {
    throw new Error("useActiveChannel must be used within ChannelProvider");
  }
  return ctx;
}
