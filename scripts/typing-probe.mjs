// Injected only by the profiling runner. Host/browser timestamps share the local
// system clock; frames are paint opportunities, not pixel presentation or INP.
export function installTypingProbe() {
  const absolute = () => performance.timeOrigin + performance.now();
  const tasks = [];
  const events = [];
  const observers = [];
  for (const type of ['longtask', 'event']) {
    if (!PerformanceObserver.supportedEntryTypes.includes(type)) continue;
    const observer = new PerformanceObserver((list) => {
      (type === 'longtask' ? tasks : events).push(...list.getEntries());
    });
    observer.observe(
      type === 'event' ? { type, durationThreshold: 16 } : { type },
    );
    observers.push([type, observer]);
  }
  let run;
  let result;
  document.addEventListener(
    'input',
    (event) => {
      if (!run || event.target.getAttribute('role') !== 'combobox') return;
      run.inputs.push({
        at: absolute(),
        value: event.target.value,
        trusted: event.isTrusted,
      });
    },
    true,
  );
  function frame() {
    if (run) {
      const at = absolute();
      if (run.previousFrame !== undefined && at >= run.startAt)
        run.frameGaps.push(at - run.previousFrame);
      run.previousFrame = at;
      const input = document.querySelector('[role="combobox"]');
      const results = document.querySelector('.search-results');
      const index = run.inputs.length - 1;
      if (
        index >= 0 &&
        input.value === run.inputs[index].value &&
        run.frames.at(-1)?.inputIndex !== index
      ) {
        run.frames.push({ at, inputIndex: index, value: input.value });
      }
      const settled =
        run.inputs.length === run.count &&
        input.value === run.query &&
        results?.dataset.searchQuery === run.query &&
        document.querySelector('.popup').getAttribute('aria-busy') === 'false';
      run.settledFrames = settled ? run.settledFrames + 1 : 0;
      if (run.settledFrames >= 2) {
        for (const [type, observer] of observers)
          (type === 'longtask' ? tasks : events).push(
            ...observer.takeRecords(),
          );
        result = {
          inputs: run.inputs,
          frames: run.frames,
          frameGapsMs: run.frameGaps,
          settledAt: at,
          longTasks: tasks
            .filter(
              (e) =>
                performance.timeOrigin + e.startTime + e.duration >=
                run.startAt,
            )
            .map((e) => e.toJSON()),
          events: events
            .filter((e) => performance.timeOrigin + e.startTime >= run.startAt)
            .map((e) => e.toJSON()),
        };
        run = undefined;
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  window.__typingPerf = {
    arm(settings) {
      result = undefined;
      run = {
        ...settings,
        inputs: [],
        frames: [],
        frameGaps: [],
        settledFrames: 0,
      };
    },
    get result() {
      return result;
    },
  };
}
