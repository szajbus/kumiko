// The review pane: a deliver card's changes, file by file, as the user reads them before approving.

/** The review pane's widget, one per window: it shows the card the user last opened it for. */
export const REVIEW = "review";

/** What the review pane shows: the approval card it is for, by its ask's id. */
export interface ReviewState {
  ask: string;
  /**
   * The head of the card it showed before Kumiko moved it to this one: Claude delivered the same branch again, after a
   * request for changes. Absent when the user opened the pane on this card.
   */
  refreshed?: string;
}

/** One hunk of a file's patch, as git writes it: each line starts with " ", "+", "-" or "\\". */
export interface ReviewHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export type ReviewStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "type";

/** One file the branch changes, with its patch. */
export interface ReviewFile {
  path: string;
  /** Where a renamed or copied file came from. */
  oldPath?: string;
  status: ReviewStatus;
  /** Lines added and deleted; undefined for a binary file. */
  added?: number;
  deleted?: number;
  binary?: boolean;
  /** The file's blobs before and after, absent where it doesn't exist: what expanding its context reads. */
  oldBlob?: string;
  newBlob?: string;
  oldMode?: string;
  newMode?: string;
  hunks: ReviewHunk[];
  /** Its patch is longer than the pane shows at once; it can be asked for on its own. */
  tooLarge?: boolean;
  /** Its only changes are in whitespace, which the diff was asked to leave out. */
  whitespaceOnly?: boolean;
  /** Under .github/: what CI runs, with the repository's secrets. */
  flagged?: boolean;
}

/** What changed between two commits of a deliver card's branch. */
export interface ReviewDiff {
  /** The commits compared: `from` is the merge base, a commit's parent, or the head reviewed before. */
  from: string;
  to: string;
  files: ReviewFile[];
  /** For a diff of one commit, or of all a branch that has only one: that commit's whole message. */
  message?: string;
}

/** How many patch lines a review diff holds before the rest of its files come as `tooLarge`. */
export const REVIEW_MAX_LINES = 20_000;
/** How many patch lines one file may have and still come with a diff of the whole branch. */
export const REVIEW_FILE_MAX_LINES = 3_000;
/** The most of a file the pane reads to show more of it around a change. */
export const REVIEW_MAX_BLOB_BYTES = 4 * 1024 * 1024;
