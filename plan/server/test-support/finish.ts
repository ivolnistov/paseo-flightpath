// Inputs of session.finish. Returned from functions, so the objects are not fresh literals and the
// `basis` and `proposalAt` fields type-check against the input type with or without them.

export const manualFinish = (projectId: string, expectedRevision: number, sessionId: string) => ({
  projectId,
  expectedRevision,
  sessionId,
  basis: "manual" as const,
});

export const proposalFinish = (projectId: string, expectedRevision: number, sessionId: string, proposalAt: string) => ({
  projectId,
  expectedRevision,
  sessionId,
  basis: "proposal" as const,
  proposalAt,
});
