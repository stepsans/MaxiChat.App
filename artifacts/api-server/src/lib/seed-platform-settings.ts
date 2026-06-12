import { db } from "@workspace/db";
import { platformSettingsTable } from "@workspace/db";
import { logger } from "./logger";

export async function seedPlatformSettingsDefaults(): Promise<void> {
  const defaults = [
    { key: "email_provider",      value: "resend" },
    { key: "resend_api_key",      value: "" },
    { key: "resend_from",         value: "noreply@maxichat.app" },
    { key: "resend_from_name",    value: "MaxiChat" },
    { key: "gmail_user",          value: "" },
    { key: "gmail_client_id",     value: "" },
    { key: "gmail_client_secret", value: "" },
    { key: "gmail_refresh_token", value: "" },
    { key: "gmail_from_name",     value: "MaxiChat" },
    { key: "owner_email",         value: "" },
    { key: "app_url",             value: process.env.PUBLIC_URL || "" },
  ];
  for (const d of defaults) {
    await db.insert(platformSettingsTable).values(d).onConflictDoNothing();
  }
  logger.info("Platform settings defaults seeded");
}
