# Tool expansion and reliability

User priorities: resumable reads first; execution errors are structured evidence
for Ayana to explain, not red technical instructions in the normal conversation.
Preserve capability boundaries and contextual tool exposure.

Implementation commits:
1. Shared capability metadata, live access descriptions and unavailable reasons.
2. Resumable text, directory and content searches with stale-cursor detection.
3. Execution receipts and grounded verification; assistant-mediated failures.
4. Owned background processes with incremental logs and lifecycle cleanup.
5. Read-only document adapters behind files.read.
6. Managed browser sessions and observation.
7. Browser element actions with fresh observation and completion evidence.
8. Integration checks, capability documentation and packaging requirements.

Each step gets meaningful tests and a separate commit. Existing unrelated local
changes must stay outside these commits. File operations, shell/process commands,
public web reading, managed browser interaction and bound desktop interaction
have distinct owners. Adding a format does not add a new model tool.

Completed: all eight implementation steps. Registered tools increased from 20
to 26 (three process and three browser tools); document formats share files.read.
An additional corrective commit kept another chat's prompt integration out of
the committed tool implementation, while retaining its working-tree changes.

Final validation used an exported Git index snapshot, independent of unrelated
local edits: 301 Python tests passed, 9 skipped; desktop TypeScript checking and
frontend regression tests passed. Real subprocess services, PDF/Office parsing,
and Edge DOM interactions were exercised. The native model loop was tested with
mocked model responses and actual browser execution/observed completion evidence.
See TOOL_BOUNDARIES.md for installation, lifecycle policy and current limits.
