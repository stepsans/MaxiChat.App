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

type ChannelContextValue = {
  channels: Channel[];
  activeChannel: Channel | null;
  activeChannelId: number | null;
  setActiveChannelId: (id: number) => void;
  isLoading: boolean;
};

const ChannelContext = createContext<ChannelContextValue | null>(null);

export function ChannelProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const [activeChannelId, setActiveId] = useState<number | null>(null);

  const { data: channels, isLoading } = useListChannels({
    query: { queryKey: getListChannelsQueryKey(), enabled: !!token },
  });

  // Default to the first channel once channels load (or when the current
  // selection is no longer valid, e.g. after a channel is removed).
  useEffect(() => {
    if (!channels || channels.length === 0) return;
    const stillValid = channels.some((c) => c.id === activeChannelId);
    if (!stillValid) {
      const first = channels[0].id;
      setActiveId(first);
      setMemChannelId(first);
    }
  }, [channels, activeChannelId]);

  const setActiveChannelId = (id: number) => {
    setActiveId(id);
    setMemChannelId(id);
  };

  const activeChannel =
    channels?.find((c) => c.id === activeChannelId) ?? null;

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
