---
name: WhatsApp outbound automation must be paced
description: Every automated WhatsApp send path must throttle + show typing, or it raises the number's ban/restriction risk.
---

# All automated WhatsApp sends must be human-paced

The app talks to WhatsApp via Baileys (unofficial WhatsApp Web). Sending
messages back-to-back in milliseconds — especially several in one burst (e.g.
a Products node firing many image cards) — is a strong bot/spam signal and a
top cause of a number getting **restricted/banned**.

**Rule:** every automated outbound path (AI auto-reply AND chatbot flow) must
insert a random per-message delay and ideally a "composing/paused" typing
presence before each send. When you add a NEW flow node type or any new
outbound automation, it MUST go through the same paced send helper — do not
add a raw `sock.sendMessage` loop that fires without delay.

**Why:** a number was restricted; the AI auto-reply was already delayed but
the chatbot flow sent with zero delay, so multi-message steps fired instantly.

**How to apply:**
- Reuse the tenant-wide reply-delay bounds (`replyDelayMin`/`replyDelayMax`,
  seconds) so AI and flow share ONE admin-facing setting. Note: setting them
  to 0/0 disables flow pacing too.
- Delay is applied PER message (inside the per-product loop), not once per
  flow step — otherwise a burst of product cards is still unpaced.
- After the (non-trivial) delay/await, RE-CHECK epoch + socket before sending;
  the channel may have disconnected during the wait.
- Typing presence is best-effort: swallow presence errors, never let them
  block the actual send.
- This is WhatsApp/Baileys-specific. Telegram has no echo/ban model like this
  and uses its own send path.
