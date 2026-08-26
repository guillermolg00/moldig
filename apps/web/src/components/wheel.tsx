import { useEffect, useRef } from "react";

export type WheelItem = {
  id: string;
  label: string;
  /** Kept dim even while selected: it stands for the absence of a token, not for one. */
  quiet?: boolean;
};

const STEP_DEGREES = 22;
const ITEM_HEIGHT = 44;
const VISIBLE_EACH_SIDE = 2;
const RADIUS = Math.round(ITEM_HEIGHT / 2 / Math.tan((STEP_DEGREES * Math.PI) / 360));
const WHEEL_THRESHOLD = 50;
const DRAG_THRESHOLD = ITEM_HEIGHT * 0.6;

type WheelProps = {
  items: WheelItem[];
  index: number;
  onIndexChange: (index: number) => void;
  align: "start" | "end";
  label: string;
};

export function Wheel({ items, index, onIndexChange, align, label }: WheelProps) {
  const widest = items.reduce((a, b) => (b.label.length > a.label.length ? b : a), items[0]!);
  const container = useRef<HTMLDivElement>(null);
  const state = useRef({ index, wheelDelta: 0, dragOrigin: 0, dragIndex: 0 });
  state.current.index = index;

  const step = (by: number) => {
    const next = Math.min(items.length - 1, Math.max(0, state.current.index + by));
    if (next !== state.current.index) onIndexChange(next);
  };

  // Wheel events are bound by hand: React's synthetic listener is passive, and this one has to
  // preventDefault to keep the page from scrolling while the picker turns.
  useEffect(() => {
    const element = container.current;
    if (!element) return undefined;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      state.current.wheelDelta += event.deltaY;
      const steps = Math.trunc(state.current.wheelDelta / WHEEL_THRESHOLD);
      if (steps !== 0) {
        state.current.wheelDelta = 0;
        // One row per gesture, whatever the trackpad reports: a picker that skips three rows on a
        // flick is a scrollbar, not a picker.
        step(Math.sign(steps));
      }
    };

    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  });

  return (
    <div
      ref={container}
      role="listbox"
      aria-label={label}
      aria-activedescendant={`${label}-${items[index]?.id ?? ""}`}
      tabIndex={0}
      onKeyDown={(event) => {
        const by = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
        if (by === 0) return;
        event.preventDefault();
        step(by);
      }}
      onPointerDown={(event) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        state.current.dragOrigin = event.clientY;
        state.current.dragIndex = state.current.index;
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const travelled = state.current.dragOrigin - event.clientY;
        const target = state.current.dragIndex + Math.round(travelled / DRAG_THRESHOLD);
        const next = Math.min(items.length - 1, Math.max(0, target));
        if (next !== state.current.index) onIndexChange(next);
      }}
      className="relative touch-none select-none px-4 outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-4 focus-visible:ring-offset-canvas dark:focus-visible:ring-accent-dark/40 dark:focus-visible:ring-offset-canvas-dark"
      style={{
        height: ITEM_HEIGHT * (VISIBLE_EACH_SIDE * 2 + 1),
        perspective: "600px",
        maskImage: "linear-gradient(to bottom, transparent, #000 24%, #000 76%, transparent)",
      }}
    >
      {/* Sizes the wheel to its longest row, so nothing shifts sideways as the selection turns. */}
      <span aria-hidden="true" className="invisible block h-0 whitespace-nowrap font-mono">
        {widest.label}
      </span>
      {/* Pushed back by one radius so the selected row sits at z = 0: it keeps its real size, and
          every other row falls away from the reader instead of the selected one looming forward. */}
      <div
        className="absolute inset-0 grid place-items-center [transform-style:preserve-3d]"
        style={{ transform: `translateZ(-${RADIUS}px)` }}
      >
        {items.map((item, itemIndex) => {
          const distance = itemIndex - index;
          const hidden = Math.abs(distance) > VISIBLE_EACH_SIDE;
          const selected = distance === 0;

          return (
            <button
              key={item.id}
              id={`${label}-${item.id}`}
              type="button"
              role="option"
              aria-selected={selected}
              tabIndex={-1}
              onClick={() => onIndexChange(itemIndex)}
              className={[
                "absolute flex h-11 w-full items-center whitespace-nowrap font-mono transition-[transform,opacity,color] duration-300 ease-[cubic-bezier(0.22,0.61,0.36,1)] motion-reduce:transition-none",
                align === "end" ? "justify-end pr-1" : "justify-start pl-1",
                item.quiet ? "italic tracking-wide" : "",
                selected && !item.quiet
                  ? "text-ink dark:text-ink-dark"
                  : "text-muted/70 dark:text-muted-dark/70",
              ].join(" ")}
              style={{
                transform: `rotateX(${-distance * STEP_DEGREES}deg) translateZ(${RADIUS}px)`,
                opacity: hidden ? 0 : (1 - Math.abs(distance) * 0.34) * (item.quiet ? 0.55 : 1),
                pointerEvents: hidden ? "none" : undefined,
              }}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
