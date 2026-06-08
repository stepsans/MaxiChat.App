import * as SecureStore from "expo-secure-store";
import {
  setBaseUrl,
  setAuthTokenGetter,
  setChannelIdGetter,
} from "@workspace/api-client-react";

export const API_BASE = `https://${process.env.EXPO_PUBLIC_API_DOMAIN}`;

const TOKEN_KEY = "maxichat_token";

let currentToken: string | null = null;
let currentChannelId: string | null = null;

/**
 * Wire the generated API client to this app's auth + channel state. Called once
 * at module load (outside React) so every generated hook/fetcher attaches the
 * bearer token and X-Channel-Id header automatically.
 */
export function configureApiClient(): void {
  setBaseUrl(API_BASE);
  setAuthTokenGetter(() => currentToken);
  setChannelIdGetter(() => currentChannelId);
}

export function setMemToken(token: string | null): void {
  currentToken = token;
}

export function getMemToken(): string | null {
  return currentToken;
}

export function setMemChannelId(id: number | string | null): void {
  currentChannelId = id == null ? null : String(id);
}

export async function loadStoredToken(): Promise<string | null> {
  try {
    const t = await SecureStore.getItemAsync(TOKEN_KEY);
    currentToken = t;
    return t;
  } catch {
    return null;
  }
}

export async function persistToken(token: string | null): Promise<void> {
  currentToken = token;
  try {
    if (token) await SecureStore.setItemAsync(TOKEN_KEY, token);
    else await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {
    // best-effort; in-memory token still works for this session
  }
}

type UploadFile = { uri: string; name: string; type: string };

async function rawUpload<T = unknown>(
  path: string,
  body: FormData,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (currentToken) headers["authorization"] = `Bearer ${currentToken}`;
  if (currentChannelId) headers["x-channel-id"] = currentChannelId;
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers,
    body,
    credentials: "include",
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      msg = (j && (j.error || j.detail || j.message)) || msg;
    } catch {
      // ignore parse failure
    }
    throw new Error(msg);
  }
  try {
    return (await res.json()) as T;
  } catch {
    return undefined as T;
  }
}

/** Send a media message into a chat. Not in OpenAPI (binary multipart). */
export async function uploadChatMedia(
  chatId: number,
  file: UploadFile,
  caption: string,
): Promise<void> {
  const fd = new FormData();
  // React Native FormData accepts the {uri,name,type} shape.
  fd.append("file", file as unknown as Blob);
  if (caption) fd.append("caption", caption);
  await rawUpload(`/api/chats/${chatId}/media`, fd);
}

/** Post an image WhatsApp Status. Not in OpenAPI (binary multipart). */
export async function uploadImageStatus(
  file: UploadFile,
  caption: string,
): Promise<void> {
  const fd = new FormData();
  fd.append("file", file as unknown as Blob);
  if (caption) fd.append("caption", caption);
  await rawUpload(`/api/statuses/media`, fd);
}

/**
 * Upload a new profile picture and persist it on the current user. Mirrors the
 * web flow: POST the bytes to /agents/upload-photo (→ {url}), then PATCH that
 * url onto /auth/me/photo. Neither endpoint is in OpenAPI (binary multipart /
 * raw patch), so both go through raw fetch. Returns the new public URL.
 */
export async function uploadProfilePhoto(file: UploadFile): Promise<string> {
  const fd = new FormData();
  fd.append("file", file as unknown as Blob);
  const up = await rawUpload<{ url: string }>("/api/agents/upload-photo", fd);
  const newUrl = up?.url;
  if (!newUrl) throw new Error("Upload gagal");

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (currentToken) headers["authorization"] = `Bearer ${currentToken}`;
  if (currentChannelId) headers["x-channel-id"] = currentChannelId;
  const res = await fetch(`${API_BASE}/api/auth/me/photo`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ profilePhotoUrl: newUrl }),
    credentials: "include",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return newUrl;
}

/** Resolve a possibly-relative media path into an absolute URL. */
export function resolveMediaUrl(pathOrUrl: string | null | undefined): string | null {
  if (!pathOrUrl) return null;
  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
    return pathOrUrl;
  }
  if (pathOrUrl.startsWith("/")) return `${API_BASE}${pathOrUrl}`;
  return pathOrUrl;
}
