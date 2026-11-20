import type { ReactNode } from "react";

import type { Level } from "../format";

export const Dot = ({ level, title }: { level: Level; title?: string }) => (
  <span className={`dot dot-${level}`} role="img" aria-label={title ?? level} title={title} />
);

export function Bar({ pct, level }: { pct: number | null | undefined; level: Level }) {
  const v = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  return (
    <div className="bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v)}>
      <div className={`bar-fill bar-${level}`} style={{ width: `${v}%` }} />
    </div>
  );
}

export function Card({ title, action, children, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, level, icon }: { label: string; value: ReactNode; sub?: ReactNode; level?: Level; icon?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">
        {icon}
        {label}
        {level && level !== "none" && <Dot level={level} />}
      </div>
      <div className="stat-value">{value}</div>
      {sub != null && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? "on" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const Spinner = () => <span className="spinner" aria-hidden />;

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
