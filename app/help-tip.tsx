'use client';

import { useId, useRef, useState, type ReactNode } from 'react';
import { Tooltip } from '@base-ui/react/tooltip';
import './help-tip.css';

export type HelpTipProps = {
  label: string;
  children: ReactNode;
  side?: 'top' | 'bottom';
  className?: string;
};

/** Short, non-interactive explanations beside a field or option label. */
export default function HelpTip({ label, children, side = 'top', className }: HelpTipProps) {
  const triggerId = useId(), descriptionId = useId();
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);

  return <Tooltip.Root open={open} triggerId={triggerId} onOpenChange={(next, details) => {
    // A tap/click keeps the explanation available until another tap, Escape,
    // blur or an outside press. Hover alone continues to behave as a tooltip.
    if (!next && pinned.current && details.reason === 'trigger-hover') {
      details.cancel();
      return;
    }
    if (!next) pinned.current = false;
    setOpen(next);
  }}>
    <Tooltip.Trigger
      id={triggerId}
      type="button"
      className={`help-tip-trigger${className ? ` ${className}` : ''}`}
      aria-label={`了解${label}`}
      aria-expanded={open}
      aria-describedby={open ? descriptionId : undefined}
      delay={200}
      closeDelay={80}
      closeOnClick={false}
      onPointerDown={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
      }}
      onClick={event => {
        // Also prevent a containing label from toggling its checkbox.
        event.preventDefault();
        event.stopPropagation();
        pinned.current = !pinned.current;
        setOpen(pinned.current);
      }}
    ><span aria-hidden="true">?</span></Tooltip.Trigger>
    <Tooltip.Portal>
      <Tooltip.Positioner className="help-tip-positioner" side={side} align="center" sideOffset={7} collisionPadding={12} positionMethod="fixed">
        <Tooltip.Popup id={descriptionId} role="tooltip" className="help-tip-popup">
          {children}
        </Tooltip.Popup>
      </Tooltip.Positioner>
    </Tooltip.Portal>
  </Tooltip.Root>;
}
