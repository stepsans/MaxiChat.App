import { Users, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState, useEffect } from "react";

interface ChatAvatarProps {
  name?: string | null;
  profilePicUrl?: string | null;
  isGroup?: boolean;
  isUnknown?: boolean;
  size?: number;
  className?: string;
}

// WhatsApp-style circular avatar. Falls back to a generic person/group glyph
// (matching WhatsApp's default avatar) when no picture is available — we don't
// show a letter initial because WhatsApp itself doesn't, and the goal is
// 1:1 visual parity.
export function ChatAvatar({
  name,
  profilePicUrl,
  isGroup,
  isUnknown,
  size = 40,
  className,
}: ChatAvatarProps) {
  const [failed, setFailed] = useState(false);

  // Reset error state when the image URL changes (after a refresh).
  useEffect(() => {
    setFailed(false);
  }, [profilePicUrl]);

  const showImage = !!profilePicUrl && !failed;
  const Icon = isGroup ? Users : User;

  return (
    <div
      className={cn(
        "rounded-full overflow-hidden flex-shrink-0 flex items-center justify-center bg-[hsl(var(--wa-panel-header))]",
        className
      )}
      style={{ width: size, height: size }}
      aria-label={name ?? "Avatar"}
    >
      {showImage ? (
        <img
          src={profilePicUrl!}
          alt={name ?? "Avatar"}
          className="w-full h-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <Icon
          className="text-[hsl(var(--wa-meta))]"
          style={{ width: size * 0.55, height: size * 0.55 }}
          strokeWidth={1.5}
        />
      )}
    </div>
  );
}
