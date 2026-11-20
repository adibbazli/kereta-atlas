import type { CSSProperties } from "react";

import { label } from "../format";
import type { OpenState, VehicleStatus } from "../types";
import { Dot } from "./ui";

type Part = "frontLeft" | "frontRight" | "rearLeft" | "rearRight" | "hood" | "trunk";
const PARTS: Part[] = ["hood", "frontLeft", "frontRight", "rearLeft", "rearRight", "trunk"];

// Car seen from above, front at the top. viewBox units.
const W = 240;
const H = 420;
const BODY = { x: 62, y: 36, w: 116, h: 348, r: 46 };
const DOOR = { thick: 9, front: { y: 138, h: 82 }, rear: { y: 222, h: 76 } };
// Degrees a door swings out on its front hinge (SVG y points down, so the left door turns positive).
const SWING = 38;

const pose = (deg: number, ox: number, oy: number, dx = 0, dy = 0): CSSProperties => ({
  transform: `translate(${dx}px, ${dy}px) rotate(${deg}deg)`,
  transformOrigin: `${ox}px ${oy}px`,
});

/**
 * Top view of the car. An open door swings out on its front hinge, the bonnet tilts forward and
 * the trunk lid tilts back; open parts are drawn red. Windows that are open show an amber strip.
 */
