import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Backdrop-close drag exemption (R1-①): a touch that moves more than this many pixels between
 * `pointerdown` and `pointerup` is a scroll/page-drift gesture, not a dismiss tap — mobile
 * browsers cancel the `click` when the pointer moves, and the old `onMouseDown` backdrop
 * closed the dialog out from under the finger. Only a near-stationary press on the backdrop
 * itself dismisses.
 */
export const BACKDROP_DRAG_EXEMPT_PX = 10;

export interface BackdropPoint {
  x: number;
  y: number;
}

/**
 * True when a pointer gesture that started at `start` and ended at `end` counts as a backdrop
 * dismiss tap: both endpoints known and the displacement under the drag-exemption budget.
 * Pure so the gesture rule is unit-testable without a DOM.
 */
export function isBackdropDismissTap(start: BackdropPoint | null, end: BackdropPoint | null): boolean {
  if (start === null || end === null) return false;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  return Math.sqrt(dx * dx + dy * dy) < BACKDROP_DRAG_EXEMPT_PX;
}

/**
 * Mounts a modal dialog on `document.body` via a React portal (R1): the dialog escapes every
 * ancestor stacking context, `overflow` container and transformed wrapper, so `position: fixed`
 * anchoring — the root cause of mobile dialogs drifting out from under the finger — no longer
 * depends on where in the tree the dialog was rendered.
 *
 * The backdrop closes on pointer events with a drag exemption (`isBackdropDismissTap`), never on
 * `mousedown`: mobile browsers synthesize `mousedown` before `click`, and a one-pixel offset
 * between the finger and the hit target used to unmount the dialog before the click arrived —
 * the "tapped and nothing happened" failure.
 *
 * When no DOM document exists (static markup rendering, server render) the backdrop renders
 * inline instead of portaling, so component tests that assert on markup keep working.
 */
export function ModalPortal({
  children,
  locked = false,
  onDismiss,
}: {
  children: ReactNode;
  /** While `locked` (a submission is in flight) the backdrop and its drag gesture never dismiss. */
  locked?: boolean;
  onDismiss: () => void;
}) {
  const dragStart = useRef<BackdropPoint | null>(null);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // Only a press that starts on the backdrop itself may dismiss it; presses inside the
    // dialog bubble here too, and must never count.
    if (event.target === event.currentTarget) {
      dragStart.current = { x: event.clientX, y: event.clientY };
    }
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = dragStart.current;
    dragStart.current = null;
    if (locked || event.target !== event.currentTarget) return;
    if (isBackdropDismissTap(start, { x: event.clientX, y: event.clientY })) onDismiss();
  };

  const backdrop = (
    <div
      className="modal-backdrop confirm-order-backdrop"
      role="presentation"
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
    >
      {children}
    </div>
  );
  if (typeof document === 'undefined') return backdrop;
  return createPortal(backdrop, document.body);
}
