/**
 * Constants shared by server code and route components for the feature-requests
 * tool. Kept out of the `.server` modules so route components can import them
 * without dragging server-only code into the client bundle.
 */

export const STATUSES = ["new", "planned", "in_progress", "done", "declined"] as const;
export type RequestStatus = (typeof STATUSES)[number];
export const STATUS_LABEL: Record<RequestStatus, string> = {
  new: "New",
  planned: "Planned",
  in_progress: "In progress",
  done: "Done",
  declined: "Declined",
};

export function isStatus(v: unknown): v is RequestStatus {
  return typeof v === "string" && (STATUSES as readonly string[]).includes(v);
}

export const LIMITS = {
  projectName: 80,
  intro: 280,
  origins: 20,
  title: 120,
  details: 2000,
  email: 200,
  buttonLabel: 40,
  projectsPerUser: 25,
  requestsPerProject: 2000,
};

export const DEFAULT_ACCENT = "#f5a524";
export const DEFAULT_BUTTON_LABEL = "Feature requests";
