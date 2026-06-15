import { useState } from "react";
import { Info, X } from "lucide-react";

/**
 * Dismissable orientation banner shown at the top of each analytics tab.
 * Dismissal persists per `dismissKey` in localStorage.
 */
export function InfoBar({ text, dismissKey }: { text: string; dismissKey: string }) {
  const storageKey = `analytics_infobar_${dismissKey}`;
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  });

  if (dismissed) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(storageKey, "1");
    } catch {
      /* ignore */
    }
    setDismissed(true);
  };

  return (
    <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900 dark:border-blue-900/50 dark:bg-blue-950/40 dark:text-blue-200">
      <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
      <p className="flex-1 leading-relaxed">{text}</p>
      <button
        type="button"
        onClick={dismiss}
        className="flex-shrink-0 opacity-60 hover:opacity-100"
        aria-label="Tutup"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
