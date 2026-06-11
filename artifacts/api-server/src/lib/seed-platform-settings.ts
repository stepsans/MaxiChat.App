import { db } from "@workspace/db";
import { platformSettingsTable } from "@workspace/db";
import { logger } from "./logger";

export async function seedPlatformSettingsDefaults(): Promise<void> {
  const defaults = [
    { key: "smtp_host",      value: "smtp.gmail.com" },
    { key: "smtp_port",      value: "587" },
    { key: "smtp_secure",    value: "false" },
    { key: "smtp_user",      value: "info@maxichat.app" },
    { key: "smtp_pass",      value: "zjug flkm fcpr vtkk" },
    { key: "smtp_from",      value: "info@maxichat.app" },
    { key: "smtp_from_name", value: "MaxiChat" },
    { key: "owner_email",    value: "" },
    { key: "app_url",        value: process.env.PUBLIC_URL || "" },
  ];
  for (const d of defaults) {
    await db.insert(platformSettingsTable).values(d).onConflictDoNothing();
  }
  logger.info("Platform settings defaults seeded");
}
