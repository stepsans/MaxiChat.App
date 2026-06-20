import { and, eq } from "drizzle-orm";
import { db, contactLeadStatusTable } from "@workspace/db";

// Contact-level lead status helpers shared by the chat routes (manual edits) and
// the AI Pipeline (auto-classification). Keyed by (ownerUserId, phoneNumber) so
// a classification follows the contact across every channel.
//
// Override rule: a 'manual' classification ALWAYS wins. The AI setter never
// overwrites a row that a human last touched.

export type LeadStatus = "unknown" | "lead" | "not_lead";
export type LeadClassifiedBy = "manual" | "ai";

export async function getContactLeadStatus(
  ownerUserId: number,
  phoneNumber: string
): Promise<{ leadStatus: string; leadClassifiedBy: string } | null> {
  const [row] = await db
    .select({
      leadStatus: contactLeadStatusTable.leadStatus,
      leadClassifiedBy: contactLeadStatusTable.leadClassifiedBy,
    })
    .from(contactLeadStatusTable)
    .where(
      and(
        eq(contactLeadStatusTable.ownerUserId, ownerUserId),
        eq(contactLeadStatusTable.phoneNumber, phoneNumber)
      )
    )
    .limit(1);
  return row ?? null;
}

// Manual set (user via dropdown). Always marks the row 'manual'.
export async function setContactLeadStatusManual(
  ownerUserId: number,
  phoneNumber: string,
  leadStatus: string
): Promise<void> {
  await db
    .insert(contactLeadStatusTable)
    .values({ ownerUserId, phoneNumber, leadStatus, leadClassifiedBy: "manual" })
    .onConflictDoUpdate({
      target: [
        contactLeadStatusTable.ownerUserId,
        contactLeadStatusTable.phoneNumber,
      ],
      set: { leadStatus, leadClassifiedBy: "manual", updatedAt: new Date() },
    });
}

// AI set (AI Pipeline). Upserts, but NEVER overrides a row last touched
// manually (setWhere guards the UPDATE branch). Inserts a new row as 'ai'.
export async function setContactLeadStatusByAi(
  ownerUserId: number,
  phoneNumber: string,
  leadStatus: string
): Promise<void> {
  await db
    .insert(contactLeadStatusTable)
    .values({ ownerUserId, phoneNumber, leadStatus, leadClassifiedBy: "ai" })
    .onConflictDoUpdate({
      target: [
        contactLeadStatusTable.ownerUserId,
        contactLeadStatusTable.phoneNumber,
      ],
      set: { leadStatus, leadClassifiedBy: "ai", updatedAt: new Date() },
      setWhere: eq(contactLeadStatusTable.leadClassifiedBy, "ai"),
    });
}
