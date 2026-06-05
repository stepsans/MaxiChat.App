---
name: AI auto-reply context anchoring
description: Why auto-reply history must be ordered AND anchored to the triggering message id, and why few-shot examples in tenant prompts misfire.
---

# AI auto-reply context anchoring

The WhatsApp/Telegram AI auto-reply builds its prompt from: tenant system prompt + knowledge base + the last N chat messages + the new message. Two failure modes bit us:

## 1. History must be ordered AND causally anchored
- Fetching recent messages with `LIMIT 10` and **no `ORDER BY`** returns rows in arbitrary Postgres order — stale months-old turns leaked in and the latest turns dropped out, so the model latched onto outdated context.
- Ordering alone isn't enough: the reply fires inside a 1–3s `setTimeout` delay, during which **newer messages can arrive and be persisted**. So anchor to the triggering message's DB id: `WHERE id <= triggerMessageId ORDER BY id DESC LIMIT 10` then `.reverse()`.
- **Why id, not timestamp:** ids are monotonic per insert and immutable; the triggering row is already persisted before the reply runs, so `id <=` deterministically reconstructs "the conversation as it was when this message arrived." Dedup the explicit trailing user turn by checking the last history item, not by re-querying.
- **How to apply:** thread the inserted row id out of the persist function and through the auto-reply call chain. Callers that can't supply it (e.g. the Telegram webhook) safely fall back to plain latest-10 ordering via an optional param.

## 2. Few-shot examples in the tenant system prompt are answer anchors
- A tenant prompt that embeds **real product codes/prices** in its format examples makes the model copy those exact products as answers to ambiguous questions instead of resolving the query against the knowledge base.
- **Why:** worked examples act as few-shot demonstrations; the model imitates them.
- **How to apply:** when advising owners, examples in the prompt must use **dummy** codes/names/prices and be explicitly labelled format-only + forbidden as answers; add a rule to look up any mentioned code/series in the knowledge base first and never carry over a previous comparison unless asked.
