import { api } from "./client";
import type {
  AddSquadMemberInput,
  CreateFeedbackNoteInput,
  CreateSquadInput,
  DecideDispatchInput,
  DeclineDispatchInput,
  FeedbackNote,
  FeedbackNoteStatus,
  ListDispatchesQuery,
  Squad,
  SquadDispatch,
  SquadMember,
  UpdateSquadInput,
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

const enc = encodeURIComponent;

export const squadsApi = {
  list: (companyId: string) => api.get<Squad[]>(`/companies/${enc(companyId)}/squads`),
  create: (companyId: string, input: CreateSquadInput) =>
    api.post<Squad>(`/companies/${enc(companyId)}/squads`, input),
  get: (squadId: string) => api.get<Squad>(`/squads/${enc(squadId)}`),
  update: (squadId: string, input: UpdateSquadInput) =>
    api.patch<Squad>(`/squads/${enc(squadId)}`, input),

  members: (squadId: string) => api.get<SquadMember[]>(`/squads/${enc(squadId)}/members`),
  addMember: (squadId: string, input: AddSquadMemberInput) =>
    api.post<SquadMember>(`/squads/${enc(squadId)}/members`, input),
  removeMember: (squadId: string, memberId: string) =>
    api.delete<void>(`/squads/${enc(squadId)}/members/${enc(memberId)}`),

  dispatches: (squadId: string, filters: ListDispatchesQuery = {}) => {
    const params = new URLSearchParams();
    if (filters.state) params.set("state", filters.state);
    if (filters.limit !== undefined) params.set("limit", String(filters.limit));
    const search = params.toString();
    return api.get<SquadDispatch[]>(
      `/squads/${enc(squadId)}/dispatches${search ? `?${search}` : ""}`,
    );
  },

  /** Deciding an already-dispatched item is a reassignment: the server appends a new dispatch. */
  decide: (dispatchId: string, input: DecideDispatchInput) =>
    api.post<SquadDispatch>(`/squad-dispatches/${enc(dispatchId)}/decide`, input),
  decline: (dispatchId: string, input: DeclineDispatchInput) =>
    api.post<SquadDispatch>(`/squad-dispatches/${enc(dispatchId)}/decline`, input),
};
