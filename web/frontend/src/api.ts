export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public reauth = false,
  ) {
    super(message);
  }
}

let onSignedOut: () => void = () => {};
export const setSignedOutHandler = (fn: () => void) => (onSignedOut = fn);
let onGate: () => void = () => {};
/** Called when the server wants the access passcode (public URL, not yet unlocked). */
export const setGateHandler = (fn: () => void) => (onGate = fn);

/** Same-origin JSON calls. State-changing calls always send JSON (the server requires it, CSRF guard). */
export async function api<T>(path: string, opts: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
    body: method === "POST" ? JSON.stringify(opts.body ?? {}) : undefined,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // empty body
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; reauth?: boolean; gate?: boolean };
    if (res.status === 401 && d.gate) onGate();
    else if (res.status === 401 && d.reauth && path !== "/api/signin") onSignedOut();
    throw new ApiError(d.error || `Request failed (${res.status})`, res.status, !!d.reauth);
  }
  return data as T;
}

export const vinPath = (vin: string, rest = "") => `/api/vehicles/${encodeURIComponent(vin)}${rest}`;
