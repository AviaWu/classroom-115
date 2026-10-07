# Teacher transaction download reduction

## Changes

- Teacher root reads fetch only the room, roster and authoritative student states. They no longer fetch all pets, public bosses or public question papers.
- After a conditional room write, the coordinator uses its acknowledged server response instead of rereading the room.
- Before finalization, only roster and student states are refreshed; the final ETag transaction reads the latest room and checks the projection lock.
- New synchronization plans record changed pet UIDs and changed public projection collections. Unchanged collections are neither embedded in the plan nor read/written during projection.
- Restore/initialize republish all projections; student resizing includes all mapped pet targets to clean removed students.
- The new coordinator can still recover older full projection plans.
- Realtime subscriptions, conditional ETag writes, server timestamps, operation receipts and student idempotency markers remain in place.

## Verified scope

Mocked browser transport tests verify a non-final cooperative click uses four REST GET requests instead of seven (including the initial ETag GET). The conditional PUT response still downloads the committed room. Final cooperative completion removes two redundant full-room GET requests and avoids unrelated projection downloads. These counts assume no conflict or retry; they do not measure production bytes or realtime subscription traffic.

Large fixture tests verify unchanged pets/question banks are excluded from compact plans. Reward, replay, concurrent student changes, full restore and interrupted-operation recovery are covered by unit/integration tests. These are not production or Firebase Emulator measurements.

## Deployment precautions

1. Wait for teacher operations to finish and close all old teacher tabs before deployment. Old coordinator code does not understand compact projection plans and must not run concurrently with the new version.
2. Deploy the updated hosting files together, including all changed modules and the page.
3. Reopen/reload all teacher pages before resuming operations.
4. Monitor Realtime Database downloaded bytes under comparable activity. Historical spikes cannot be attributed to an exact path from this code inspection alone.

No database migration or rules changes are required by this change. No deployment is performed automatically.

## Remaining costs

Room ETag transactions still download and return the whole room, including progress/catalogues. Initial subscriptions and tab reconnects also download data. This change reduces redundant traffic; it does not eliminate all full-room transfers or establish a production percentage reduction. Ordinary rewards no longer repair pre-existing unrelated projection drift; a deliberate full restore or maintenance repair is required for that separate issue.
