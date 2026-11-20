import { useEffect, useState, type FormEvent } from "react";

import { api } from "../api";
import { Segmented, Spinner } from "../components/ui";
import type { ProviderInfo } from "../types";

export function SignIn({ onSignedIn, notice }: { onSignedIn: () => void; notice?: string }) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [pid, setPid] = useState("proton");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api<ProviderInfo[]>("/api/providers").then(setProviders).catch((e) => setError((e as Error).message));
  }, []);
  const provider = providers.find((p) => p.id === pid) ?? providers[0];

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setError(undefined);
    const values = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    try {
      await api("/api/signin", { method: "POST", body: { provider: provider.id, values } });
      e.currentTarget?.reset();
      onSignedIn();
    } catch (ex) {
      setError((ex as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="signin">
      <div className="signin-card">
        <div className="brand-lg">Mottokar</div>
        <p className="muted">Connect your car</p>
        {notice && (
          <p className="notice" role="alert">
            {notice}
          </p>
        )}
        {!provider ? (
          error ? <p className="error">{error}</p> : <Spinner />
        ) : (
          <>
            <Segmented ariaLabel="Provider" value={provider.id} onChange={setPid} options={providers.map((p) => ({ value: p.id, label: p.name }))} />
            <form className="stack-sm" onSubmit={submit} key={provider.id}>
              {provider.fields.map((f) => (
                <label key={f.key} className="field">
                  <span>{f.label}</span>
                  <input
                    name={f.key}
                    type={f.type}
                    required={f.type !== "text"}
                    autoComplete={f.type === "password" ? "current-password" : f.type === "tel" ? "tel" : "off"}
                  />
                  {f.help && <small className="muted">{f.help}</small>}
                </label>
              ))}
              {error && <p className="error">{error}</p>}
              <button className="btn primary" disabled={submitting}>
                {submitting ? <Spinner /> : "Sign in"}
              </button>
            </form>
            <p className="muted small">
              {provider.id === "proton"
                ? "Your password goes once to Proton to sign in and is never stored. Only the session tokens are kept, on this computer."
                : "A simulated Proton S70. The demo PIN is 1234."}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
