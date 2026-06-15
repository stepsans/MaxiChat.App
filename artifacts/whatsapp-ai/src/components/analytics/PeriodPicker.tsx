import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { PeriodKey } from "./format";

const PRESETS: Array<{ key: PeriodKey; label: string }> = [
  { key: "today", label: "Hari ini" },
  { key: "7d", label: "7 hari" },
  { key: "30d", label: "30 hari" },
  { key: "custom", label: "Custom" },
];

export interface PeriodState {
  period: PeriodKey;
  from?: string;
  to?: string;
}

/** Global date-range control shown in the page header. */
export function PeriodPicker({ value, onChange }: { value: PeriodState; onChange: (v: PeriodState) => void }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex rounded-md border border-border p-0.5">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => onChange({ period: p.key, from: value.from, to: value.to })}
            className={cn(
              "rounded px-2.5 py-1 text-xs font-medium transition-colors",
              value.period === p.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      {value.period === "custom" && (
        <div className="flex items-center gap-1">
          <Input
            type="date"
            value={value.from ?? ""}
            onChange={(e) => onChange({ period: "custom", from: e.target.value, to: value.to })}
            className="h-8 w-[140px]"
          />
          <span className="text-xs text-muted-foreground">–</span>
          <Input
            type="date"
            value={value.to ?? ""}
            onChange={(e) => onChange({ period: "custom", from: value.from, to: e.target.value })}
            className="h-8 w-[140px]"
          />
        </div>
      )}
    </div>
  );
}
