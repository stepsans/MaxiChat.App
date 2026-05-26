import { useRoute } from "wouter";
import ChatListPane from "@/components/ChatListPane";
import ConversationPane from "@/components/ConversationPane";
import { SiWhatsapp } from "react-icons/si";
import { Lock } from "lucide-react";

// Two-pane WhatsApp Web layout: chat list on the left, open conversation
// on the right. On mobile, only one is visible at a time and the URL drives
// which one (the conversation pane has its own back button to return to the
// list).
export default function Chats() {
  const [match, params] = useRoute<{ id: string }>("/chats/:id");
  const chatId = match && params?.id ? Number(params.id) : null;

  return (
    <div className="flex h-full w-full bg-[hsl(var(--wa-conversation))]">
      {/* List pane: full width on mobile when no chat is selected, fixed 400px on desktop */}
      <div
        className={
          chatId
            ? "hidden md:flex md:w-[400px] md:flex-shrink-0"
            : "flex flex-1 md:w-[400px] md:flex-grow-0 md:flex-shrink-0"
        }
      >
        <div className="flex-1 min-w-0">
          <ChatListPane selectedChatId={chatId} />
        </div>
      </div>

      {/* Conversation pane: hidden on mobile until chat is selected */}
      {chatId ? (
        <ConversationPane chatId={chatId} />
      ) : (
        <div className="hidden md:flex flex-1 flex-col items-center justify-center wa-doodle-bg border-l border-[hsl(var(--wa-divider))] relative">
          <div className="absolute top-0 left-0 right-0 h-1 bg-[hsl(var(--wa-accent))]" />
          <div className="flex flex-col items-center text-center max-w-md px-8">
            <div className="w-32 h-32 rounded-full bg-[hsl(var(--wa-panel-header))] flex items-center justify-center mb-6">
              <SiWhatsapp className="w-16 h-16 text-[hsl(var(--wa-meta))]" />
            </div>
            <h2 className="text-[28px] font-light text-foreground mb-3">
              MaxiCS
            </h2>
            <p className="text-[14px] text-[hsl(var(--wa-meta))] mb-2 leading-relaxed">
              Kirim &amp; terima pesan tanpa perlu HP online. AI menjawab otomatis
              24/7 berdasarkan knowledge base dan katalog Anda.
            </p>
            <p className="text-[14px] text-[hsl(var(--wa-meta))] mb-8 leading-relaxed">
              Pilih chat dari daftar di sebelah kiri untuk membuka percakapan.
            </p>
            <div className="flex items-center gap-2 text-[12px] text-[hsl(var(--wa-meta))]">
              <Lock className="w-3 h-3" />
              <span>Terenkripsi end-to-end oleh WhatsApp</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
