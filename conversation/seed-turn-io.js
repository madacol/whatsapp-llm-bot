/**
 * Create ChannelInputIO for synthetic seeded inputs. Prefer semantic event
 * transport so seeded runs share the same rendering/edit pipeline as real
 * channel inputs.
 * The presenter owns how those events are realized on the adapter surface.
 * @param {{
 *   sendEvent: (event: OutboundEvent) => Promise<MessageHandle | undefined>,
 * }} input
 * @returns {ChannelInputIO}
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
  };
}
