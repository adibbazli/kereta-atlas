import { ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";

import { api } from "../api";
import { Spinner } from "../components/ui";

/** Shown on the public (tunnel) URL until this browser has entered the access passcode. */
export function Gate({ onPassed }: { onPassed: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api("/api/gate", { method: "POST", body: { passcode: code } });
      setCode("");
      onPassed();
    } catch (ex) {
      setError((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <form className="signin-card" onSubmit={submit}>
        <div className="brand-lg">Mottokar</div>
        <p className="muted row">
          <ShieldCheck size={16} /> This server is private. Enter its access passcode.
        </p>
        <label className="field">
          <span>Access passcode</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="XXXX-XXXX-XXXX-XXXX"
            required
            autoFocus
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn primary" disabled={busy || !code}>
          {busy ? <Spinner /> : "Continue"}
        </button>
        <p className="muted small">Too many wrong attempts lock this address out for 15 minutes.</p>
      </form>
    </div>
  );
}
