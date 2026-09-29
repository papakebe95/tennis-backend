import { describe, expect, it } from 'vitest';
import { ACTIVE_ENTRY_STATUSES } from './competitions.service.js';

// The lifecycle rules the player API relies on (public status mapping,
// registration window) are tested in admin/tournaments/tournament-rules.spec.ts.
describe('competitions (player API)', () => {
  it('counts pending, approved and waitlisted entries as registered', () => {
    expect(ACTIVE_ENTRY_STATUSES).toEqual(['PENDING', 'APPROVED', 'WAITLISTED']);
  });
});
