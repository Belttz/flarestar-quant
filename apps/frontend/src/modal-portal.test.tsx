import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BACKDROP_DRAG_EXEMPT_PX, ModalPortal, isBackdropDismissTap } from './modal-portal.js';

describe('isBackdropDismissTap', () => {
  it('dismisses only a near-stationary press', () => {
    expect(isBackdropDismissTap({ x: 100, y: 100 }, { x: 100, y: 100 })).toBe(true);
    expect(isBackdropDismissTap({ x: 100, y: 100 }, { x: 103, y: 104 })).toBe(true);
    // Exactly at the budget boundary still counts (strictly-less-than comparison).
    expect(isBackdropDismissTap({ x: 0, y: 0 }, { x: BACKDROP_DRAG_EXEMPT_PX, y: 0 })).toBe(false);
    // A scroll/drift gesture past the budget never dismisses.
    expect(isBackdropDismissTap({ x: 100, y: 100 }, { x: 100, y: 160 })).toBe(false);
    expect(isBackdropDismissTap({ x: 100, y: 100 }, { x: 160, y: 100 })).toBe(false);
  });

  it('never dismisses when an endpoint is missing', () => {
    expect(isBackdropDismissTap(null, { x: 0, y: 0 })).toBe(false);
    expect(isBackdropDismissTap({ x: 0, y: 0 }, null)).toBe(false);
    expect(isBackdropDismissTap(null, null)).toBe(false);
  });
});

/**
 * The static-markup path is also the no-DOM path: vitest runs in a node environment, so the
 * component must render its backdrop inline here — and the browser path (not testable in this
 * environment) portals the same tree into `document.body`.
 */
describe('ModalPortal', () => {
  it('renders the backdrop and its children when no DOM document exists', () => {
    const html = renderToStaticMarkup(
      <ModalPortal onDismiss={vi.fn()}>
        <section role="dialog">content</section>
      </ModalPortal>,
    );
    expect(html).toContain('class="modal-backdrop confirm-order-backdrop"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('content');
  });

  it('keeps the backdrop presentation-only (dismissal is a pointer gesture, not markup)', () => {
    const html = renderToStaticMarkup(
      <ModalPortal onDismiss={vi.fn()}>x</ModalPortal>,
    );
    expect(html).toContain('role="presentation"');
    // No residual mousedown-based dismissal markup: the gesture lives in the pointer handlers.
    expect(html).not.toContain('mousedown');
  });
});
