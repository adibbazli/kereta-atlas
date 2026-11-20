import { Timer as TimerIcon, X } from "lucide-react";

import { useCar, useNow } from "../car";
import { countdown } from "../format";

const NAMES = { engine: "Engine", climate: "Climate" } as const;

/** Countdowns for the engine run time and climate auto-off. Local ticking only; no requests. */
export function ActiveTimers({ only }: { only?: "engine" | "climate" }) {
  const { status, cancelTimer } = useCar();
  const now = useNow(1000);
  const timers = (status?.timers ?? []).filter((t) => !only || t.kind === only);
  if (!timers.length) return null;
  return (
    <div className="timers">
      {timers.map((t) => {
        const done = t.endsAt <= now;
        return (
          <div key={t.kind} className={`timer ${done ? "done" : ""}`}>
            <TimerIcon size={18} />
            <div className="timer-text">
              <strong>
                {t.kind === "engine"
                  ? done
                    ? "Engine run time ended"
                    : `Engine stops in ${countdown(t.endsAt, now)}`
                  : done
                    ? t.outcome ?? "Auto-off due · refresh to see the result"
                    : `Climate turns off in ${countdown(t.endsAt, now)}`}
              </strong>
              <span>
                {t.kind === "engine" ? "Stopped by the car itself" : "Sent by this server · skipped if the car is moving"}
              </span>
            </div>
            {!done && t.autoOff && (
              <button className="icon-btn" onClick={() => cancelTimer(t.kind)} aria-label={`Cancel ${NAMES[t.kind]} auto-off`}>
                <X size={16} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
