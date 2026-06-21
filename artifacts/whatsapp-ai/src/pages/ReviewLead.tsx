import { useState } from "react";
import {
  useListLeadReviews,
  getListLeadReviewsQueryKey,
  useAnswerLeadReview,
  useDismissLeadReview,
} from "@workspace/api-client-react";
import type { LeadReviewRequest } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { ListChecks, AlertTriangle, HelpCircle, Check, X } from "lucide-react";

// Quick reason chips so answering teaches the AI without free typing every time.
const REASON_CHIPS_LEAD = [
  { code: "serious_buyer", label: "Serius mau beli" },
  { code: "asked_price", label: "Tanya harga/produk" },
  { code: "repeat_customer", label: "Pelanggan lama" },
];
const REASON_CHIPS_NOT_LEAD = [
  { code: "wrong_role", label: "Saya yang beli (vendor)" },
  { code: "just_asking", label: "Cuma basa-basi" },
  { code: "spam_personal", label: "Spam/personal" },
];

function ReviewCard({
  item,
  onResolved,
}: {
  item: LeadReviewRequest;
  onResolved: () => void;
}) {
  const [choice, setChoice] = useState<"lead" | "not_lead" | null>(
    (item.aiSuggestedStatus as "lead" | "not_lead" | null) ?? null
  );
  const [reasonCode, setReasonCode] = useState<string | null>(null);
  const [reasonText, setReasonText] = useState("");

  const answer = useAnswerLeadReview();
  const dismiss = useDismissLeadReview();
  const busy = answer.isPending || dismiss.isPending;

  const chips = choice === "not_lead" ? REASON_CHIPS_NOT_LEAD : REASON_CHIPS_LEAD;

  const submit = () => {
    if (!choice) return;
    const reason =
      reasonText.trim() ||
      chips.find((c) => c.code === reasonCode)?.label ||
      null;
    answer.mutate(
      { id: item.id, data: { leadStatus: choice, reason, reasonCode } },
      { onSuccess: onResolved }
    );
  };

  return (
    <Card data-testid={`lead-review-${item.id}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-base flex items-center gap-2">
              {item.contactName || item.contactPhone}
              {item.trigger === "conflict" ? (
                <Badge variant="destructive" className="gap-1 text-[10px]">
                  <AlertTriangle className="w-3 h-3" /> Bentrok
                </Badge>
              ) : (
                <Badge variant="secondary" className="gap-1 text-[10px]">
                  <HelpCircle className="w-3 h-3" /> AI ragu
                </Badge>
              )}
            </CardTitle>
            <CardDescription>{item.question}</CardDescription>
          </div>
        </div>
        {(item.contextSummary || item.aiScore != null) && (
          <div className="text-xs text-muted-foreground pt-1">
            {item.contextSummary ? `Konteks: ${item.contextSummary}. ` : ""}
            {item.aiScore != null ? `Skor AI: ${item.aiScore}. ` : ""}
            {item.aiConversationRole && item.aiConversationRole !== "unclear"
              ? `Peran: ${item.aiConversationRole}.`
              : ""}
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant={choice === "lead" ? "default" : "outline"}
            onClick={() => { setChoice("lead"); setReasonCode(null); }}
            data-testid={`lead-review-${item.id}-lead`}
          >
            Lead
          </Button>
          <Button
            type="button"
            size="sm"
            variant={choice === "not_lead" ? "default" : "outline"}
            onClick={() => { setChoice("not_lead"); setReasonCode(null); }}
            data-testid={`lead-review-${item.id}-not-lead`}
          >
            Not Lead
          </Button>
        </div>

        {choice && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {chips.map((c) => (
                <Button
                  key={c.code}
                  type="button"
                  size="sm"
                  variant={reasonCode === c.code ? "secondary" : "ghost"}
                  className="h-7 text-xs"
                  onClick={() => setReasonCode(c.code)}
                >
                  {c.label}
                </Button>
              ))}
            </div>
            <Input
              placeholder="Alasan lain (opsional) — bantu AI belajar"
              value={reasonText}
              onChange={(e) => setReasonText(e.target.value)}
              className="h-9 text-sm"
            />
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <Button
            type="button"
            size="sm"
            disabled={!choice || busy}
            onClick={submit}
            className="gap-1"
          >
            <Check className="w-4 h-4" /> Simpan & ajari AI
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => dismiss.mutate({ id: item.id }, { onSuccess: onResolved })}
            className="gap-1 text-muted-foreground"
          >
            <X className="w-4 h-4" /> Abaikan
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// The "Review Lead" category of the Learning Inbox: lead vs not-lead questions
// the AI raised. Rendered as a panel inside LearningInbox (the shell supplies
// the page heading + category rail).
export function ReviewLeadPanel() {
  const qc = useQueryClient();
  const { data, isLoading } = useListLeadReviews({
    query: { queryKey: getListLeadReviewsQueryKey(), refetchInterval: 30_000 },
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: getListLeadReviewsQueryKey() });
  };

  const items = data?.items ?? [];

  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm text-muted-foreground">
        AI bertanya saat ragu atau saat keputusannya berbeda dengan labelmu.
        Jawabanmu langsung jadi label final <strong>dan</strong> dipelajari AI
        supaya makin pintar membedakan lead vs bukan lead.
      </p>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <ListChecks className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="text-sm">Tidak ada yang perlu direview. AI sedang yakin 👍</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <ReviewCard key={item.id} item={item} onResolved={refresh} />
          ))}
        </div>
      )}
    </div>
  );
}
