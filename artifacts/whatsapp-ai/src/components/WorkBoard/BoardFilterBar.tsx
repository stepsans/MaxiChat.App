import { useMemo, useState } from "react";
import { Check, ChevronDown, Users, Tag as TagIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { WorkboardTask, WorkboardMember } from "@/hooks/useBoardDetail";
import {
  collectBoardTags,
  activeCategoryCount,
  isFilterActive,
  EMPTY_FILTER,
  type BoardFilterState,
} from "./board-filter";

// Re-export so views/tests can import the type from one place.
export type { BoardFilterState } from "./board-filter";
export { EMPTY_FILTER } from "./board-filter";

interface BoardFilterBarProps {
  tasks: WorkboardTask[];
  members: WorkboardMember[];
  currentUserId: number | null;
  value: BoardFilterState;
  onChange: (next: BoardFilterState) => void;
}

function memberLabel(m: WorkboardMember): string {
  return m.name ?? m.email ?? `#${m.userId}`;
}

// Small checkbox row reused by both dropdowns.
function CheckRow({
  checked,
  label,
  onClick,
}: {
  checked: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded hover-elevate text-left"
    >
      <span
        className={cn(
          "w-4 h-4 rounded-sm border flex items-center justify-center shrink-0",
          checked ? "bg-primary border-primary text-primary-foreground" : "border-border"
        )}
      >
        {checked && <Check className="w-3 h-3" />}
      </span>
      <span className="flex-1 truncate">{label}</span>
    </button>
  );
}

export default function BoardFilterBar({
  tasks,
  members,
  currentUserId,
  value,
  onChange,
}: BoardFilterBarProps) {
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);

  const allTags = useMemo(() => collectBoardTags(tasks), [tasks]);

  const toggleAssignee = (id: number) => {
    onChange({
      ...value,
      assigneeIds: value.assigneeIds.includes(id)
        ? value.assigneeIds.filter((v) => v !== id)
        : [...value.assigneeIds, id],
    });
  };

  // Tags are stored lowercase in state (matcher is case-insensitive); display
  // uses the original casing from `allTags`.
  const toggleTag = (display: string) => {
    const key = display.toLowerCase();
    onChange({
      ...value,
      tags: value.tags.includes(key)
        ? value.tags.filter((t) => t !== key)
        : [...value.tags, key],
    });
  };

  const isMeOnly =
    currentUserId !== null &&
    value.assigneeIds.length === 1 &&
    value.assigneeIds[0] === currentUserId;

  const toggleMeOnly = () => {
    if (currentUserId === null) return;
    onChange({ ...value, assigneeIds: isMeOnly ? [] : [currentUserId] });
  };

  const bothActive = activeCategoryCount(value) === 2;
  const active = isFilterActive(value);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Assignee multi-select */}
      <Popover open={assigneeOpen} onOpenChange={setAssigneeOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5">
            <Users className="w-3.5 h-3.5 text-muted-foreground" />
            Assignee
            {value.assigneeIds.length > 0 && (
              <Badge variant="secondary" className="ml-0.5 px-1.5 text-[10px]">
                {value.assigneeIds.length}
              </Badge>
            )}
            <ChevronDown className="w-3.5 h-3.5 opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-56 p-0">
          <ScrollArea className="max-h-64">
            <div className="p-1">
              {members.length === 0 ? (
                <p className="px-2 py-2 text-xs text-muted-foreground">Belum ada anggota.</p>
              ) : (
                members.map((m) => (
                  <CheckRow
                    key={m.userId}
                    checked={value.assigneeIds.includes(m.userId)}
                    label={memberLabel(m)}
                    onClick={() => toggleAssignee(m.userId)}
                  />
                ))
              )}
            </div>
          </ScrollArea>
          {value.assigneeIds.length > 0 && (
            <div className="border-t p-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full justify-start text-xs"
                onClick={() => onChange({ ...value, assigneeIds: [] })}
              >
                Kosongkan assignee
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>

      {/* "Ditugaskan ke saya" preset */}
      {currentUserId !== null && (
        <Button
          type="button"
          variant={isMeOnly ? "default" : "outline"}
          size="sm"
          className="h-8"
          onClick={toggleMeOnly}
        >
          Ditugaskan ke saya
        </Button>
      )}

      {/* Tag multi-select */}
      <Popover open={tagOpen} onOpenChange={setTagOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            disabled={allTags.length === 0}
          >
            <TagIcon className="w-3.5 h-3.5 text-muted-foreground" />
            Tag
            {value.tags.length > 0 && (
              <Badge variant="secondary" className="ml-0.5 px-1.5 text-[10px]">
                {value.tags.length}
              </Badge>
            )}
            <ChevronDown className="w-3.5 h-3.5 opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-56 p-0">
          <ScrollArea className="max-h-64">
            <div className="p-1">
              {allTags.map((t) => (
                <CheckRow
                  key={t}
                  checked={value.tags.includes(t.toLowerCase())}
                  label={t}
                  onClick={() => toggleTag(t)}
                />
              ))}
            </div>
          </ScrollArea>
          {value.tags.length > 0 && (
            <div className="border-t p-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full justify-start text-xs"
                onClick={() => onChange({ ...value, tags: [] })}
              >
                Kosongkan tag
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>

      {/* Between-category mode — only meaningful when BOTH categories active.
          Friendly labels, never raw AND/OR. */}
      {bothActive && (
        <div className="inline-flex rounded-md border p-0.5 text-xs">
          <button
            type="button"
            onClick={() => onChange({ ...value, mode: "and" })}
            className={cn(
              "px-2 py-1 rounded transition-colors",
              value.mode === "and"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Cocok semua filter
          </button>
          <button
            type="button"
            onClick={() => onChange({ ...value, mode: "or" })}
            className={cn(
              "px-2 py-1 rounded transition-colors",
              value.mode === "or"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Cocok salah satu
          </button>
        </div>
      )}

      {/* Active summary + reset */}
      {active && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>
            {[
              value.assigneeIds.length > 0
                ? `${value.assigneeIds.length} assignee`
                : null,
              value.tags.length > 0 ? `${value.tags.length} tag` : null,
            ]
              .filter(Boolean)
              .join(", ")}
            {bothActive ? (value.mode === "and" ? " · cocok semua" : " · cocok salah satu") : ""}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2"
            onClick={() => onChange({ ...EMPTY_FILTER })}
          >
            <X className="w-3.5 h-3.5" />
            Reset
          </Button>
        </div>
      )}
    </div>
  );
}
