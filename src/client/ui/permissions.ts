import type { Field, Table } from "@/shared/types";
import { canChangeRecords, canEditFieldValues } from "@/shared/permissions";
import type { ClientSnapshot } from "../store";

export const canEditField = (snap: ClientSnapshot, f: Field) => canEditFieldValues(f, snap.userId, snap.role);
export const canAddRecords = (snap: ClientSnapshot, t: Table) => canChangeRecords(t, snap.userId, snap.role);
