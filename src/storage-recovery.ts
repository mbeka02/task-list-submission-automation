import { lstatSync } from "node:fs";

/** Keep the review marker beside the SQLite file on the same persistent volume. */
export function restoreReviewPath(databasePath: string): string {
  return `${databasePath}-restore-review.json`;
}

/** Any marker or inspection failure pauses work; an environment flag cannot bypass restored state. */
export function requiresRestoreReview(databasePath: string): boolean {
  try {
    lstatSync(restoreReviewPath(databasePath));
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    );
  }
}
