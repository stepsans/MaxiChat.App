import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decideManualFollowUpSend,
  type FollowUpStatus,
} from "./follow-up-manual-build";

describe("decideManualFollowUpSend", () => {
  it("allows sending a pending follow-up on a WhatsApp channel", () => {
    assert.deepEqual(
      decideManualFollowUpSend({
        followUpStatus: "pending",
        channelKind: "whatsapp",
      }),
      { ok: true }
    );
  });

  it("rejects a non-pending follow-up with not_pending", () => {
    for (const status of ["sent", "cancelled", "skipped"] as FollowUpStatus[]) {
      assert.deepEqual(
        decideManualFollowUpSend({ followUpStatus: status, channelKind: "whatsapp" }),
        { ok: false, code: "not_pending" }
      );
    }
  });

  it("rejects a non-WhatsApp channel with not_whatsapp", () => {
    for (const kind of ["telegram", "", "instagram"]) {
      assert.deepEqual(
        decideManualFollowUpSend({ followUpStatus: "pending", channelKind: kind }),
        { ok: false, code: "not_whatsapp" }
      );
    }
  });

  it("prioritizes the not_pending check over the channel check", () => {
    // A sent touch on a non-WA channel reports not_pending (status first).
    assert.deepEqual(
      decideManualFollowUpSend({ followUpStatus: "sent", channelKind: "telegram" }),
      { ok: false, code: "not_pending" }
    );
  });
});
