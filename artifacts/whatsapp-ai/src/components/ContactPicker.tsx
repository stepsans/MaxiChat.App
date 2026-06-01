import { useState } from "react";
import { useListChats, getListChatsQueryKey } from "@workspace/api-client-react";
import { ChatAvatar } from "@/components/ChatAvatar";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ContactOption {
  phone: string;
  name: string;
  profilePicUrl: string | null;
}

// Derive selectable WhatsApp personal contacts from the chat list. Groups,
// LID-only chats (no real phone number yet) and Telegram chats are excluded
// because they can't be added to a WhatsApp group by phone number.
export function useContactOptions(excludePhones: string[] = []): {
  options: ContactOption[];
  isLoading: boolean;
} {
  const { data, isLoading } = useListChats(
    {},
    { query: { queryKey: getListChatsQueryKey() } }
  );
  const exclude = new Set(excludePhones.map((p) => p.replace(/[^0-9]/g, "")));
  const seen = new Set<string>();
  const options = (data ?? [])
    .filter(
      (c) =>
        !c.phoneNumber.endsWith("@g.us") &&
        !c.isLid &&
        !c.phoneNumber.startsWith("tg:")
    )
    .map((c) => ({
      phone: c.phoneNumber.replace(/[^0-9]/g, ""),
      name: c.nickname?.trim() || c.contactName || c.phoneNumber,
      profilePicUrl: c.profilePicUrl,
    }))
    .filter((o) => {
      if (o.phone.length < 8 || exclude.has(o.phone) || seen.has(o.phone))
        return false;
      seen.add(o.phone);
      return true;
    });
  return { options, isLoading };
}

export function ContactPicker({
  selected,
  onChange,
  excludePhones = [],
  emptyHint = "Tidak ada kontak personal.",
  height = "h-52",
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  excludePhones?: string[];
  emptyHint?: string;
  height?: string;
}) {
  const [search, setSearch] = useState("");
  const { options, isLoading } = useContactOptions(excludePhones);
  const selectedSet = new Set(selected);
  const q = search.trim().toLowerCase();
  const filtered = q
    ? options.filter(
        (o) => o.name.toLowerCase().includes(q) || o.phone.includes(q)
      )
    : options;

  function toggle(phone: string) {
    if (selectedSet.has(phone)) onChange(selected.filter((p) => p !== phone));
    else onChange([...selected, phone]);
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[hsl(var(--wa-meta))]" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Cari kontak..."
          data-testid="input-contact-search"
          className="w-full h-9 pl-8 pr-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>
      {isLoading ? (
        <p className="py-4 text-center text-xs text-muted-foreground">
          Memuat kontak...
        </p>
      ) : filtered.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">
          {emptyHint}
        </p>
      ) : (
        <ScrollArea className={cn("rounded-md border border-input", height)}>
          <div className="p-1">
            {filtered.map((o) => {
              const checked = selectedSet.has(o.phone);
              return (
                <button
                  type="button"
                  key={o.phone}
                  data-testid={`contact-option-${o.phone}`}
                  onClick={() => toggle(o.phone)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors",
                    checked ? "bg-accent" : "hover:bg-accent/50"
                  )}
                >
                  <Checkbox
                    checked={checked}
                    className="pointer-events-none flex-shrink-0"
                  />
                  <ChatAvatar
                    name={o.name}
                    profilePicUrl={o.profilePicUrl}
                    size={32}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{o.name}</p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {o.phone}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </ScrollArea>
      )}
      {selected.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {selected.length} kontak dipilih.
        </p>
      )}
    </div>
  );
}
