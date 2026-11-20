import { ArrowLeft, Lock, LockOpen, Megaphone, PanelTop } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useCar, useNow } from "../car";
import { HOLD_MS, HoldButton } from "../components/HoldButton";
import { PinField } from "../components/PinField";
import { Card, Dot } from "../components/ui";
import { ago, type Level } from "../format";

/** Commands a link (or a Siri "Open URL" Shortcut) can open. Each still needs the hold to send. */
export const QUICK_ACTIONS: Record<string, { label: string; icon: ReactNode }> = {
  unlock: { label: "Unlock", icon: <LockOpen /> },
  lock: { label: "Lock", icon: <Lock /> },
  horn_lights: { label: "Honk and flash", icon: <Megaphone /> },
  windows_close: { label: "Close windows", icon: <PanelTop /> },
};

/**
 * Opened by a deep link such as /#/do/unlock. Opening the link never sends anything: the
 * command goes out only after the usual press-and-hold, so a link clicked by mistake (or by
 * someone else) does nothing.
 */
export function QuickAction({ command, onDone }: { command: string; onDone: () => void }) {
  const { status, vehicle, supports, send, busy, needsPin, pin } = useCar();
  const now = useNow(30_000);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const action = QUICK_ACTIONS[command];

  if (!action || !supports(command)) {
    return (
      <Card>
        <p className="muted">“{command}” isn’t available as a quick action for {vehicle.name}.</p>
        <button className="btn" onClick={onDone}>
          Back to overview
        </button>
      </Card>
    );
  }
  if (!status) return null;
  const s = status.status;
  const locked = s.lock === "locked";
  const lockLevel: Level = s.lock === "locked" ? "good" : s.lock === "unlocked" ? "warn" : "none";
  const pinMissing = needsPin(command) && !/^\d{4,8}$/.test(pin);
  const already = (command === "unlock" && s.lock === "unlocked") || (command === "lock" && locked);

  return (
    <div className="stack quick">
      <button className="link" onClick={onDone}>
        <ArrowLeft size={16} /> Overview
      </button>
      <Card>
        <div className="quick-head">
          <div>
            <div className="muted small">{vehicle.name}</div>
            <div className="quick-state">
              {s.lock === "locked" ? "Locked" : s.lock === "unlocked" ? "Unlocked" : "Lock state unknown"} <Dot level={lockLevel} />
            </div>
            <div className="muted small">Status from {ago(s.updatedAt, now)}</div>
          </div>
        </div>
      </Card>

      {needsPin(command) && <PinField />}
      {already && !result && <p className="muted small">The car already reports “{locked ? "locked" : "unlocked"}”. You can still send it.</p>}

      {result ? (
        <Card>
          <p className={result.ok ? "quick-ok" : "error"}>{result.text}</p>
          <div className="row">
            <button className="btn primary" onClick={onDone}>
              Done
            </button>
            <button className="btn" onClick={() => setResult(null)}>
              Send again
            </button>
          </div>
        </Card>
      ) : (
        <>
          <HoldButton
            icon={action.icon}
            label={action.label}
            hint={`Hold ${HOLD_MS / 1000} s to send`}
            dot={command === "unlock" || command === "lock" ? lockLevel : undefined}
            busy={busy === command}
            disabled={(!!busy && busy !== command) || pinMissing}
            disabledReason={pinMissing ? "Enter your PIN first" : undefined}
            onConfirm={async () => {
              const res = await send(command);
              if (res) setResult({ ok: res.isOk, text: res.isOk ? (res.isConfirmed ? `${action.label}: done` : `${action.label}: sent, no confirmation yet`) : res.message || "The car couldn’t do that" });
            }}
          />
          <p className="muted small">Opened from a link. Nothing is sent until you hold the button.</p>
        </>
      )}
    </div>
  );
}
