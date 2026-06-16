import {
  useListChannels,
  getListChannelsQueryKey,
} from "@workspace/api-client-react";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";

// Page-level channel scope for Laporan & Jadwal, shown in the header next to
// the period picker. `undefined` = "Semua channel" (every channel the viewer
// can access). The list is role-scoped server-side (super_admin sees all of the
// tenant's channels; supervisor/agent see only their assigned channels), so it
// stays consistent with the global channel switcher.
export function ChannelFilter({
  value,
  onChange,
}: {
  value?: number;
  onChange: (v?: number) => void;
}) {
  const { data: channels } = useListChannels({
    query: { queryKey: getListChannelsQueryKey() },
  });
  return (
    <Select
      value={value != null ? String(value) : "all"}
      onValueChange={(v) => onChange(v === "all" ? undefined : Number(v))}
    >
      <SelectTrigger className="h-8 w-[170px]">
        <SelectValue placeholder="Semua channel" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">Semua channel</SelectItem>
        {(channels ?? []).map((c) => (
          <SelectItem key={c.id} value={String(c.id)}>
            {c.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
