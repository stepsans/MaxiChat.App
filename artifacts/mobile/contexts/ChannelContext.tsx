import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  useListChannels,
  getListChannelsQueryKey,
  type Channel,
} from "@workspace/api-client-react";

import { setMemChannelId } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";

export type ActiveChannelId = number | "all" | null;

type ChannelContextValue = {
  channels: Channel[];
  activeChannel: Channel | null;
  activeChannelId: ActiveChannelId;
  setActiveChannelId: (id: ActiveChannelId) => void;
  isLoading: boolean;
};

const ChannelContext = createContext<ChannelContextValue | null>(null);

export function ChannelProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const [activeChannelId, setActiveId] = useState<ActiveChannelId>(null);

  const { data: channels, isLoading } = useListChannels({
    query: { queryKey: getListChannelsQueryKey(), enabled: !!token },
  });

  // Default to the first channel once channels load (or when the current
  // selection is no longer valid, e.g. after a channel is removed).
  useEffect(() => {
    if (!channels || channels.length === 0) return;
    if (activeChannelId === "all") return;
    const stillValid =
      activeChannelId != null && channels.some((c) => c.id === activeChannelId);
    if (!stillValid) {
      const defaultChannel = channels.find((c) => c.isDefault) ?? channels[0];
      setActiveId(defaultChannel.id);
      setMemChannelId(defaultChannel.id);
    }
  }, [channels, activeChannelId]);

  const setActiveChannelId = (id: ActiveChannelId) => {
    setActiveId(id);
    setMemChannelId(id);
  };

  const activeChannel =
    typeof activeChannelId === "number"
      ? (channels?.find((c) => c.id === activeChannelId) ?? null)
      : null;

  const value = useMemo<ChannelContextValue>(
    () => ({
      channels: channels ?? [],
      activeChannel,
      activeChannelId,
      setActiveChannelId,
      isLoading,
    }),
    [channels, activeChannel, activeChannelId, isLoading],
  );

  return (
    <ChannelContext.Provider value={value}>{children}</ChannelContext.Provider>
  );
}

export function useChannel(): ChannelContextValue {
  const ctx = useContext(ChannelContext);
  if (!ctx) throw new Error("useChannel must be used within ChannelProvider");
  return ctx;
}
