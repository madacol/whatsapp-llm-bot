# WhatsApp Transport

`whatsapp/` is the concrete WhatsApp Transport. It owns the Baileys adapter details and converts between WhatsApp protocol behavior and app-owned ChannelInputs, OutboundEvents, prompts, reactions, queues, and workspace surfaces.

WhatsApp Transport may have internal seams for locality, but callers outside `whatsapp/` should use its public surface rather than reaching into provider-specific internals.

## Vocabulary

- **WhatsApp chat**: A WhatsApp-specific external address, currently represented by Baileys `remoteJid` / `chatId`. This name should stay inside WhatsApp Transport or compatibility edges; app-wide code should use Channel vocabulary.
- **Baileys**: The WhatsApp socket/protocol library used by this Transport. Baileys payload details should stay inside WhatsApp Transport unless converted into app-owned ChannelInput, OutboundEvent, or prompt concepts.

## Public Surface

- `whatsapp/index.js`: public module entry point.
- `whatsapp/create-whatsapp-transport.js`: main Transport adapter assembly. It wires connection state, inbound dispatch, outbound queue flushing, prompt runtimes, edit-handle operations, and workspace/community operations.

## Connection And Protocol Compatibility

- `whatsapp/connection-supervisor.js`: starts, stops, and reconnects the Baileys socket.
- `whatsapp/message-payloads.js`: constructs common WhatsApp message payload shapes.
- `whatsapp-hd-media.js`: handles WhatsApp HD media sending.
- Baileys compatibility logic should stay inside WhatsApp Transport unless another Transport needs the same app-owned concept.

## Inbound Submodules

- `whatsapp/inbound/message-event-classifier.js`: separates normal message upserts, reactions, polls, and ignored WhatsApp events.
- `whatsapp/inbound/message-content.js`: extracts text, media, quote, sender, and message content facts from Baileys payloads.
- `whatsapp/inbound/chat-turn.js`: converts normalized WhatsApp message content into app-owned ChannelInputs. The file name still carries the legacy turn vocabulary.
- `whatsapp/inbound/hd-image-lifecycle.js`: tracks HD image parent/child receive behavior.
- `whatsapp/inbound/ingress-journal.js`: stores inbound events until app processing acknowledges them.
- `whatsapp/inbound/ingress-dispatcher.js`: replays and dispatches journaled inbound events.

## Outbound Submodules

- `whatsapp/outbound/event-rendering.js`: maps OutboundEvents to WhatsApp outbound content.
- `whatsapp/outbound/send-content.js`: high-level outbound Presentation and message-handle behavior for WhatsApp.
- `whatsapp/outbound/delivery-plan.js`: builds `WhatsAppDeliveryPlan`, the pure deterministic outbound Presentation artifact. It must not call sockets, queues, databases, reaction runtimes, live handles, or Baileys execution helpers.
- `whatsapp/outbound/delivery-plan-executor.js`: executes a `WhatsAppDeliveryPlan` through Baileys socket calls. It owns send, relay, edit, reaction, pin, HD media, and album execution details.
- `whatsapp/outbound/delivery-diagnostics.js`: captures outbound diagnostics for WhatsApp delivery attempts.
- `whatsapp/outbound/file-change-content.js`: renders file-change events into WhatsApp-ready content.
- `whatsapp/outbound/queue-store.js`: persists durable outbound queue rows.
- `whatsapp/outbound/persistent-queue.js`: decides whether to send now or enqueue.
- `whatsapp/outbound/queue-replay.js`: replays durable outbound rows when the socket becomes available.
- `whatsapp/outbound/queued-handles.js`: resolves message handles that were created while outbound work was queued.

## Runtime Prompt Submodules

- `whatsapp/runtime/reaction-runtime.js`: routes WhatsApp reactions to subscribers such as inspect and continuation flows.
- `whatsapp/runtime/select-runtime.js`: owns WhatsApp poll-based select and multi-select prompts.
- `whatsapp/runtime/confirm-runtime.js`: owns WhatsApp poll-based confirmation prompts.

## Presentation Helper Submodules

- `whatsapp/tool-presentation-model.js`: semantic tool presentation model used by WhatsApp rendering.
- `whatsapp/tool-presenter.js`: formats semantic tool presentations for WhatsApp.
- `whatsapp/tool-flow-presenter.js`: formats compact tool-flow state for WhatsApp.

## Workspace Surface Submodules

- `whatsapp/workspace-presenter.js`: presents workspace lifecycle behavior through WhatsApp chats.
- `whatsapp/workspace-topology.js`: maps project/workspace relationships onto WhatsApp chat/community topology.

## Outbound Delivery Policy

Durable truth stays in OutboundEvents or semantic queue payloads. `WhatsAppDeliveryPlan` is the WhatsApp Presentation artifact produced from that durable truth. Raw Baileys attempts are disposable, and delivery is at-least-once rather than exactly-once across process death.

For retries, the queue owns persistence, replay timing, and quarantine. The delivery executor owns only transport execution for a plan step.
