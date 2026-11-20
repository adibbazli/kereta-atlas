export type OpenState = "open" | "closed" | "unknown";
export type Position = "frontLeft" | "frontRight" | "rearLeft" | "rearRight";

export type CommandParam =
  | { key: string; label: string; type: "number"; min: number; max: number; step: number; default: number; unit?: string }
  | { key: string; label: string; type: "choice"; default: number; options: { label: string; value: number }[] };

export type CommandDef = { id: string; label: string; isPinRequired?: boolean; isDestructive?: boolean; params?: CommandParam[] };

export type Me = { signedIn: true; provider: string; accountLabel?: string; commands: CommandDef[] } | { signedIn: false };

export type ProviderInfo = { id: string; name: string; fields: { key: string; label: string; type: string; help?: string }[] };

export type Vehicle = {
  id: string;
  vin: string;
  name: string;
  model?: string;
  imageUrl?: string;
  isDefault?: boolean;
  isPinRequired?: boolean;
  fuelTankLitres?: number;
  /** null = unknown, show everything */
  commands?: string[] | null;
};

export type VehicleStatus = {
  updatedAt?: number;
  lock?: "locked" | "unlocked" | "unknown";
  isParkingBrakeOn?: boolean | null;
  fuelPercent?: number | null;
  fuelLitres?: number | null;
  batteryPercent?: number | null;
  isCharging?: boolean | null;
  rangeKm?: number | null;
  odometerKm?: number | null;
  avgFuelLPer100km?: number | null;
  avgSpeedKmh?: number | null;
  isEngineOn?: boolean | null;
  climate?: { isOn: boolean; cabinTempC?: number | null; outsideTempC?: number | null; targetTempC?: number | null };
  doors?: Partial<Record<Position | "trunk" | "hood", OpenState>>;
  isTrunkLocked?: boolean | null;
  windows?: Partial<Record<Position | "sunroof", OpenState>>;
  windowPositions?: Partial<Record<Position, number | null>>;
  tyres?: Partial<Record<Position, number | null>>;
  tyreWarnings?: Partial<Record<Position, boolean | null>>;
  warnings?: string[];
  serviceDueKm?: number | null;
  serviceDueDays?: number | null;
  batteryVoltage?: number | null;
  speedKmh?: number | null;
  engineRpm?: number | null;
  coolantTempC?: number | null;
  isVentilating?: boolean | null;
};

export type Timer = { kind: "engine" | "climate"; endsAt: number; minutes: number; autoOff: boolean; outcome?: string };

export type Location = { latitude: number; longitude: number; updatedAt?: number };

export type LiveState = {
  active: boolean;
  phase: "off" | "measuring" | "live" | "paused" | "stopped";
  reason?: string | null;
  mode: "cached" | "wakes" | "unknown";
  fetchedAt?: number | null;
  nextAt?: number;
  endsAt?: number;
  intervalS?: number | null;
};

export type StatusResponse = {
  status: VehicleStatus;
  location: Location | null;
  raw?: [string, string | number | boolean][];
  timers: Timer[];
  live?: LiveState;
};

export type CommandResult = { isOk: boolean; message?: string; isConfirmed?: boolean; requestId?: string; timer?: Timer };

export type Trip = {
  id: string;
  startedAt: number;
  endedAt?: number | null;
  distanceKm?: number | null;
  durationMin?: number | null;
  avgSpeedKmh?: number | null;
  /** Litres of fuel used on the trip, as reported by the car. */
  fuelUsedL?: number | null;
  /** Average consumption, derived from litres used ÷ distance. */
  fuelLPer100km?: number | null;
};

/** Trip filter. Presets are relative to today, so Refresh keeps them current. Dates are local YYYY-MM-DD. */
export type TripRange = { preset: "7" | "30" | "90" | "custom"; from: string; to: string };

export type Notice = { id: string; title: string; body?: string | null; createdAt: number; isRead?: boolean; kind?: string | null };

export type DataUsage = { usedBytes?: number | null; remainingBytes?: number | null } | null;
