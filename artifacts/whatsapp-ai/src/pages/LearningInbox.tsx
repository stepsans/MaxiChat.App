import { useState } from "react";
import {
  useListLeadReviews,
  getListLeadReviewsQueryKey,
} from "@workspace/api-client-react";
import { ReviewLeadPanel } from "./ReviewLead";
import { TeachAiPanel } from "./TeachAiPanel";
import { GraduationCap, ListChecks, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

// Learning Inbox — where the AI brings things it's unsure about so the tenant's
// answers make it smarter over time. Today the only category is lead vs not-lead
// ("Review Lead"); the rail is built so future ambiguity types (intent, reply
// drafting, etc.) slot in as new categories.
type CategoryKey = "review-lead" | "teach-ai";

export default function LearningInbox() {
  const { data } = useListLeadReviews({
    query: { queryKey: getListLeadReviewsQueryKey(), refetchInterval: 30_000 },
  });
  const reviewCount = data?.pendingCount ?? 0;
  const [active, setActive] = useState<CategoryKey>("review-lead");

  const categories = [
    {
      key: "review-lead" as const,
      label: "Review Lead",
      desc: "Lead vs bukan lead",
      icon: ListChecks,
      count: reviewCount,
    },
    {
      key: "teach-ai" as const,
      label: "Ajari AI",
      desc: "Chat & beri instruksi",
      icon: Sparkles,
      count: 0,
    },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-2 px-4 md:px-6 h-14 border-b border-border flex-shrink-0">
        <GraduationCap className="w-5 h-5 text-primary" />
        <div className="min-w-0">
          <h1 className="text-base font-semibold leading-tight">Learning Inbox</h1>
          <p className="text-xs text-muted-foreground truncate">
            AI menanyakan hal yang membingungkan agar makin pintar dari hari ke hari
          </p>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <nav className="w-52 shrink-0 border-r border-border overflow-y-auto p-2 flex flex-col">
          {categories.map((c) => {
            const Icon = c.icon;
            const isActive = active === c.key;
            return (
              <button
                key={c.key}
                onClick={() => setActive(c.key)}
                data-testid={`learning-cat-${c.key}`}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-left transition-colors",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-foreground/70 hover:bg-muted"
                )}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                <span className="flex-1 min-w-0">
                  <span className="block font-medium truncate">{c.label}</span>
                  <span
                    className={cn(
                      "block text-[11px] truncate",
                      isActive ? "text-primary-foreground/80" : "text-muted-foreground"
                    )}
                  >
                    {c.desc}
                  </span>
                </span>
                {c.count > 0 && (
                  <span
                    className={cn(
                      "inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold",
                      isActive ? "bg-white text-primary" : "bg-primary text-white"
                    )}
                  >
                    {c.count > 99 ? "99+" : c.count}
                  </span>
                )}
              </button>
            );
          })}
          <p className="mt-auto px-3 py-3 text-[11px] text-muted-foreground/70 leading-snug">
            Kategori pembelajaran lain akan muncul di sini seiring AI makin pintar.
          </p>
        </nav>

        <div className="flex-1 overflow-y-auto p-4 md:p-6">
          {active === "review-lead" && <ReviewLeadPanel />}
          {active === "teach-ai" && (
            <div className="h-[calc(100vh-10rem)]">
              <TeachAiPanel />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
