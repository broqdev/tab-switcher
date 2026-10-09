import { useCallback, useLayoutEffect, useRef, useState } from 'react';

// Keep in sync with .tab-row in popup/style.css.
export const TAB_ROW_HEIGHT = 48;
const OVERSCAN = 4;

export function useVirtualList(
  count: number,
  activeIndex: number,
  resetKey: string,
  activeKey?: string,
) {
  const ref = useRef<HTMLUListElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 504 });
  const previousReset = useRef(resetKey);
  const readViewport = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    setViewport((previous) =>
      previous.top === element.scrollTop &&
      previous.height === element.clientHeight
        ? previous
        : { top: element.scrollTop, height: element.clientHeight },
    );
  }, []);

  useLayoutEffect(() => {
    const element = ref.current!;
    const observer = new ResizeObserver(readViewport);
    observer.observe(element);
    element.addEventListener('scroll', readViewport, { passive: true });
    readViewport();
    return () => {
      observer.disconnect();
      element.removeEventListener('scroll', readViewport);
    };
  }, [readViewport]);

  useLayoutEffect(() => {
    const element = ref.current!;
    if (previousReset.current !== resetKey) {
      element.scrollTop = 0;
      previousReset.current = resetKey;
    }
    if (count && element.clientHeight) {
      const top = activeIndex * TAB_ROW_HEIGHT;
      const bottom = top + TAB_ROW_HEIGHT;
      if (top < element.scrollTop) element.scrollTop = top;
      else if (bottom > element.scrollTop + element.clientHeight)
        element.scrollTop = bottom - element.clientHeight;
    }
    readViewport();
  }, [count, activeIndex, activeKey, resetKey, readViewport]);

  const start = Math.min(
    Math.max(0, count - 1),
    Math.max(0, Math.floor(viewport.top / TAB_ROW_HEIGHT) - OVERSCAN),
  );
  const end = Math.min(
    count,
    Math.ceil((viewport.top + viewport.height) / TAB_ROW_HEIGHT) + OVERSCAN,
  );
  const indices =
    count <= 50
      ? Array.from({ length: count }, (_, index) => index)
      : Array.from(
          { length: Math.max(0, end - start) },
          (_, index) => start + index,
        );
  // Keep the active descendant in the DOM when mouse scrolling away from it.
  if (count && !indices.includes(activeIndex)) indices.push(activeIndex);
  indices.sort((a, b) => a - b);
  return { ref, indices, height: count * TAB_ROW_HEIGHT };
}
