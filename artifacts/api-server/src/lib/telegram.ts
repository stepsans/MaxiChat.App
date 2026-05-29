// Minimal Telegram Bot API client. We only use a handful of endpoints
// (getMe / setWebhook / deleteWebhook / sendMessage) and call them via
// native fetch so this stays a single dependency-free file.
//
// All functions throw on transport failures and return the parsed `result`
// object on success. They never log the bot token — callers must redact it
// before adding to any error context.

const API = "https://api.telegram.org";

type TgResponse<T> =
  | { ok: true; result: T }
  | { ok: false; description?: string; error_code?: number };

async function call<T>(
  token: string,
  method: string,
  body?: Record<string, unknown>
): Promise<T> {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as TgResponse<T>;
  if (!json.ok) {
    const desc = (json as { description?: string }).description ?? "unknown";
    throw new Error(`telegram ${method} failed: ${desc}`);
  }
  return json.result;
}

export type TelegramBotInfo = {
  id: number;
  username: string;
  firstName: string;
};

export async function getMe(token: string): Promise<TelegramBotInfo> {
  const me = await call<{
    id: number;
    username?: string;
    first_name?: string;
  }>(token, "getMe");
  return {
    id: me.id,
    username: me.username ?? "",
    firstName: me.first_name ?? "",
  };
}

// Register a webhook. Telegram echoes our `secret_token` back in the
// `X-Telegram-Bot-Api-Secret-Token` header on every POST so we can verify
// the request really came from Telegram and not a spoofer.
export async function setWebhook(
  token: string,
  url: string,
  secretToken: string
): Promise<void> {
  await call(token, "setWebhook", {
    url,
    secret_token: secretToken,
    // We don't currently process inline queries, callback queries, etc.
    allowed_updates: ["message", "edited_message"],
    drop_pending_updates: true,
  });
}

export async function deleteWebhook(token: string): Promise<void> {
  await call(token, "deleteWebhook", { drop_pending_updates: false });
}

export async function sendMessage(
  token: string,
  chatId: number | string,
  text: string
): Promise<{ messageId: number }> {
  const r = await call<{ message_id: number }>(token, "sendMessage", {
    chat_id: chatId,
    text,
  });
  return { messageId: r.message_id };
}

// Send a file as a document. Telegram's sendDocument requires
// multipart/form-data (the JSON `call` helper above can't carry the binary),
// so we build a FormData with the file as a Blob and POST it directly.
export async function sendDocument(
  token: string,
  chatId: number | string,
  document: Uint8Array,
  filename: string,
  caption?: string,
  mimeType = "application/octet-stream"
): Promise<{ messageId: number }> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);
  // Copy into a fresh ArrayBuffer-backed view so the Blob ctor accepts it
  // regardless of the source buffer's backing store (SharedArrayBuffer etc.).
  const bytes = new Uint8Array(document.byteLength);
  bytes.set(document);
  form.append("document", new Blob([bytes], { type: mimeType }), filename);
  const res = await fetch(`${API}/bot${token}/sendDocument`, {
    method: "POST",
    body: form,
  });
  const json = (await res.json()) as TgResponse<{ message_id: number }>;
  if (!json.ok) {
    const desc = (json as { description?: string }).description ?? "unknown";
    throw new Error(`telegram sendDocument failed: ${desc}`);
  }
  return { messageId: json.result.message_id };
}

// ---------- Inbound update normalisation ----------
//
// We accept Telegram's raw Update payload but only consume `message` and
// `edited_message`. Group / channel / inline / callback updates are
// silently ignored in MVP — matches WhatsApp where the AI also skips
// groups.

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};

export type TelegramMessage = {
  message_id: number;
  date: number;
  chat: {
    id: number;
    type: "private" | "group" | "supergroup" | "channel";
    username?: string;
    first_name?: string;
    last_name?: string;
    title?: string;
  };
  from?: {
    id: number;
    is_bot: boolean;
    first_name?: string;
    last_name?: string;
    username?: string;
  };
  text?: string;
};

export type ParsedTelegramMessage = {
  // Stable conversation identifier we persist in chats.phone_number. We
  // prefix with "tg:" so it never collides with a WA "+digits" number and
  // negative group ids stay distinguishable from positive private ids.
  chatKey: string;
  // Numeric chat_id used when calling sendMessage. Stored separately
  // because we don't want to re-derive it from chatKey on every send.
  telegramChatId: number;
  isPrivate: boolean;
  contactName: string;
  text: string;
  messageId: number;
  fromBot: boolean;
};

export function parseTelegramMessage(
  msg: TelegramMessage
): ParsedTelegramMessage | null {
  if (!msg.text) return null; // MVP: text only.
  const isPrivate = msg.chat.type === "private";
  const chatKey = `tg:${msg.chat.id}`;
  const contactName = isPrivate
    ? [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(" ") ||
      msg.chat.username ||
      String(msg.chat.id)
    : msg.chat.title || String(msg.chat.id);
  return {
    chatKey,
    telegramChatId: msg.chat.id,
    isPrivate,
    contactName,
    text: msg.text,
    messageId: msg.message_id,
    fromBot: msg.from?.is_bot ?? false,
  };
}

// Build the absolute webhook URL Telegram will POST updates to. Uses the
// first entry of REPLIT_DOMAINS (the public HTTPS proxy). Throws when
// unset — callers should fail the pair request rather than register a
// webhook against a localhost url.
export function buildWebhookUrl(channelId: number): string {
  const domains = process.env["REPLIT_DOMAINS"];
  if (!domains) {
    throw new Error(
      "REPLIT_DOMAINS env var not set; cannot register Telegram webhook"
    );
  }
  const first = domains.split(",")[0]?.trim();
  if (!first) {
    throw new Error("REPLIT_DOMAINS is empty");
  }
  return `https://${first}/api/webhooks/telegram/${channelId}`;
}

// Cryptographically-random secret used as the `secret_token` Telegram
// echoes in the X-Telegram-Bot-Api-Secret-Token header. We compare with
// timingSafeEqual on receive. Telegram allows 1-256 chars matching
// [A-Za-z0-9_-]; 32 url-safe bytes well within that.
export function generateWebhookSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}
