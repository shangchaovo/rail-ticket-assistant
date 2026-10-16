type Box = { left: number; top: number; right: number; bottom: number };
export function tourPosition(target: Box | null, viewport: { width: number; height: number }, card: { width: number; height: number }) {
  const gap = 16, width = Math.min(card.width, viewport.width - 24), height = Math.min(card.height, viewport.height - 24);
  const clamp = (value: number, max: number) => Math.max(12, Math.min(value, max - 12));
  if (!target || viewport.width < 760) {
    const bottom = viewport.height - height - 12;
    const top = target && target.bottom + gap > bottom && target.top - gap - height >= 12
      ? target.top - gap - height : bottom;
    return { left: Math.max(12, (viewport.width - width) / 2), top };
  }
  let left = (viewport.width - width) / 2, top = target.bottom + gap;
  if (target.right + gap + width <= viewport.width - 12) { left = target.right + gap; top = target.top; }
  else if (target.left - gap - width >= 12) { left = target.left - gap - width; top = target.top; }
  else if (top + height > viewport.height - 12) top = target.top - height - gap;
  return { left: clamp(left, viewport.width - width), top: clamp(top, viewport.height - height) };
}
