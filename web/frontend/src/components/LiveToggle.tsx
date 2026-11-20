import { Radio } from "lucide-react";

import { useCar, useNow } from "../car";

/** Header switch for live mode. Off by default; only offered while the 12 V battery is green. */
export function LiveToggle() {
  const { live, liveBlockedReason, startLive, stopLive, status } = useCar();
  const now = useNow(1000);
  if (!status) return null;
  const active = !!live?.active;
  const blocked = !active && !!liveBlockedReason;

  let text = "Live";
  if (active && live) {
    if (live.phase === "measuring") text = "Live · measuring";
    else if (live.phase === "paused") text = "Live · paused";
    else if (live.nextAt) text = `Live · ${Math.max(0, Math.round((live.nextAt - now) / 1000))}s`;
  }
  const minutesLeft = active && live?.endsAt ? Math.max(0, Math.ceil((live.endsAt - now) / 60000)) : null;
  const title = blocked
    ? liveBlockedReason
    : active
      ? `${live?.phase === "measuring" ? "Checking whether reading the status wakes your car. " : ""}${
          live?.mode === "cached" ? "Reads come from Proton’s cloud copy (no load on the car). " : live?.mode === "wakes" ? "Reads wake the car, so updates are slower. " : ""
        }Stops in ${minutesLeft} min, or when the battery leaves green. Tap to turn off.`
      : "Update automatically: every 30 s while driving, every 2 min parked. Stops after 30 min.";

  return (
    <button
      type="button"
      className={`live-toggle ${active ? "on" : ""} ${live?.phase === "paused" ? "paused" : ""}`}
      onClick={() => (active ? stopLive() : startLive())}
      disabled={blocked}
      aria-pressed={active}
      aria-label={active ? `Live mode on. ${title}` : `Turn on live mode. ${title}`}
      title={title}
    >
      <Radio size={15} />
      <span>{text}</span>
    </button>
  );
}
