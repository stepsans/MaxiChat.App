import { InfoBar } from "./InfoBar";
import { ChatHistoryTable } from "./ChatHistoryTable";
import { NextActionBox } from "./NextActionBox";
import type { PeriodKey } from "./format";

export function ChatHistoryTab({ period, from, to }: { period: PeriodKey; from?: string; to?: string }) {
  return (
    <div className="space-y-4">
      <InfoBar
        dismissKey="history"
        text="Cari dan filter semua percakapan yang pernah terjadi. Klik percakapan mana saja untuk membukanya langsung. Gunakan Export untuk mengunduh data dalam format CSV."
      />
      <ChatHistoryTable period={period} from={from} to={to} />
      <NextActionBox context="history" />
    </div>
  );
}
