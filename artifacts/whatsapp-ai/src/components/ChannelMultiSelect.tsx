import { useMemo, useState } from "react";
import { Check, ChevronDown, Globe2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useActiveChannel } from "@/contexts/ChannelContext";
import { cn } from "@/lib/utils";

// "Assigned to channels" multi-select used by Products / Knowledge /
// Shortcuts forms. Empty selection = GLOBAL (the resource is available on
// every channel the owner has). One+ selection = scoped to those channels.
export interface ChannelMultiSelectProps {
  value: number[];
  onChange: (next: number[]) => void;
  disabled?: boolean;
  className?: string;
  testIdPrefix?: string;
}

export function ChannelMultiSelect({
  value,
  onChange,
  disabled,
  className,
  testIdPrefix = "channel-multiselect",
}: ChannelMultiSelectProps) {
  const { channels } = useActiveChannel();
  const [open, setOpen] = useState(false);
  const all = channels ?? [];
  const byId = useMemo(() => new Map(all.map((c) => [c.id, c])), [all]);
  const selected = value
    .map((id) => byId.get(id))
    .filter((c): c is NonNullable<ReturnType<typeof byId.get>> => Boolean(c));

  function toggle(id: number) {
    if (value.includes(id)) {
      onChange(value.filter((v) => v !== id));
    } else {
      onChange([...value, id].sort((a, b) => a - b));
    }
  }

  // With 0 or 1 channels there's nothing to assign — render a quiet note.
  if (all.length <= 1) {
    return (
      <div className={cn("text-xs text-muted-foreground", className)}>
        <Globe2 className="w-3 h-3 inline-block mr-1 -mt-0.5" />
        Tersedia di semua channel.
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          data-testid={`${testIdPrefix}-trigger`}
          className={cn(
            "w-full justify-between min-h-9 h-auto py-1.5 px-2 font-normal",
            className
          )}
        >
          <div className="flex flex-wrap gap-1 items-center text-left flex-1 min-w-0">
            {selected.length === 0 ? (
              <span className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
                <Globe2 className="w-3 h-3" />
                Semua channel
              </span>
            ) : (
              selected.map((c) => (
                <Badge
                  key={c.id}
                  variant="secondary"
                  className="gap-1 font-normal text-[11px]"
                  data-testid={`${testIdPrefix}-chip-${c.id}`}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ backgroundColor: c.color }}
                  />
                  {c.label}
                </Badge>
              ))
            )}
          </div>
          <ChevronDown className="w-3.5 h-3.5 ml-1 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-0"
      >
        <div className="px-2.5 py-2 text-[11px] text-muted-foreground border-b">
          Pilih channel tertentu, atau kosongkan untuk berlaku di semua channel.
        </div>
        <ScrollArea className="max-h-64">
          <div className="p-1">
            {all.map((c) => {
              const checked = value.includes(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggle(c.id)}
                  data-testid={`${testIdPrefix}-option-${c.id}`}
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded hover-elevate text-left"
                >
                  <span
                    className={cn(
                      "w-4 h-4 rounded-sm border flex items-center justify-center shrink-0",
                      checked
                        ? "bg-primary border-primary text-primary-foreground"
                        : "border-border"
                    )}
                  >
                    {checked && <Check className="w-3 h-3" />}
                  </span>
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: c.color }}
                  />
                  <span className="flex-1 truncate">{c.label}</span>
                  {c.status !== "connected" && (
                    <span className="text-[10px] text-muted-foreground">
                      {c.status === "qr_ready" ? "pairing" : c.status}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </ScrollArea>
        {value.length > 0 && (
          <div className="border-t p-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full justify-start text-xs"
              onClick={() => onChange([])}
              data-testid={`${testIdPrefix}-clear`}
            >
              Kosongkan (semua channel)
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
