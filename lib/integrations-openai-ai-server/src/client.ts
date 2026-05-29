import OpenAI from "openai";

if (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL) {
  throw new Error(
    "AI_INTEGRATIONS_OPENAI_BASE_URL must be set. Did you forget to provision the OpenAI AI integration?",
  );
}

if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
  throw new Error(
    "AI_INTEGRATIONS_OPENAI_API_KEY must be set. Did you forget to provision the OpenAI AI integration?",
  );
}

export const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

// Build an ad-hoc OpenAI-compatible client from caller-supplied credentials.
// Used for "bring your own key" (BYOK) tenants: OpenAI uses the default base
// URL (pass undefined), while Gemini and OpenRouter are reached through their
// OpenAI-compatible endpoints by passing the respective baseURL.
export function createOpenAiClient(opts: {
  apiKey: string;
  baseURL?: string;
}): OpenAI {
  return new OpenAI({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  });
}
