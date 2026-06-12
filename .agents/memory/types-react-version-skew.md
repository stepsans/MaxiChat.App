---
name: "@types/react version skew (Expo vs web)"
description: Why button-group.tsx / calendar.tsx throw "Two different types with this name exist" — duplicate @types/react, not a real bug.
---

The monorepo resolves **two** `@types/react` copies: Expo/react-native pins `@types/react@19.1.17`, while the web apps use the catalog `^19.2.0` → `19.2.14`. When a web UI file (e.g. `whatsapp-ai/src/components/ui/button-group.tsx`, `calendar.tsx` via react-day-picker / Radix Slot) resolves a ref/props type against the *other* copy, tsc emits the tell-tale **"Two different types with this name exist, but they are unrelated"** (e.g. `VoidOrUndefinedOnly`, `Ref<HTMLDivElement>`).

**Why:** these are NOT logic bugs and NOT codegen drift — they are a dependency-dedup artifact of having Expo (RN-pinned older @types/react) and web (newer @types/react) in the same pnpm tree.

**How to apply:** do not "fix" the component code. Treat as a separate dependency-hygiene task. A global `@types/react` override forcing one version is risky because it can break the Expo/mobile typecheck (RN expects 19.1.x). If a build gate is needed, isolate the override per web app or pin react-day-picker/Radix peers, and re-verify `pnpm --filter @workspace/mobile run typecheck` afterward.
