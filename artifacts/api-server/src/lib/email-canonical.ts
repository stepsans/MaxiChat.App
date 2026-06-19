import { DISPOSABLE_DOMAINS } from "./disposable-domains";

// Kanonikalisasi untuk pencocokan anti-abuse:
// - lowercase + trim
// - buang segala sesudah '+' di local-part (alias trick)
// - untuk gmail.com / googlemail.com: buang semua titik di local-part &
//   samakan domain ke gmail.com (Google memperlakukan titik sebagai sama).
export function canonicalizeEmail(input: string): string {
  const e = input.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 0) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus >= 0) local = local.slice(0, plus);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

export function isDisposableEmail(input: string): boolean {
  const at = input.lastIndexOf("@");
  if (at < 0) return false;
  const domain = input.slice(at + 1).trim().toLowerCase();
  return DISPOSABLE_DOMAINS.has(domain);
}
