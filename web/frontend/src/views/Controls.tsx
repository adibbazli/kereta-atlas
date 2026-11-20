import { CarFront, Flashlight, Lock, LockOpen, Megaphone, Package, PanelTop, Power, Snowflake, Wind, Zap } from "lucide-react";
import { useState } from "react";

import { useCar } from "../car";
import { HOLD_MS, HoldButton } from "../components/HoldButton";
import { PinField } from "../components/PinField";
import { ActiveTimers } from "../components/Timers";
import { Card, Segmented } from "../components/ui";
import type { Level } from "../format";

const ENGINE_MINUTES = [3, 5, 8, 10];

export function Controls() {
  const { status, supports, send, busy, pending, needsPin, pin } = useCar();
  const [minutes, setMinutes] = useState(10);
  if (!status) return null;
  const s = status.status;

  const pinMissing = (id: string) => needsPin(id) && !/^\d{4,8}$/.test(pin);
  const common = (id: string) => ({
    busy: busy === id,
    disabled: (!!busy && busy !== id) || pinMissing(id),
    disabledReason: pinMissing(id) ? "Enter your PIN first" : undefined,
  });
  const pendingDot = (key: string, level: Level): Level => (pending.has(key) ? "none" : level);
  const pendingHint = (key: string, hint: string) => (pending.has(key) ? "State unknown · Refresh" : hint);

  const locked = s.lock === "locked";
  const windowsOpen = Object.entries(s.windows ?? {}).some(([k, v]) => k !== "sunroof" && v === "open");
  const trunkUnlocked = s.isTrunkLocked === false || s.doors?.trunk === "open";
  const engineOn = !!s.isEngineOn;
  const anyPin = ["lock", "unlock", "windows_open", "windows_close", "ventilate_on", "ventilate_off", "trunk_open", "engine_start", "engine_stop", "horn_lights"].some(
    (id) => supports(id) && needsPin(id),
  );

  const lockId = locked ? "unlock" : "lock";
  const winId = windowsOpen ? "windows_close" : "windows_open";
  const ventilating = !!s.isVentilating;
  const ventId = ventilating ? "ventilate_off" : "ventilate_on";
  const engineId = engineOn ? "engine_stop" : "engine_start";

  return (
    <div className="stack">
      {anyPin && <PinField />}
      <p className="muted small">Hold a button for {HOLD_MS / 1000} seconds to send. Let go any time to cancel.</p>

      <div className="grid controls">
        {supports("lock") && supports("unlock") ? (
          <HoldButton
            icon={locked ? <LockOpen /> : <Lock />}
            label={locked ? "Unlock" : "Lock"}
            hint={pendingHint("lock", locked ? "Car is locked" : "Car is unlocked")}
            dot={pendingDot("lock", locked ? "good" : "warn")}
            {...common(lockId)}
            onConfirm={() => send(lockId)}
          />
        ) : (
          supports("lock") && (
            <HoldButton icon={<Lock />} label="Lock" dot={locked ? "good" : "warn"} {...common("lock")} onConfirm={() => send("lock")} />
          )
        )}

        {supports("windows_open") && supports("windows_close") && (
          <HoldButton
            icon={<PanelTop />}
            label={windowsOpen ? "Close windows" : "Open windows"}
            hint={pendingHint("windows", windowsOpen ? "Windows open" : "Windows closed")}
            dot={pendingDot("windows", windowsOpen ? "warn" : "good")}
            {...common(winId)}
            onConfirm={() => send(winId)}
          />
        )}
        {supports("windows_close") && !supports("windows_open") && (
          <HoldButton icon={<PanelTop />} label="Close windows" dot={windowsOpen ? "warn" : "good"} {...common("windows_close")} onConfirm={() => send("windows_close")} />
        )}

        {supports("ventilate_on") && supports("ventilate_off") && (
          <HoldButton
            icon={<Wind />}
            label={ventilating ? "Stop ventilating" : "Ventilate"}
            hint={pendingHint("ventilate", ventilating ? "Windows open a crack · stopping closes them" : "Opens every window a crack")}
            dot={pendingDot("ventilate", ventilating ? "warn" : "none")}
            {...common(ventId)}
            onConfirm={() => send(ventId)}
          />
        )}

        {supports("trunk_open") && supports("trunk_lock") ? (
          <HoldButton
            icon={<Package />}
            label={trunkUnlocked ? "Lock trunk" : "Unlock trunk"}
            hint={pendingHint("trunk", trunkUnlocked ? "Trunk unlocked" : "Trunk locked")}
            dot={pendingDot("trunk", trunkUnlocked ? "warn" : "good")}
            {...common(trunkUnlocked ? "trunk_lock" : "trunk_open")}
            onConfirm={() => send(trunkUnlocked ? "trunk_lock" : "trunk_open")}
          />
        ) : (
          supports("trunk_open") && (
            <HoldButton
              icon={<Package />}
              label="Unlock trunk"
              hint={pendingHint("trunk", trunkUnlocked ? "Trunk unlocked · Lock the car to secure it" : "Trunk locked")}
              dot={pendingDot("trunk", trunkUnlocked ? "warn" : "good")}
              {...common("trunk_open")}
              onConfirm={() => send("trunk_open")}
            />
          )
        )}

        {supports("horn_lights") && (
          <HoldButton icon={<Megaphone />} label="Honk and flash" hint="Find your car" {...common("horn_lights")} onConfirm={() => send("horn_lights")} />
        )}
        {supports("lights") && <HoldButton icon={<Flashlight />} label="Flash lights" {...common("lights")} onConfirm={() => send("lights")} />}
        {supports("sunroof_close") && (
          <HoldButton
            icon={<CarFront />}
            label="Close sunroof"
            dot={s.windows?.sunroof === "open" ? "warn" : "good"}
            {...common("sunroof_close")}
            onConfirm={() => send("sunroof_close")}
          />
        )}
        {supports("defrost_on") && <HoldButton icon={<Snowflake />} label="Defrost" {...common("defrost_on")} onConfirm={() => send("defrost_on")} />}
        {supports("charge_start") && supports("charge_stop") && (
          <HoldButton
            icon={<Zap />}
            label={s.isCharging ? "Stop charging" : "Start charging"}
            dot={s.isCharging ? "good" : "none"}
            {...common(s.isCharging ? "charge_stop" : "charge_start")}
            onConfirm={() => send(s.isCharging ? "charge_stop" : "charge_start")}
          />
        )}
      </div>

      {supports("engine_start") && supports("engine_stop") && (
        <Card title="Engine">
          <div className="stack-sm">
            <ActiveTimers only="engine" />
            {!engineOn && (
              <div className="field-row">
                <span>Run for</span>
                <Segmented
                  ariaLabel="Engine run time"
                  value={minutes}
                  onChange={setMinutes}
                  options={ENGINE_MINUTES.map((m) => ({ value: m, label: `${m} min` }))}
                />
              </div>
            )}
            <HoldButton
              icon={<Power />}
              label={engineOn ? "Stop engine" : "Start engine"}
              hint={pendingHint("engine", engineOn ? "Engine running" : `Stops by itself after ${minutes} min`)}
              dot={pendingDot("engine", engineOn ? "warn" : "none")}
              danger={engineOn}
              {...common(engineId)}
              onConfirm={() => send(engineId, engineOn ? {} : { minutes })}
            />
          </div>
        </Card>
      )}
    </div>
  );
}
