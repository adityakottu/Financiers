import { ApiError } from '../common/errors';

/**
 * Optimistic locking: updates must send `If-Match: "v<version>"` (or a bare number) from the
 * record they edited, so two people editing at once can't silently overwrite each other.
 */
export function expectedVersion(ifMatch: string | undefined): number {
  const m = ifMatch?.trim().match(/^(?:W\/)?"?v?(\d+)"?$/);
  if (!m) throw new ApiError(428, 'VERSION_REQUIRED', 'Send the record version in the If-Match header');
  return Number(m[1]);
}
