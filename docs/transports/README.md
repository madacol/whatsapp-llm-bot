# Transports

Concrete Transport docs live here. Each Transport doc should own the transport-specific vocabulary, external identifiers, protocol compatibility details, and internal submodule map for that Transport.

The app-wide vocabulary stays in `docs/glossary.md`: Transport, Channel, ChannelInput, OutboundEvent, Session, and Invocation. Do not promote a concrete Transport's internal seams or external payload names into app-wide concepts unless another Transport needs the same app-owned abstraction.

- [HTTP API](http-api.md)
- [WhatsApp](whatsapp.md)
