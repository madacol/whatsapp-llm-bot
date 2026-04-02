/**
 * Create TurnIO for synthetic seeded turns. Prefer semantic event transport so
 * seeded runs share the same rendering/edit pipeline as real chat turns.
 * The presenter owns how those events are realized on the adapter surface.
 * @param {{
 *   sendEvent: (event: OutboundEvent) => Promise<MessageHandle | undefined>,
 * }} input
 * @returns {TurnIO}
 */
export function createSeedTurnIo({ sendEvent }) {
  return {
    getIsAdmin: async () => true,
    react: async () => {},
    select: async () => "",
    selectMany: async () => ({ kind: "cancelled" }),
    send: sendEvent,
    reply: sendEvent,
    confirm: async () => false,
    startPresence: async () => {},
    keepPresenceAlive: async () => {},
    endPresence: async () => {},
  };
}
