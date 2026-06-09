import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface ChecklistData {
  waConnected: boolean;
  productAdded: boolean;
  teamMemberAdded: boolean;
  firstMessageAt: string | null;
  aiTriedAt: string | null;
  flowActivated: boolean;
  healthScore: number;
  riskLevel: "low" | "medium" | "high";
}

const CHECKLIST_ITEMS = [
  {
    key: "waConnected" as const,
    label: "Hubungkan WhatsApp",
    desc: "Scan QR code di menu Channels",
    href: "/channels",
    points: 30,
  },
  {
    key: "productAdded" as const,
    label: "Tambahkan Produk",
    desc: "Isi katalog produk agar AI bisa jawab pertanyaan",
    href: "/products",
    points: 20,
  },
  {
    key: "firstMessage" as const,
    label: "Terima atau Kirim Pesan",
    desc: "Coba kirim pesan WA ke nomor bisnis Anda",
    href: "/chats",
    points: 20,
  },
  {
    key: "teamMemberAdded" as const,
    label: "Tambahkan Anggota Tim",
    desc: "Invite agent atau supervisor",
    href: "/agents",
    points: 15,
  },
  {
    key: "aiTried" as const,
    label: "Coba Fitur AI",
    desc: "Aktifkan auto-reply AI di Settings",
    href: "/settings",
    points: 10,
  },
  {
    key: "flowActivated" as const,
    label: "Aktifkan Chatbot Flow",
    desc: "Buat flow di menu Flows",
    href: "/flows",
    points: 5,
  },
];

export function OnboardingChecklist() {
  const { data, isLoading } = useQuery<ChecklistData>({
    queryKey: ["onboarding-checklist"],
    queryFn: () =>
      fetch("/api/onboarding/checklist", { credentials: "include" }).then((r) =>
        r.json()
      ),
    refetchInterval: 30_000,
  });

  if (isLoading || !data) return null;
  if (data.healthScore >= 100) return null; // Semua selesai, sembunyikan

  const isDoneMap: Record<string, boolean> = {
    waConnected: data.waConnected,
    productAdded: data.productAdded,
    firstMessage: !!data.firstMessageAt,
    teamMemberAdded: data.teamMemberAdded,
    aiTried: !!data.aiTriedAt,
    flowActivated: data.flowActivated,
  };

  const completedCount = CHECKLIST_ITEMS.filter(
    (item) => isDoneMap[item.key]
  ).length;

  return (
    <div
      className="rounded-xl border border-border bg-card p-5 shadow-sm"
      data-testid="onboarding-checklist"
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-semibold text-foreground">Setup MaxiChat</h3>
        <span className="text-sm text-muted-foreground">
          {completedCount}/6 selesai
        </span>
      </div>

      <div className="mb-4 h-2 rounded-full bg-muted">
        <div
          className="h-2 rounded-full bg-green-500 transition-all duration-500"
          style={{ width: `${data.healthScore}%` }}
        />
      </div>

      <div className="space-y-2">
        {CHECKLIST_ITEMS.map((item) => {
          const done = isDoneMap[item.key];
          const inner = (
            <div
              className={cn(
                "flex items-start gap-3 rounded-lg p-2 transition-colors",
                done ? "opacity-50" : "hover:bg-muted/60"
              )}
            >
              <span
                className={cn(
                  "mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-xs",
                  done
                    ? "bg-green-500 text-white"
                    : "border-2 border-border text-transparent"
                )}
              >
                <Check className="h-3 w-3" />
              </span>
              <div className="min-w-0 flex-1">
                <div
                  className={cn(
                    "text-sm font-medium",
                    done
                      ? "text-muted-foreground line-through"
                      : "text-foreground"
                  )}
                >
                  {item.label}
                </div>
                {!done && (
                  <div className="text-xs text-muted-foreground">
                    {item.desc}
                  </div>
                )}
              </div>
              {!done && (
                <span className="flex-shrink-0 text-xs text-muted-foreground">
                  +{item.points}
                </span>
              )}
            </div>
          );
          if (done) {
            return (
              <div key={item.key} className="cursor-default">
                {inner}
              </div>
            );
          }
          return (
            <Link
              key={item.key}
              href={item.href}
              className="block cursor-pointer"
              data-testid={`checklist-item-${item.key}`}
            >
              {inner}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
