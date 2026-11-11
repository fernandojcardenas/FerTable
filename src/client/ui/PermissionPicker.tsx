"use client";

import type { EditPermission } from "@/shared/types";
import { useBase } from "./common";

/** Pick who may do something: everyone who can edit, owners only, or chosen people. */
export function PermissionPicker({ value, onChange, label }: { value: EditPermission | undefined; onChange: (p: EditPermission) => void; label: string }) {
  const { snap } = useBase();
  const people = Object.entries(snap.state.people ?? {});
  const mode = !value || value === "editors" ? "editors" : value === "owners" ? "owners" : "people";
  const ids = typeof value === "object" ? value.userIds : [];
  return (
    <div className="stack" style={{ gap: 6 }}>
      <label className="field-label">{label}
        <select className="select" value={mode} onChange={(e) => {
          const m = e.target.value;
          onChange(m === "editors" ? "editors" : m === "owners" ? "owners" : { userIds: ids });
        }}>
          <option value="editors">Everyone who can edit the base</option>
          <option value="owners">Owners only</option>
          <option value="people">Specific people (and owners)</option>
        </select>
      </label>
      {mode === "people" && (
        <div className="stack" style={{ gap: 2, maxHeight: 160, overflow: "auto" }}>
          {people.length === 0 && <span className="muted small">No members yet.</span>}
          {people.map(([id, p]) => (
            <label key={id} className="row small" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={ids.includes(id)} onChange={(e) => onChange({ userIds: e.target.checked ? [...ids, id] : ids.filter((x) => x !== id) })} />
              {p.name} <span className="muted">{p.email}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
