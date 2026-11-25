# Stage4 owner rulings O1–O3

Owner supplied these decisions on2026-10-21 during the ordinary exact review of READY Stage4
commit `19a33efade64935d515b4202171836266e0cab4c`. They authorize dependent design/card completion
and implementation under the existing approved plan. They do not authorize live tracker writes,
credential changes or publication. Source-connection verification precedes adapter implementation.

- **O1:** the plugin uses its own MCP client based on the current SnailOrbit connection.
  Verify the actual connection source and plugin-side contract separately. Keep secrets out of
  project data and do not assume an agent MCP session can be reused.
- **O2:** for an unknown outcome, the UI may link a manually found ticket, or explicitly record
  the human's confirmation that no ticket was created before a fresh preview is permitted.
  No automatic retry or blind duplicate creation.
- **O3:** configure the close field and final value explicitly for each destination project,
  and show both in the exact preview. Changes must invalidate any prior confirmation token.

The currently reviewed READY tree remains frozen. Additions use the same retained production,
test and read-only roles, with updated task cards and ordinary KensAI on the exact new revision.
