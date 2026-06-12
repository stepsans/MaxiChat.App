---
name: Radix Select forbids empty-string item value
description: Why a "none"/clear option in a shadcn/Radix Select must use a sentinel value, not ""
---

Radix UI's `Select.Item` (the shadcn `SelectItem`) throws at runtime if its `value` is the empty string — message: "A `<Select.Item />` must have a value prop that is not an empty string." Radix reserves `""` to mean "cleared selection / show placeholder". This crashes the whole React tree when the offending Select renders (e.g. opening a modal that contains it).

**Why:** the empty string is Radix's internal sentinel for "no value", so it cannot also be a selectable item value.

**How to apply:** for a "none"/"no column"/"all" option, give the item a real sentinel value (e.g. `"__none__"`), and map it back to `""`/`null` in the component's own state via the Select's `value` (`state === "" ? SENTINEL : state`) and `onValueChange` (`v === SENTINEL ? "" : v`). The codebase uses shadcn Select widely, so apply this anywhere a Select needs a clear/empty choice.
