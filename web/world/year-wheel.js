/** A scroll-snap year picker. Only settled user selections notify onChange. */
export function createYearWheel({ element, input, min = 1800, max = new Date().getFullYear(), onChange = () => {} }) {
  if (!element || !input) throw new TypeError('The year wheel needs an element and a value input.');
  const document = element.ownerDocument || globalThis.document;
  const environment = document?.defaultView || globalThis;
  const later = environment.setTimeout.bind(environment);
  const cancel = environment.clearTimeout.bind(environment);
  let lower, upper, selected, preview, rows = [], timer = null, touching = false, disabled = null, disposed = false;
  const listeners = [];
  const rowHeight = () => rows[0]?.offsetHeight || element.clientHeight / 3 || 36;
  const clamp = (year) => Math.min(upper, Math.max(lower, Math.round(year)));
  const stopTimer = () => { if (timer !== null) cancel(timer); timer = null; };
  const align = (year = selected) => { element.scrollTop = (year - lower) * rowHeight(); };

  function paint(year) {
    if (preview !== undefined) rows[preview - lower]?.classList.remove('is-selected');
    preview = year;
    rows[year - lower]?.classList.add('is-selected');
    element.setAttribute('aria-valuenow', String(year));
    element.setAttribute('aria-valuetext', `${year} 年`);
  }

  function publish(year, emit) {
    const changed = selected !== year;
    selected = year;
    input.value = String(year);
    paint(year);
    if (emit && changed && !disposed) onChange(year);
    return year;
  }

  function commit() {
    stopTimer();
    if (disposed || disabled) return selected;
    touching = false;
    const year = clamp(lower + element.scrollTop / rowHeight());
    align(year);
    return publish(year, true);
  }

  function finish() {
    stopTimer();
    if (disposed || disabled || touching) return;
    return commit();
  }

  function schedule() {
    stopTimer();
    if (!touching && !disabled && !disposed) timer = later(finish, 160);
  }

  function onScroll() {
    if (disposed) return;
    if (disabled) { align(); return; }
    paint(clamp(lower + element.scrollTop / rowHeight()));
    schedule();
  }

  function setValue(value, { emit = false } = {}) {
    if (disposed) return selected;
    const number = Number(value);
    if (!Number.isFinite(number)) return selected;
    stopTimer();
    const year = clamp(number);
    align(year);
    return publish(year, emit);
  }

  function setRange(start, end) {
    if (disposed) return selected;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || end - start > 10000) {
      throw new RangeError('Year bounds must be ordered integers spanning at most 10,000 years.');
    }
    if (lower === start && upper === end) return selected;
    stopTimer();
    const previous = selected ?? Number(input.value);
    lower = start; upper = end;
    input.min = String(lower); input.max = String(upper);
    element.setAttribute('aria-valuemin', String(lower));
    element.setAttribute('aria-valuemax', String(upper));
    const track = document.createElement('div');
    track.className = 'year-wheel-track';
    track.setAttribute('aria-hidden', 'true');
    rows = [];
    for (let year = lower; year <= upper; year++) {
      const row = document.createElement('div');
      row.className = 'year-wheel-item';
      row.dataset.year = String(year);
      row.textContent = String(year);
      rows.push(row);
      track.append(row);
    }
    preview = undefined;
    element.replaceChildren(track);
    return setValue(Number.isFinite(previous) ? previous : lower);
  }

  function setDisabled(value) {
    if (disposed) return;
    const next = !!value;
    if (disabled === next) return;
    disabled = next;
    input.disabled = disabled;
    element.setAttribute('aria-disabled', String(disabled));
    element.tabIndex = disabled ? -1 : 0;
    if (disabled) { stopTimer(); touching = false; align(); paint(selected); }
  }

  function onKeyDown(event) {
    const deltas = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 };
    if (!(event.key in deltas) && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    event.stopPropagation();
    if (disabled) return;
    const year = event.key === 'Home' ? lower : event.key === 'End' ? upper : selected + deltas[event.key];
    setValue(year, { emit: true });
  }

  function onClick(event) {
    if (disabled) return;
    const row = event.target.closest?.('[data-year]');
    if (!row || !element.contains(row)) return;
    setValue(Number(row.dataset.year), { emit: true });
  }

  function listen(type, handler, options, target = element) {
    target.addEventListener(type, handler, options);
    listeners.push([target, type, handler, options]);
  }
  element.setAttribute('role', 'spinbutton');
  setRange(min, max);
  setDisabled(!!input.disabled);
  listen('scroll', onScroll, { passive: true });
  listen('scrollend', finish);
  listen('keydown', onKeyDown);
  listen('click', onClick);
  listen('wheel', (event) => { if (disabled) event.preventDefault(); }, { passive: false });
  listen('touchstart', () => { if (!disabled) { touching = true; stopTimer(); } }, { passive: true });
  const release = () => { touching = false; schedule(); };
  listen('touchend', release, { passive: true });
  listen('touchcancel', release, { passive: true });
  const ResizeObserverClass = environment.ResizeObserver || globalThis.ResizeObserver;
  const observer = ResizeObserverClass ? new ResizeObserverClass(() => {
    if (!disposed) align(preview ?? selected);
  }) : null;
  observer?.observe(element);

  return {
    setRange, setValue, setDisabled, commit,
    dispose() {
      if (disposed) return;
      disposed = true;
      stopTimer();
      observer?.disconnect();
      for (const [target, type, handler, options] of listeners) target.removeEventListener(type, handler, options);
    },
  };
}
