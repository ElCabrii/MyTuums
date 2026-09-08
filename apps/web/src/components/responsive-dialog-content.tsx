import type { ComponentProps } from "react";
import { DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** Application dialogs own their scrolling and gutters, including long grid content. */
export function ResponsiveDialogContent({
  className,
  ...props
}: ComponentProps<typeof DialogContent>) {
  return (
    <DialogContent
      {...props}
      className={cn(
        "max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] min-w-0 grid-cols-[minmax(0,1fr)] overflow-y-auto overscroll-contain [&>[data-slot=dialog-header]]:pr-8",
        className,
      )}
    />
  );
}
