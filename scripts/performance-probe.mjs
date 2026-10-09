// Serialized into the isolated popup by Playwright. No instrumentation runs in
// the shipped extension. Two rAFs provide a paint opportunity, not an INP value.
export function installPerformanceProbe() {
  const events = [];
  const longTasks = [];
  const observers = [];
  const supported = PerformanceObserver.supportedEntryTypes;
  for (const type of ['event', 'longtask']) {
    if (!supported.includes(type)) continue;
    const observer = new PerformanceObserver((list) => {
      (type === 'event' ? events : longTasks).push(
        ...list.getEntries().map((entry) => entry.toJSON()),
      );
    });
    observer.observe(
      type === 'event'
        ? { type, buffered: true, durationThreshold: 16 }
        : { type, buffered: true },
    );
    observers.push([type, observer]);
  }
  let pending;
  let result;
  let previousFrame;
  function frame(now) {
    if (pending?.started !== undefined) {
      if (previousFrame !== undefined)
        pending.frameGaps.push(now - previousFrame);
    }
    previousFrame = now;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function matches() {
    const container = document.querySelector('.search-results');
    const input = document.querySelector('[role="combobox"]');
    if (
      !container ||
      document.querySelector('.popup')?.getAttribute('aria-busy') !== 'false'
    )
      return false;
    if (document.querySelector('input[type="checkbox"]')?.disabled)
      return false;
    if (pending.kind === 'ready') return true;
    if (pending.kind === 'selection')
      return (
        input?.getAttribute('aria-activedescendant') !==
        pending.previousSelection
      );
    return (
      container.dataset.searchQuery === pending.query &&
      container.dataset.showClosed === String(pending.showClosed)
    );
  }
  function check() {
    if (
      !pending ||
      pending.started === undefined ||
      pending.committed !== undefined ||
      !matches()
    )
      return;
    const current = pending;
    current.committed = performance.now();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (pending !== current) return;
        if (!matches()) {
          current.committed = undefined;
          check();
          return;
        }
        const end = performance.now();
        for (const [type, observer] of observers) {
          (type === 'event' ? events : longTasks).push(
            ...observer.takeRecords().map((entry) => entry.toJSON()),
          );
        }
        result = {
          startMs: current.started,
          eventTimeMs: current.eventTime,
          endMs: end,
          commitMs: current.committed - current.started,
          responseMs: end - current.started,
          frameGapsMs: current.frameGaps,
          longTasks: longTasks.filter(
            (entry) =>
              entry.startTime < end &&
              entry.startTime + entry.duration > current.started,
          ),
          events: events.filter(
            (entry) =>
              entry.processingEnd >= current.started - 1 &&
              entry.processingStart < end,
          ),
        };
        pending = undefined;
      }),
    );
  }
  // Watch only commit/readiness markers, not thousands of row mutations.
  // A document-wide observer would distort the very DOM cost being measured.
  let bound = false;
  const observer = new MutationObserver(() => {
    if (!bound) {
      const targets = [
        [
          '.search-results',
          [
            'data-search-query',
            'data-search-mode',
            'data-show-closed',
            'data-result-count',
          ],
        ],
        ['.popup', ['aria-busy']],
        ['input[type="checkbox"]', ['disabled']],
        ['[role="combobox"]', ['aria-activedescendant']],
      ].map(([selector, attributeFilter]) => ({
        element: document.querySelector(selector),
        attributeFilter,
      }));
      if (targets.every(({ element }) => element)) {
        observer.disconnect();
        for (const { element, attributeFilter } of targets) {
          observer.observe(element, { attributes: true, attributeFilter });
        }
        bound = true;
      }
    }
    check();
  });
  observer.observe(document, { childList: true, subtree: true });
  for (const type of ['input', 'keydown', 'click']) {
    document.addEventListener(
      type,
      (event) => {
        if (
          !pending ||
          pending.started !== undefined ||
          pending.kind === 'ready'
        )
          return;
        const relevant =
          pending.kind === 'selection'
            ? type === 'keydown' && event.key === 'ArrowDown'
            : event.target.closest(
                '[role="combobox"], input[type="checkbox"], button[aria-label="Clear search"]',
              );
        if (!relevant) return;
        pending.started = performance.now();
        pending.eventTime = event.timeStamp;
        performance.mark(`perf:${pending.name}:start`);
        check();
      },
      true,
    );
  }
  window.__tabSwitcherPerf = {
    arm(action) {
      if (pending)
        throw new Error('Previous performance action did not complete');
      result = undefined;
      pending = {
        ...action,
        frameGaps: [],
        previousSelection: document
          .querySelector('[role="combobox"]')
          ?.getAttribute('aria-activedescendant'),
      };
      if (action.kind === 'ready') pending.started = 0;
      check();
    },
    get result() {
      return result;
    },
    supported,
  };
  window.__tabSwitcherPerf.arm({ kind: 'ready', name: 'popup-ready' });
}
