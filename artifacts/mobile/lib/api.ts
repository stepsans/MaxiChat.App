import * as SecureStore from "expo-secure-store";
import {
  setBaseUrl,
  setAuthTokenGetter,
  setChannelIdGetter,
  setUnauthorizedHandler,
  type AuthUser,
} from "@workspace/api-client-react";

export const API_BASE = `https://${process.env.EXPO_PUBLIC_API_DOMAIN}`;

const TOKEN_KEY = "maxichat_token";
const TRUSTED_KEY = "maxichat_trusted_device";

let currentToken: string | null = null;
let currentChannelId: string | null = null;
let currentTrustedToken: string | null = null;

// Callback fired when an in-session request returns 401 (token expired/revoked).
// AuthContext registers it to reset React auth state and bounce to login.
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedCallback(cb: (() => void) | null): void {
  onUnauthorized = cb;
}

/**
 * Wire the generated API client to this app's auth + channel state. Called once
 * at module load (outside React) so every generated hook/fetcher attaches the
 * bearer token and X-Channel-Id header automatically.
 */
export function configureApiClient(): void {
  setBaseUrl(API_BASE);
  setAuthTokenGetter(() => currentToken);
  setChannelIdGetter(() => currentChannelId);
  // Mid-session 401 → clear the dead token and let AuthContext route to login.
  // Pre-auth 401s (e.g. a wrong OTP at login, when no token is held yet) are
  // ignored so they surface as a normal login error instead of a "logout".
  setUnauthorizedHandler(() => {
    if (!currentToken) return;
    void persistToken(null);
    currentChannelId = null;
    onUnauthorized?.();
  });
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

// Trusted-device token (skip-OTP "remember me"). Stored separately from the
// session token; replayed as the X-Trusted-Device header on the next login.
export async function loadTrustedToken(): Promise<string | null> {
  try {
    const t = await SecureStore.getItemAsync(TRUSTED_KEY);
    currentTrustedToken = t;
    return t;
  } catch {
    return null;
  }
}

export async function persistTrustedToken(token: string | null): Promise<void> {
  currentTrustedToken = token;
  try {
    if (token) await SecureStore.setItemAsync(TRUSTED_KEY, token);
    else await SecureStore.deleteItemAsync(TRUSTED_KEY);
  } catch {
    // best-effort
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

/**
 * POST a JSON body to a public (no-auth) endpoint and return the parsed JSON.
 * Used for the OTP login endpoints, which aren't in the OpenAPI spec (the web
 * dashboard calls them the same way).
 */
async function postJson<T = unknown>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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

/**
 * GET an authenticated JSON endpoint that isn't covered by the generated client
 * (e.g. the WorkBoard board/column/task routes, which aren't in the OpenAPI
 * spec). Attaches the bearer token + X-Channel-Id the same way the generated
 * fetcher does, and surfaces the backend `error` message on failure.
 */
export async function apiGetJson<T = unknown>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (currentToken) headers["authorization"] = `Bearer ${currentToken}`;
  if (currentChannelId) headers["x-channel-id"] = currentChannelId;
  const res = await fetch(`${API_BASE}${path}`, { headers, credentials: "include" });
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

/**
 * POST an authenticated JSON body to an endpoint not in the generated client.
 * Same auth/channel headers as apiGetJson. Used for WorkBoard task creation.
 */
export async function apiPostJson<T = unknown>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (currentToken) headers["authorization"] = `Bearer ${currentToken}`;
  if (currentChannelId) headers["x-channel-id"] = currentChannelId;
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
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

/**
 * PATCH an authenticated JSON body to an endpoint not in the generated client.
 * Same auth/channel headers as apiGetJson. Used for WorkBoard task moves.
 */
export async function apiPatchJson<T = unknown>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (currentToken) headers["authorization"] = `Bearer ${currentToken}`;
  if (currentChannelId) headers["x-channel-id"] = currentChannelId;
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
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

export type MobileSessionResult = {
  token: string;
  user: AuthUser;
  trustedDeviceToken?: string;
};

export type LoginOtpResult = {
  // Trusted-device fast-path: when true the backend already returned a session.
  trusted?: boolean;
  token?: string;
  user?: AuthUser;
  trustedDeviceToken?: string;
  // Normal OTP path.
  ok?: boolean;
  expiresAt?: string;
  devOtp?: string;
};

/**
 * Request a login OTP. Replays a stored trusted-device token via the
 * X-Trusted-Device header; if the backend accepts it, the response carries a
 * ready session ({ trusted:true, token, user, trustedDeviceToken }) and the
 * OTP step is skipped. `devOtp` is only returned outside production.
 */
export async function requestLoginOtp(email: string): Promise<LoginOtpResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (currentTrustedToken) headers["x-trusted-device"] = currentTrustedToken;
  const res = await fetch(`${API_BASE}/api/auth/otp/request`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email }),
  });
  const data = (await res.json().catch(() => ({}))) as LoginOtpResult & { error?: string };
  if (!res.ok && !data.trusted) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

/**
 * Verify the OTP and establish a mobile session, opting into trusted-device so
 * the next login on this device can skip OTP. Raw fetch (not the generated
 * mobileLogin) because the response carries an extra trustedDeviceToken.
 */
export async function mobileLoginWithDevice(
  email: string,
  otp: string,
): Promise<MobileSessionResult> {
  return postJson("/api/auth/mobile-login", {
    email,
    otp,
    rememberDevice: true,
    deviceLabel: "Mobile App",
  });
}

/** Re-send the login OTP (separate rate limit on the backend). */
export async function resendLoginOtp(
  email: string,
): Promise<{ ok?: boolean; expiresAt?: string; devOtp?: string }> {
  return postJson("/api/auth/otp/resend", { email, purpose: "login" });
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

/**
 * Send an album (multiple photos/videos) into a chat in a single request. The
 * backend transmits the items as an ordered sequence over the chat's channel,
 * with a small inter-message delay. The caption (if any) rides on the first
 * item. Not in OpenAPI (binary multipart).
 */
export async function uploadChatAlbum(
  chatId: number,
  files: UploadFile[],
  caption: string,
): Promise<void> {
  const fd = new FormData();
  for (const file of files) fd.append("files", file as unknown as Blob);
  if (caption) fd.append("caption", caption);
  await rawUpload(`/api/chats/${chatId}/album`, fd);
}

/**
 * Send a recorded voice note into a chat. Same multipart endpoint as
 * uploadChatMedia but flags `ptt=true` so the backend transmits it as a
 * WhatsApp push-to-talk voice note (not a regular audio file).
 */
export async function uploadVoiceNote(
  chatId: number,
  file: UploadFile,
): Promise<void> {
  const fd = new FormData();
  fd.append("file", file as unknown as Blob);
  fd.append("ptt", "true");
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
