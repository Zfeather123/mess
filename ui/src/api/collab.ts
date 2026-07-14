import { api } from "./client";
import type {
  CreateFeedbackNoteInput,
  FeedbackNote,
  FeedbackNoteStatus,
  Squad,
  SquadMember,
} from "./collab-types";

// Collaboration layer (JIN-53): squads + agent feedback notes.
//
// These talk to the real routes and nothing else. A 404 here means the resource
// is gone — an archived note, a deleted squad — and it must reach the caller as
// an error. The demo-data fallback this module used to carry (JIN-60, while the
// routes were still unwritten) would have swallowed exactly those, showing
// invented notes in place of a legitimate error.

export * from "./collab-types";

export const feedbackNotesApi = {
  /** Ordered `weight desc, createdAt desc` by the server — the prompt-injection order. */
  list: (agentId: string, status: FeedbackNoteStatus = "active") =>
    api.get<FeedbackNote[]>(
      `/agents/${encodeURIComponent(agentId)}/feedback-notes?status=${status}`,
    ),
  create: (agentId: string, input: CreateFeedbackNoteInput) =>
    api.post<FeedbackNote>(`/agents/${encodeURIComponent(agentId)}/feedback-notes`, input),
  archive: (noteId: string) =>
    api.patch<FeedbackNote>(`/agent-feedback-notes/${encodeURIComponent(noteId)}`, {
      status: "archived",
    }),
};

export const squadsApi = {
  list: (companyId: string) => api.get<Squad[]>(`/companies/${encodeURIComponent(companyId)}/squads`),
  members: (squadId: string) =>
    api.get<SquadMember[]>(`/squads/${encodeURIComponent(squadId)}/members`),
};
