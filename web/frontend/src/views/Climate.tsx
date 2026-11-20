import { Fan, Minus, Plus, Snowflake, Thermometer } from "lucide-react";
import { useState } from "react";

import { useCar } from "../car";
import { HoldButton } from "../components/HoldButton";
import { PinField } from "../components/PinField";
import { ActiveTimers } from "../components/Timers";
import { Card, Segmented, Stat } from "../components/ui";
import { n } from "../format";

const AUTO_OFF = [0, 5, 10, 15, 20, 30];

export function Climate() {
  const { status, supports, send, busy, pending, needsPin, pin, commands } = useCar();
  const param = commands.find((c) => c.id === "climate_on")?.params?.find((p) => p.key === "temp");
  const min = param?.type === "number" ? param.min : 16;
  const max = param?.type === "number" ? param.max : 32;
  const step = param?.type === "number" ? param.step : 0.5;
  const [temp, setTemp] = useState(param?.type === "number" ? param.default : 22);
  const [autoOff, setAutoOff] = useState(10);
  if (!status) return null;
  const s = status.status;
  const c = s.climate ?? { isOn: false };
  const on = !!c.isOn;
  const id = on ? "climate_off" : "climate_on";
  const pinMissing = needsPin(id) && !/^\d{4,8}$/.test(pin);

  const canToggle = supports("climate_on") && supports("climate_off");

  return (
    <div className="stack">
      <div className="grid stats">
        <Stat icon={<Thermometer size={15} />} label="Outside" value={c.outsideTempC != null ? `${n(c.outsideTempC, 1)}°C` : "—"} />
        <Stat
          icon={<Thermometer size={15} />}
          label="Cabin"
          value={c.cabinTempC != null ? `${n(c.cabinTempC, 1)}°C` : "—"}
          sub={c.cabinTempC == null ? "Not reported by your car" : undefined}
        />
        <Stat icon={<Fan size={15} />} label="Climate" value={pending.has("climate") ? "Unknown" : on ? "On" : "Off"} sub={on && c.targetTempC ? `Set to ${n(c.targetTempC, 1)}°C` : undefined} level={on ? "good" : "none"} />
        <Stat label="Engine" value={s.isEngineOn == null ? "—" : s.isEngineOn ? "Running" : "Off"} level={s.isEngineOn ? "warn" : "none"} />
      </div>

      {needsPin(id) && <PinField />}
      <ActiveTimers only="climate" />

      {canToggle ? (
        <Card title="Air conditioning">
          <div className="stack-sm">
            {!on && (
              <>
                <div className="field-row">
                  <span>Temperature</span>
                  <div className="stepper">
                    <button className="icon-btn" aria-label="Cooler" onClick={() => setTemp((t) => Math.max(min, +(t - step).toFixed(1)))} disabled={temp <= min}>
                      <Minus size={16} />
                    </button>
                    <output aria-live="polite">{temp.toFixed(1)}°C</output>
                    <button className="icon-btn" aria-label="Warmer" onClick={() => setTemp((t) => Math.min(max, +(t + step).toFixed(1)))} disabled={temp >= max}>
                      <Plus size={16} />
                    </button>
                  </div>
                </div>
                <div className="field-row">
                  <span>Auto-off</span>
                  <Segmented ariaLabel="Auto-off" value={autoOff} onChange={setAutoOff} options={AUTO_OFF.map((m) => ({ value: m, label: m ? `${m}m` : "Off" }))} />
                </div>
                {autoOff > 0 && <p className="muted small">After {autoOff} min this server sends “climate off” once, unless the car is moving. Keep the server running.</p>}
              </>
            )}
            <HoldButton
              icon={<Fan />}
              label={on ? "Turn climate off" : "Turn climate on"}
              hint={pending.has("climate") ? "State unknown · Refresh" : on ? "Climate is on" : `${temp.toFixed(1)}°C${autoOff ? ` · off after ${autoOff} min` : ""}`}
              dot={pending.has("climate") ? "none" : on ? "good" : "none"}
              busy={busy === id}
              disabled={(!!busy && busy !== id) || pinMissing}
              disabledReason={pinMissing ? "Enter your PIN first" : undefined}
              onConfirm={() => send(id, on ? {} : autoOff ? { temp, autoOffMin: autoOff } : { temp })}
            />
          </div>
        </Card>
      ) : (
        <Card>
          <p className="muted">Your car doesn’t list remote climate control.</p>
        </Card>
      )}

      {supports("defrost_on") && (
        <HoldButton
          icon={<Snowflake />}
          label="Defrost"
          busy={busy === "defrost_on"}
          disabled={!!busy && busy !== "defrost_on"}
          onConfirm={() => send("defrost_on")}
        />
      )}
    </div>
  );
}
