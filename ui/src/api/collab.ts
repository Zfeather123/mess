import { ApiError, api } from "./client";
import {
  mockArchiveFeedbackNote,
  mockCreateFeedbackNote,
  mockListFeedbackNotes,
  mockListSquadMembers,
  mockListSquads,
} from "@/lib/collab-mock";
import type {
  CreateFeedbackNoteInput,
  FeedbackNote,
  FeedbackNoteStatus,
  Squad,
  SquadMember,
} from "./collab-types";

// Collaboration layer (JIN-53): squads + agent feedback notes.
//
// The DB schema landed with JIN-50; the HTTP routes are still being written.
// Until they exist these calls answer from an in-memory demo store so the pages
// stay interactive. The types in `collab-types` ARE the agreed contract — when
// the routes land, delete `withMockFallback` plus the `collab-mock` module and
// nothing else has to change.

export * from "./collab-types";

/**
 * A payload plus whether it came from the demo store rather than the server.
 * Callers surface `mock: true` in the UI so nobody mistakes seeded notes for
 * real ones.
 */
export interface CollabResult<T> {
  data: T;
  mock: boolean;
}

const live = <T>(data: T): CollabResult<T> => ({ data, mock: false });
const mocked = <T>(data: T): CollabResult<T> => ({ data, mock: true });

/** A 404/501 means the route is not mounted yet — anything else is a real error. */
function isRouteMissing(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 501);
}

async function withMockFallback<T>(
  request: () => Promise<T>,
  fallback: () => T | Promise<T>,
): Promise<CollabResult<T>> {
  try {
    return live(await request());
  } catch (error) {
    if (!isRouteMissing(error)) throw error;
    return mocked(await fallback());
  }
}

export const feedbackNotesApi = {
  list: (agentId: string, status: FeedbackNoteStatus = "active") =>
    withMockFallback(
      () =>
        api.get<FeedbackNote[]>(
          `/agents/${encodeURIComponent(agentId)}/feedback-notes?status=${status}`,
        ),
      () => mockListFeedbackNotes(agentId, status),
    ),
  create: (agentId: string, input: CreateFeedbackNoteInput) =>
    withMockFallback(
      () => api.post<FeedbackNote>(`/agents/${encodeURIComponent(agentId)}/feedback-notes`, input),
      () => mockCreateFeedbackNote(agentId, input),
    ),
  archive: (noteId: string) =>
    withMockFallback(
      () =>
        api.patch<FeedbackNote>(`/agent-feedback-notes/${encodeURIComponent(noteId)}`, {
          status: "archived",
        }),
      () => mockArchiveFeedbackNote(noteId),
    ),
};

export const squadsApi = {
  list: (companyId: string) =>
    withMockFallback(
      () => api.get<Squad[]>(`/companies/${encodeURIComponent(companyId)}/squads`),
      () => mockListSquads(),
    ),
  members: (squadId: string) =>
    withMockFallback(
      () => api.get<SquadMember[]>(`/squads/${encodeURIComponent(squadId)}/members`),
      () => mockListSquadMembers(),
    ),
};
