import { Sparkles } from "lucide-react";

// Small pill showing which centralized AI engine produced an insight, so the
// owner can compare analysis quality across engines (Gemini vs Claude, etc.).
// Hidden when the engine is unknown (e.g. an errored insight).
export function EngineBadge({ engine }: { engine?: string | null }) {
  if (!engine) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-purple-500/10 px-2 py-0.5 text-[10px] font-normal text-purple-600 dark:text-purple-300"
      title={`Insight ini dianalisa oleh ${engine}`}
    >
      <Sparkles className="h-2.5 w-2.5" /> {engine}
    </span>
  );
}
