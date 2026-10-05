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
