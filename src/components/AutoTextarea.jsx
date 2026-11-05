import { useLayoutEffect, useRef } from 'react';

/** A textarea that grows to fit its content so long tweets and posts are never clipped. */
export default function AutoTextarea({ value, minRows = 2, ...props }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  // width changes (rotation, resize) also change wrapping
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    let last = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== last) {
        last = el.clientWidth;
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight + 2}px`;
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return <textarea ref={ref} rows={minRows} value={value} {...props} />;
}
