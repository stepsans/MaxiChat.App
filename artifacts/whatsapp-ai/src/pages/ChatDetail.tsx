import { useState, useEffect } from "react";
import { useParams, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetChat,
  useUpdateChat,
  useSendManualReply,
  useTakeoverChat,
  getGetChatQueryKey,
  getListChatsQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  ArrowLeft,
  Bot,
  Send,
  UserCheck,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";

export default function ChatDetail() {
  const { id } = useParams<{ id: string }>();
  const chatId = Number(id);
  const qc = useQueryClient();
  const { toast } = useToast();
  const [reply, setReply] = useState("");

  const { data: chat, isLoading } = useGetChat(chatId, {
    query: {
      enabled: !!chatId,
      queryKey: getGetChatQueryKey(chatId),
      refetchInterval: 5000,
    },
  });

  const updateChat = useUpdateChat({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetChatQueryKey(chatId) });
        qc.invalidateQueries({ queryKey: getListChatsQueryKey() });
      },
    },
  });

  const sendReply = useSendManualReply({
    mutation: {
      onSuccess: () => {
        setReply("");
        qc.invalidateQueries({ queryKey: getGetChatQueryKey(chatId) });
        qc.invalidateQueries({ queryKey: getListChatsQueryKey() });
        toast({ title: "Reply sent." });
      },
    },
  });

  const takeover = useTakeoverChat({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetChatQueryKey(chatId) });
        qc.invalidateQueries({ queryKey: getListChatsQueryKey() });
      },
    },
  });

  useEffect(() => {
    if (chat) {
      qc.invalidateQueries({ queryKey: getListChatsQueryKey() });
    }
  }, [chat?.id]);

  if (isLoading) {
    return (
      <div className="p-6 space-y-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!chat) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <p>Chat not found</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 h-14 border-b border-border flex-shrink-0">
        <Link
          href="/chats"
          data-testid="button-back-to-chats"
          className="p-1.5 rounded-md hover:bg-accent transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-sm font-semibold flex-shrink-0">
          {chat.contactName.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate">{chat.contactName}</p>
          <p className="text-xs text-muted-foreground">{chat.phoneNumber}</p>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-3">
          <Select
            value={chat.tag}
            onValueChange={(val) =>
              updateChat.mutate({ id: chatId, data: { tag: val as any } })
            }
          >
            <SelectTrigger data-testid="select-chat-tag" className="h-7 w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No tag</SelectItem>
              <SelectItem value="hot_lead">Hot Lead</SelectItem>
              <SelectItem value="cold">Cold</SelectItem>
              <SelectItem value="closing">Closing</SelectItem>
            </SelectContent>
          </Select>

          <Select
            value={chat.status}
            onValueChange={(val) =>
              updateChat.mutate({ id: chatId, data: { status: val as any } })
            }
          >
            <SelectTrigger data-testid="select-chat-status" className="h-7 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ai_handled">AI Handled</SelectItem>
              <SelectItem value="needs_human">Needs Human</SelectItem>
              <SelectItem value="closed">Closed</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex items-center gap-2">
            <Switch
              data-testid="switch-human-takeover"
              id="takeover"
              checked={chat.isHumanTakeover}
              onCheckedChange={(checked) =>
                takeover.mutate({ id: chatId, data: { takeover: checked } })
              }
            />
            <Label htmlFor="takeover" className="text-xs text-muted-foreground">
              Human mode
            </Label>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {chat.messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <p className="text-sm">No messages yet</p>
          </div>
        ) : (
          chat.messages.map((msg) => {
            const isOutbound = msg.direction === "outbound";
            return (
              <div
                key={msg.id}
                data-testid={`message-${msg.id}`}
                className={cn("flex", isOutbound ? "justify-end" : "justify-start")}
              >
                <div
                  className={cn(
                    "max-w-[70%] rounded-lg px-3 py-2 text-sm",
                    isOutbound
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-foreground"
                  )}
                >
                  <p className="leading-relaxed">{msg.content}</p>
                  <div className="flex items-center gap-1 mt-1">
                    <span className="text-[10px] opacity-60">
                      {format(new Date(msg.createdAt), "HH:mm")}
                    </span>
                    {isOutbound && msg.isAiGenerated && (
                      <Bot className="w-2.5 h-2.5 opacity-60" />
                    )}
                    {isOutbound && !msg.isAiGenerated && (
                      <UserCheck className="w-2.5 h-2.5 opacity-60" />
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Reply Box */}
      <div className="px-4 py-3 border-t border-border flex-shrink-0">
        {chat.isHumanTakeover && (
          <p className="text-xs text-yellow-400 mb-2 flex items-center gap-1">
            <UserCheck className="w-3 h-3" />
            Human mode — AI auto-reply is paused for this chat
          </p>
        )}
        <div className="flex gap-2">
          <Textarea
            data-testid="textarea-reply"
            placeholder="Type a manual reply..."
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            rows={2}
            className="resize-none text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (reply.trim()) {
                  sendReply.mutate({ id: chatId, data: { content: reply.trim() } });
                }
              }
            }}
          />
          <Button
            data-testid="button-send-reply"
            onClick={() => {
              if (reply.trim()) {
                sendReply.mutate({ id: chatId, data: { content: reply.trim() } });
              }
            }}
            disabled={sendReply.isPending || !reply.trim()}
            size="sm"
            className="self-end"
          >
            {sendReply.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
