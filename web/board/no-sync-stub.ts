// The board page without sync (the frame other sites embed, and exported boards; web/build.ts): its build resolves
// the sync owner, the Storage panel's sync section and the rows' icons here, so none of them, nor the client they
// lead to, is in that copy.  Every use is behind __SB_NO_SYNC__ (true there), so none is reached; these throw if one
// ever is.
const never = (what: string): never => {
  throw new Error(`sync isn't in this copy of the board page (${what})`);
};
export class SyncOwner {
  static of(): never {
    return never("SyncOwner");
  }
}
export const foot = (): never => never("foot");
export const sidebarLine = (): never => never("sidebarLine");
export const syncSection = (): never => never("syncSection");
export const rowIcons = (): never => never("rowIcons");
export const ROWICON = { max: 0, minGapMs: 0 };
