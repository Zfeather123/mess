// Wire types for the collaboration layer (squads + agent feedback notes).
//
// These are RE-EXPORTS, not a copy. The shapes live in `@paperclipai/shared` (see
// `packages/shared/src/dto`), which is also what the server maps its responses
// through — one definition, two consumers.
//
// The hand-written mirror that used to live here drifted from the server within a
// single sprint: it claimed `SquadMember.agent` and `FeedbackNote.scopeLabel`,
// neither of which the server has ever sent. Nothing went red, because a mirror
// only mirrors what its author believed on the day they typed it. Renaming a
// server field now breaks this file at compile time, and the contract test in
// `packages/shared` refuses the change before it can ship.
//
// The local aliases keep the UI's vocabulary (`FeedbackNote`, not
// `AgentFeedbackNoteDto`) so call sites read the same as before.

export type {
  AgentFeedbackNoteKind as FeedbackNoteKind,
  AgentFeedbackNoteScopeType as FeedbackNoteScopeType,
  AgentFeedbackNoteSourceType as FeedbackNoteSourceType,
  AgentFeedbackNoteStatus as FeedbackNoteStatus,
  SquadDispatchState,
  SquadMemberRole,
  SquadMemberType,
} from "@paperclipai/shared";

export type {
  // Responses — exactly what the routes send, field for field.
  AgentFeedbackNoteDto as FeedbackNote,
  SquadDto as Squad,
  SquadMemberDto as SquadMember,
  SquadDispatchDto as SquadDispatch,
  // Requests — the pre-validation shape (`z.input`), so optional fields stay optional.
  AddSquadMemberInput,
  CreateAgentFeedbackNoteInput as CreateFeedbackNoteInput,
  CreateSquadInput,
  DecideSquadDispatchInput as DecideDispatchInput,
  DeclineSquadDispatchInput as DeclineDispatchInput,
  ListSquadDispatchesQueryInput as ListDispatchesQuery,
  UpdateSquadInput,
} from "@paperclipai/shared";
