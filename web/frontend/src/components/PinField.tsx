import { KeyRound } from "lucide-react";

import { useCar } from "../car";

/**
 * The PIN is sent with each PIN-protected command. By default it lives only in this tab's memory;
 * "Remember on this device" keeps it in this browser's storage for this car.
 */
export function PinField() {
  const { pin, setPin, rememberPin, setRememberPin } = useCar();
  return (
    <div className="pin">
      <KeyRound size={16} />
      <label htmlFor="vehicle-pin">Vehicle PIN</label>
      <input
        id="vehicle-pin"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={8}
        value={pin}
        placeholder="••••"
        onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
      />
      <label className="check">
        <input type="checkbox" checked={rememberPin} onChange={(e) => setRememberPin(e.target.checked)} />
        Remember on this device
      </label>
      <small>
        {rememberPin
          ? "Saved in this browser. Anyone who can open the app here can send PIN commands. Forget it from the account menu."
          : "Kept in this tab only."}
      </small>
    </div>
  );
}