export function CarTopView({ status, onPartClick }: { status: VehicleStatus; onPartClick?: (part: Part) => void }) {
  const doors = status.doors ?? {};
  const windows = status.windows ?? {};
  const isOpen = (p: Part) => doors[p] === "open";
  const winOpen = (p: Exclude<Part, "hood" | "trunk"> | "sunroof") => windows[p] === "open";
  const cls = (p: Part) => `part ${doors[p] === "open" ? "open" : doors[p] === "closed" ? "closed" : "unknown"}${onPartClick ? " clickable" : ""}`;
  const click = (p: Part) => (onPartClick ? { onClick: () => onPartClick(p), role: "button", "aria-label": `Toggle ${p}` } : {});

  const leftX = BODY.x - DOOR.thick / 2;
  const rightX = BODY.x + BODY.w - DOOR.thick / 2;

  const door = (p: "frontLeft" | "frontRight" | "rearLeft" | "rearRight") => {
    const left = p.endsWith("Left");
    const seg = p.startsWith("front") ? DOOR.front : DOOR.rear;
    const x = left ? leftX : rightX;
    const hingeX = x + DOOR.thick / 2;
    const deg = isOpen(p) ? (left ? SWING : -SWING) : 0;
    return (
      <g key={p} className={cls(p)} style={pose(deg, hingeX, seg.y)} {...click(p)}>
        <rect x={x} y={seg.y} width={DOOR.thick} height={seg.h} rx={4} />
        {winOpen(p) && <rect className="win-open" x={left ? x + DOOR.thick : x - 4} y={seg.y + 10} width={4} height={seg.h - 20} rx={2} />}
      </g>
    );
  };

  const hoodOpen = isOpen("hood");
  const trunkOpen = isOpen("trunk");

  return (
    <div className="topview">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary(status)}>
        {/* body */}
        <rect className="body" x={BODY.x} y={BODY.y} width={BODY.w} height={BODY.h} rx={BODY.r} />
        {/* wheels */}
        {[
          [BODY.x - 8, 92],
          [BODY.x + BODY.w - 6, 92],
          [BODY.x - 8, 300],
          [BODY.x + BODY.w - 6, 300],
        ].map(([x, y]) => (
          <rect key={`${x}-${y}`} className="wheel" x={x} y={y} width={14} height={40} rx={5} />
        ))}
        {/* glass */}
        <path className="glass" d={`M ${BODY.x + 16} 132 Q ${W / 2} 114 ${BODY.x + BODY.w - 16} 132 L ${BODY.x + BODY.w - 22} 160 Q ${W / 2} 150 ${BODY.x + 22} 160 Z`} />
        <rect className={`roof ${winOpen("sunroof") ? "sunroof-open" : ""}`} x={BODY.x + 22} y={166} width={BODY.w - 44} height={118} rx={14} />
        <path className="glass" d={`M ${BODY.x + 22} 292 Q ${W / 2} 300 ${BODY.x + BODY.w - 22} 292 L ${BODY.x + BODY.w - 16} 314 Q ${W / 2} 324 ${BODY.x + 16} 314 Z`} />
        {/* side mirrors */}
        <rect className="mirror" x={BODY.x - 14} y={134} width={14} height={8} rx={3} />
        <rect className="mirror" x={BODY.x + BODY.w} y={134} width={14} height={8} rx={3} />

        {/* bonnet: hinged at the windscreen, tilts forward when open */}
        <g className={cls("hood")} style={pose(0, W / 2, 124, 0, hoodOpen ? -22 : 0)} {...click("hood")}>
          <path d={`M ${BODY.x + 6} 120 L ${BODY.x + 10} ${BODY.y + 30} Q ${W / 2} ${BODY.y - 2} ${BODY.x + BODY.w - 10} ${BODY.y + 30} L ${BODY.x + BODY.w - 6} 120 Z`} />
        </g>
        {/* trunk lid: hinged at the rear window, tilts back when open */}
        <g className={cls("trunk")} style={pose(0, W / 2, 320, 0, trunkOpen ? 22 : 0)} {...click("trunk")}>
          <path d={`M ${BODY.x + 12} 322 L ${BODY.x + BODY.w - 12} 322 L ${BODY.x + BODY.w - 10} ${BODY.y + BODY.h - 26} Q ${W / 2} ${BODY.y + BODY.h + 2} ${BODY.x + 10} ${BODY.y + BODY.h - 26} Z`} />
        </g>

        {door("frontLeft")}
        {door("rearLeft")}
        {door("frontRight")}
        {door("rearRight")}

        {/* lock badge */}
        <g className={`lock-badge ${status.lock === "unlocked" ? "unlocked" : status.lock === "locked" ? "locked" : ""}`}>
          <circle cx={W / 2} cy={225} r={20} />
          {/* padlock: the shackle lifts and shifts when unlocked */}
          <path
            className="shackle"
            d={status.lock === "unlocked" ? `M ${W / 2 - 2} 222 v -9 a 6 6 0 0 1 12 0 v 2` : `M ${W / 2 - 6} 222 v -6 a 6 6 0 0 1 12 0 v 6`}
          />
          <rect className="padlock" x={W / 2 - 9} y={221} width={18} height={14} rx={3} />
        </g>
        <text className="front-label" x={W / 2} y={18} textAnchor="middle">
          FRONT
        </text>
      </svg>

      <ul className="kv topview-list">
        {PARTS.map((p) => {
          const v: OpenState = doors[p] ?? "unknown";
          return (
            <li key={p} className={v === "open" ? "is-open" : ""}>
              <span>{p === "hood" ? "Bonnet" : label(p)}</span>
              <span>
                {v === "open" ? "Open" : v === "closed" ? "Closed" : "—"}
                <Dot level={v === "open" ? "bad" : v === "closed" ? "good" : "none"} />
              </span>
            </li>
          );
        })}
        <li>
          <span>Doors</span>
          <span>
            {status.lock === "locked" ? "Locked" : status.lock === "unlocked" ? "Unlocked" : "—"}
            <Dot level={status.lock === "locked" ? "good" : status.lock === "unlocked" ? "warn" : "none"} />
          </span>
        </li>
        {status.isTrunkLocked != null && (
          <li>
            <span>Trunk latch</span>
            <span>
              {status.isTrunkLocked ? "Locked" : "Unlocked"}
              <Dot level={status.isTrunkLocked ? "good" : "warn"} />
            </span>
          </li>
        )}
      </ul>
    </div>
  );
}

function summary(s: VehicleStatus) {
  const open = PARTS.filter((p) => s.doors?.[p] === "open").map((p) => (p === "hood" ? "bonnet" : label(p).toLowerCase()));
  return `Car top view. ${open.length ? `Open: ${open.join(", ")}.` : "All doors, bonnet and trunk closed."} ${s.lock ? `Doors ${s.lock}.` : ""}`;
}
