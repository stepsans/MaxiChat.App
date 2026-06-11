import { db } from "@workspace/db";
import { platformSettingsTable } from "@workspace/db";
import { logger } from "./logger";

export async function seedPlatformSettingsDefaults(): Promise<void> {
  const defaults = [
    { key: "resend_api_key",   value: "" },
    { key: "resend_from",      value: "noreply@maxichat.app" },
    { key: "resend_from_name", value: "MaxiChat" },
    { key: "smtp_host",        value: "smtp.gmail.com" },
    { key: "smtp_port",        value: "587" },
    { key: "smtp_secure",      value: "false" },
    { key: "smtp_user",        value: "" },
    { key: "smtp_pass",        value: "" },
    { key: "smtp_from",        value: "" },
    { key: "smtp_from_name",   value: "MaxiChat" },
    { key: "owner_email",      value: "" },
    { key: "app_url",          value: process.env.PUBLIC_URL || "" },
  ];
  for (const d of defaults) {
    await db.insert(platformSettingsTable).values(d).onConflictDoNothing();
  }
  logger.info("Platform settings defaults seeded");
}
