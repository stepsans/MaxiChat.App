import { useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { resolveImageSrc } from "@/lib/utils";
import { cn } from "@/lib/utils";

// Wraps a product thumbnail so hovering shows a zoom cursor and clicking opens
// a popup with the full-size photo. The trigger is a non-button span so it can
// be nested safely inside the sidebar's product-row <button> (clicking the
// photo opens the preview without toggling the product selection).
export function ProductImageLightbox({
  src,
  alt,
  triggerClassName,
  children,
}: {
  src: string | null | undefined;
  alt: string;
  triggerClassName?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const full = resolveImageSrc(src) ?? src ?? null;

  if (!full) return <>{children}</>;

  return (
    <>
      <span
        role="button"
        tabIndex={0}
        title="Lihat foto"
        aria-label={`Lihat foto ${alt}`}
        className={cn("cursor-zoom-in", triggerClassName)}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.stopPropagation();
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {children}
      </span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg p-2">
          <DialogTitle className="sr-only">{alt}</DialogTitle>
          <img
            src={full}
            alt={alt}
            className="w-full h-auto max-h-[80vh] rounded object-contain"
            referrerPolicy="no-referrer"
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
