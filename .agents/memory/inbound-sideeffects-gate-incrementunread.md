---
name: Inbound side-effects must gate on incrementUnread
description: Why new per-message side-effects (AI runs, push, badges) must check opts.incrementUnread, not just direction/fromMe.
---

Any side-effect attached to a newly-persisted inbound WhatsApp message — AI Sales
detection, auto-reply triggers, notifications, unread counts — must be gated on
`opts.incrementUnread` in `persistWaMessage`, in addition to `inbound && !fromMe`.

**Why:** history sync calls `persistWaMessage` with `incrementUnread:false` to
back-fill old conversations. A condition that only checks direction/`fromMe`
will fire the side-effect for every back-filled message, e.g. spending AI tokens
re-analyzing the entire chat history on reconnect. `incrementUnread` is the one
flag that distinguishes a genuinely-new live message from a back-fill.

**How to apply:** when wiring a new hook after the inbound-insert block in
`persistWaMessage`, copy the existing `opts.incrementUnread && !parsed.fromMe`
gate the unread/notification paths already use — never gate on `direction` alone.
