import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api } from "../api";
import { useCar } from "../car";
import { ago } from "../format";
import { Empty, Spinner } from "./ui";

export function Inbox({ onClose }: { onClose: () => void }) {
  const { notices, loadNotices, toast } = useCar();
  const [read, setRead] = useState<Set<string>>(new Set());
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    if (!notices.data && !notices.loading) loadNotices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <dialog ref={ref} className="sheet" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current?.close()}>
      <header className="card-head">
        <h2>Inbox</h2>
        <button className="icon-btn" onClick={() => ref.current?.close()} aria-label="Close">
          <X size={18} />
        </button>
      </header>
      {notices.loading && !notices.data ? (
        <Spinner />
      ) : notices.error ? (
        <p className="error">{notices.error}</p>
      ) : !notices.data?.length ? (
        <Empty>No messages.</Empty>
      ) : (
        <ul className="notices">
          {notices.data.map((m) => {
            const unread = !m.isRead && !read.has(m.id);
            return (
              <li key={m.id} className={unread ? "unread" : ""}>
                <div className="row between">
                  <strong>{m.title}</strong>
                  <span className="muted small">{ago(m.createdAt)}</span>
                </div>
                {m.body && <p>{m.body}</p>}
                {unread && (
                  <button
                    className="link small"
                    onClick={() =>
                      api(`/api/notices/${encodeURIComponent(m.id)}/read`, { method: "POST" })
                        .then(() => setRead((s) => new Set(s).add(m.id)))
                        .catch((e) => toast((e as Error).message, "error"))
                    }
                  >
                    Mark as read
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </dialog>
  );
}
