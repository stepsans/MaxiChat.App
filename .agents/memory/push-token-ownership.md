---
name: Push token ownership & recipient scoping
description: Security rules for device-token endpoints and inbound push fan-out — delete-by-external-id must be owner-scoped; recipients must be active-only.
---

# Push device tokens & inbound notification fan-out

Two security rules for Expo push (device_tokens + notifyInboundMessage):

1. **Unregister / delete-by-token must be owner-scoped.** A token string is an
   externally-supplied identifier, so deleting `WHERE token = ?` alone lets any
   authenticated user disable another user's notifications (cross-account DoS).
   Always scope the delete by `AND user_id = currentUserId`.
   **Why:** `/push/unregister` takes a caller-provided token; without the
   ownership predicate it's a horizontal-privilege bug.
   **How to apply:** Any endpoint that mutates/deletes a row keyed by a value the
   client supplies (token, external_id, code) must add an ownership/tenant
   predicate, not just `requireAuth`.

2. **Push recipients must be filtered to `users.status = "active"`.** The
   inbound-message fan-out selects owner + `parentUserId` team members; a disabled
   account that still has device_tokens rows would keep receiving message
   previews. Add `eq(usersTable.status, "active")` to the candidate query.
   **Why:** disabling an account must immediately cut off message-content leakage,
   not just block login.
   **How to apply:** any new push/notification fan-out that enumerates tenant
   members must filter active users before selecting their tokens.
