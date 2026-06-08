import { memo, useEffect, useState } from "react";
import { User } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface MessageAvatarProps {
  /** Full name shown in the tooltip and used for the initials fallback. */
  name?: string | null;
  /**
   * Source priority handled by the caller's data, but within the avatar the
   * order is: profile picture -> initials -> generic placeholder icon.
   */
  profilePicUrl?: string | null;
  /** Localised role label, e.g. "Customer", "Admin", "Supervisor". */
  role?: string | null;
  /** Display-ready WhatsApp number, e.g. "+628...". Omitted line when empty. */
  phoneNumber?: string | null;
  /** Stable key used to pick a deterministic background colour for initials. */
  colorKey?: string | null;
  className?: string;
}

// Soft, WhatsApp/Intercom-style hues for the initials fallback. Deterministic
// per sender so the same person always wears the same colour.
const AVATAR_COLOURS = [
  "#0ea5e9", "#ef4444", "#3b82f6", "#f59e0b", "#a855f7",
  "#ec4899", "#10b981", "#f43f5e", "#06b6d4", "#84cc16",
];

function pickColour(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return AVATAR_COLOURS[h % AVATAR_COLOURS.length];
}

function initialsFromName(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((w) => /[a-zA-Z0-9]/.test(w));
  if (words.length === 0) return "";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

function MessageAvatarImpl({
  name,
  profilePicUrl,
  role,
  phoneNumber,
  colorKey,
  className,
}: MessageAvatarProps) {
  const [failed, setFailed] = useState(false);

  // Reset the error flag whenever the URL changes (e.g. after a pic refresh)
  // so a fresh URL gets another chance to load.
  useEffect(() => {
    setFailed(false);
  }, [profilePicUrl]);

  const cleanName = (name ?? "").trim();
  const initials = initialsFromName(cleanName);
  const showImage = !!profilePicUrl && !failed;
  const bg = pickColour(colorKey || cleanName || "?");

  // Responsive: 32px on mobile, 40px on desktop. Circular.
  const sizeClasses =
    "w-8 h-8 md:w-10 md:h-10 rounded-full overflow-hidden flex-shrink-0";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            sizeClasses,
            "flex items-center justify-center select-none",
            className
          )}
          style={showImage ? undefined : { backgroundColor: initials ? bg : undefined }}
          aria-label={cleanName || "Avatar"}
          data-testid="message-avatar"
        >
          {showImage ? (
            <img
              src={profilePicUrl!}
              alt={cleanName || "Avatar"}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              className="w-full h-full object-cover"
              onError={() => setFailed(true)}
            />
          ) : initials ? (
            <span className="text-[11px] md:text-[13px] font-semibold text-white leading-none">
              {initials}
            </span>
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-[hsl(var(--wa-panel-header))]">
              <User
                className="text-[hsl(var(--wa-meta))]"
                style={{ width: "55%", height: "55%" }}
                strokeWidth={1.5}
              />
            </div>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[220px]">
        <div className="flex flex-col gap-0.5">
          <span className="font-semibold">{cleanName || "Tidak diketahui"}</span>
          {role ? <span className="opacity-80">{role}</span> : null}
          {phoneNumber ? (
            <span className="opacity-80 tabular-nums">{phoneNumber}</span>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

// Memoised: avatar props are primitives, so the avatar subtree won't re-render
// on every chat poll unless its own data actually changes.
export const MessageAvatar = memo(MessageAvatarImpl);
