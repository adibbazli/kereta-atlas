import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { Level } from "../format";
import { Dot } from "./ui";

export const HOLD_MS = 3000;

type Props = {
  icon?: ReactNode;
  label: string;
  /** Small line under the label, e.g. "Unlocked" */
  hint?: string;
  dot?: Level;
  danger?: boolean;
  disabled?: boolean;
  /** This command is in flight. */
  busy?: boolean;
  disabledReason?: string;
  onConfirm: () => void;
};

/**
 * Sends only after being held for HOLD_MS (3 s) (pointer or Space/Enter). Releasing, leaving the button or a
 * cancelled touch aborts with nothing sent.
 */
export function HoldButton({ icon, label, hint, dot, danger, disabled, busy, disabledReason, onConfirm }: Props) {
  const [progress, setProgress] = useState(0);
  const start = useRef<number | null>(null);
  const frame = useRef<number>(0);
  const fired = useRef(false);

  const stop = useCallback(() => {
    cancelAnimationFrame(frame.current);
    start.current = null;
    if (!fired.current) setProgress(0);
  }, []);

  const tick = useCallback(() => {
    if (start.current == null) return;
    const p = Math.min(1, (performance.now() - start.current) / HOLD_MS);
    setProgress(p);
    if (p >= 1) {
      fired.current = true;
      start.current = null;
      navigator.vibrate?.(40);
      onConfirm();
      return;
    }
    frame.current = requestAnimationFrame(tick);
  }, [onConfirm]);

  const begin = useCallback(() => {
    if (disabled || busy || start.current != null) return;
    fired.current = false;
    start.current = performance.now();
    frame.current = requestAnimationFrame(tick);
  }, [disabled, busy, tick]);

  // Reset the fill once the command finishes.
  useEffect(() => {
    if (!busy) {
      fired.current = false;
      setProgress(0);
    }
  }, [busy]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const holding = progress > 0 && progress < 1 && !busy;
  const secondsLeft = Math.ceil((1 - progress) * (HOLD_MS / 1000));

  return (
    <button
      type="button"
      className={`hold ${danger ? "danger" : ""} ${holding ? "holding" : ""} ${busy ? "busy" : ""}`}
      disabled={disabled}
      aria-disabled={disabled || busy}
      aria-label={`${label}. Press and hold for ${HOLD_MS / 1000} seconds.`}
      title={disabled ? disabledReason : `Press and hold for ${HOLD_MS / 1000} seconds`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // capture is a nicety; the hold still works without it
        }
        begin();
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onPointerLeave={stop}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if ((e.key === " " || e.key === "Enter") && !e.repeat) {
          e.preventDefault();
          begin();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === " " || e.key === "Enter") stop();
      }}
      onBlur={stop}
    >
      <span className="hold-fill" style={{ transform: `scaleX(${busy ? 1 : progress})` }} />
      <span className="hold-body">
        <span className="hold-icon">{icon}</span>
        <span className="hold-text">
          <span className="hold-label">{label}</span>
          <span className="hold-hint">
            {busy ? "Sending…" : holding ? `Keep holding · ${secondsLeft}s` : disabled && disabledReason ? disabledReason : hint ?? `Hold ${HOLD_MS / 1000} s`}
          </span>
        </span>
        {dot && dot !== "none" && <Dot level={dot} />}
      </span>
    </button>
  );
}
