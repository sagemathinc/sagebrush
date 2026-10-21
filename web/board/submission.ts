// @sagemathinc/sagebrush-board/submission (packages/sagebrush-board/build.mjs):
// what a host needs without the board itself (web/board-host-protocol.md):
// the check of a submission and of a request to decide (ask.ts), and the
// merge and checks of edits made in its frame (edit-state.ts).
export { checkSubmission, decideRequest, type Posted, type Checked, type Submission, type Deciding, type DecideRequest } from "./ask";
export { editState, recordProblems, mergeText, EDIT_LIMITS, sharedPreviewBudget, type EditState, type Applied, type Previewed, type EditOptions, type RefusalReason, type TooLargeWhat, type PreviewBudget, type BudgetLimits, type Change, type Key, type Rec, type RecordType } from "./edit-state";
