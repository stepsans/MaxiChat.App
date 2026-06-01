import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  useListChats,
  getListChatsQueryKey,
} from "@workspace/api-client-react";
import { useActiveChannel } from "@/contexts/ChannelContext";
import {
  DEFAULT_NOTIFICATION_SOUND,
  isNotificationSoundId,
  playNotificationSound,
  type NotificationSoundId,
} from "@/lib/notification-sounds";

const STORAGE_KEY = "maxics-notif-sound";

function readStored(): NotificationSoundId {
  if (typeof window === "undefined") return DEFAULT_NOTIFICATION_SOUND;
  const v = window.localStorage.getItem(STORAGE_KEY);
  return isNotificationSoundId(v) ? v : DEFAULT_NOTIFICATION_SOUND;
}

type NotificationSoundContextValue = {
  sound: NotificationSoundId;
  setSound: (s: NotificationSoundId) => void;
  preview: (s: NotificationSoundId) => void;
};

const NotificationSoundContext =
  createContext<NotificationSoundContextValue | null>(null);

export function NotificationSoundProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [sound, setSoundState] = useState<NotificationSoundId>(() =>
    readStored(),
  );

  const setSound = (s: NotificationSoundId) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, s);
    } catch {
      // ignore — private mode / quota shouldn't break the UI
    }
    setSoundState(s);
  };

  const preview = (s: NotificationSoundId) => playNotificationSound(s);

  return (
    <NotificationSoundContext.Provider value={{ sound, setSound, preview }}>
      {children}
    </NotificationSoundContext.Provider>
  );
}

export function useNotificationSound(): NotificationSoundContextValue {
  const ctx = useContext(NotificationSoundContext);
  if (!ctx)
    throw new Error(
      "useNotificationSound must be used within <NotificationSoundProvider>",
    );
  return ctx;
}

// Polls the chat list (shares the cache with the rest of the app via the same
// query key) and plays the selected ring whenever an incoming message bumps a
// chat's unread count. Channel switches reset the baseline silently so they
// never trigger a false beep. Mount this once, globally (in Layout).
export function useChatNotificationSound(): void {
  const { activeChannelId } = useActiveChannel();
  const { sound } = useNotificationSound();
  const { data: chats } = useListChats(
    {},
    { query: { queryKey: getListChatsQueryKey(), refetchInterval: 5000 } },
  );

  // Keep the latest selection in a ref so the detection effect doesn't need to
  // re-run (and re-baseline) every time the user changes the sound.
  const soundRef = useRef(sound);
  soundRef.current = sound;

  const baselineRef = useRef<Map<number, number>>(new Map());
  // True until the first chat payload that belongs to the just-selected
  // channel has been committed as a baseline. The chat query key is NOT
  // channel-scoped, so right after a switch `chats` may still hold the
  // previous channel's cached data. We must wait for the next payload and
  // adopt it silently instead of comparing unread counts across channels
  // (which would otherwise beep on the new channel's pre-existing unreads).
  const pendingBaselineRef = useRef(true);

  // A channel switch (and the initial mount) arms a silent re-baseline.
  useEffect(() => {
    pendingBaselineRef.current = true;
  }, [activeChannelId]);

  useEffect(() => {
    if (!chats) return;

    const current = new Map<number, number>();
    for (const c of chats) current.set(c.id, c.unreadCount ?? 0);

    // First payload overall, or the first payload after a channel switch:
    // adopt it as the baseline without beeping.
    if (pendingBaselineRef.current) {
      pendingBaselineRef.current = false;
      baselineRef.current = current;
      return;
    }

    let hasNew = false;
    for (const [id, unread] of current) {
      if (unread > (baselineRef.current.get(id) ?? 0)) {
        hasNew = true;
        break;
      }
    }
    baselineRef.current = current;

    if (hasNew && soundRef.current !== "off") {
      playNotificationSound(soundRef.current);
    }
  }, [chats]);
}
