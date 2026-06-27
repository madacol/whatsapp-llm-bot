# Declarative Vertical-Slice Test Refactor

## Subject

Design a much more declarative way to write end-to-end and vertical-slice tests, especially tests that replay captured real fixtures through a pipeline and assert the output at the outbound or Baileys layer.

## User Request

The user wants this recorded as a future task, not implemented now.

The goal is a big refactor in how vertical-slice tests are made. The user sees many vertical tests as roughly the same shape:

- start from a captured fixture of a real payload;
- replay that fixture through a specific pipeline or seam;
- assert the result at the outbound layer, Baileys layer, or another final observable surface;
- keep the test very easy to read and as declarative as possible.

Example target scenarios:

- replay a captured provider/runtime payload through presentation and assert a specific WhatsApp/Baileys message was sent;
- replay a captured inbound WhatsApp payload through the inbound pipeline and assert a slash command was received and produced a specific final message;
- validate the whole path from inbound event through parsing, routing, command/runtime handling, outbound event production, and socket send output.

## Desired Properties

- Tests should read as scenario declarations, not imperative harness plumbing.
- Fixture source, replay pipeline, and expected output should be obvious at a glance.
- Real captured payloads should remain the primary input for vertical behavior.
- Assertions should be at user-valued output seams: outbound events, rendered WhatsApp blocks, Baileys send calls, command replies, or final persisted results.
- The refactor should reduce repeated setup code across e2e/vertical tests without hiding important domain behavior.
- It should support both narrow replay tests and wider inbound-to-outbound tests.

## Candidate Designs To Explore

### Option 1: Fluent Scenario Builder

Create a test helper with a fluent interface:

```js
await scenario("slash command from captured inbound")
  .givenFixture("whatsapp/messages-upsert/slash-diff.json")
  .through("whatsapp-inbound-to-baileys")
  .withChat({ enabled: true, harness: "codex" })
  .expectBaileysMessage({ textIncludes: "..." })
  .run();
```

Benefits:

- Easy to read in plain JavaScript.
- Can keep precise assertions with normal JS functions when needed.
- Good migration path from current tests because setup can be extracted incrementally.

Risks:

- A fluent interface can become too broad if every test adds one more method.
- Needs discipline around naming supported pipelines and expected output surfaces.

### Option 2: Data-First Scenario Manifests

Represent vertical-slice tests as JSON/YAML manifests next to fixtures:

```yaml
name: slash command sends diff
fixture: whatsapp/messages-upsert/slash-diff.json
pipeline: whatsapp-inbound-to-baileys
chat:
  enabled: true
expect:
  baileys:
    - textContains: "diff"
```

Benefits:

- Most declarative and easiest to scan.
- Good for large libraries of captured fixture replays.
- Fixtures and expectations can live together.

Risks:

- Complex assertions may become an awkward custom assertion language.
- Debugging can be worse if failures point to a manifest interpreter instead of a normal test line.

### Option 3: Thin DSL Over Existing Test Harnesses

Keep tests as normal `node:test` files, but introduce small declarative primitives:

```js
await replayFixture({
  fixture: "whatsapp/messages-upsert/slash-command.json",
  pipeline: whatsappInboundToBaileys(),
  expect: [
    sentMessage({ text: includes("Session cleared") }),
  ],
});
```

Benefits:

- Lower abstraction risk than a full fluent builder.
- Keeps assertions composable and type-checkable.
- Easier to introduce pipeline by pipeline.

Risks:

- Less visually declarative than manifests.
- Without conventions, tests may drift back into imperative setup.

### Option 4: Golden Output Snapshots With Semantic Matchers

Replay real fixtures and compare normalized outbound/Baileys output to committed golden files, with semantic matchers for dynamic fields.

Benefits:

- Strong fit for fixture replay and presentation-heavy tests.
- Makes broad behavior changes visible.
- Useful for real payload regressions.

Risks:

- Snapshots can become noisy if not normalized aggressively.
- Review quality drops if snapshots are too large or too incidental.

## Recommended Exploration Path

Start with Option 3 as the implementation base and borrow Option 1 naming for readability. It gives a declarative test shape without inventing a manifest language too early. Once the repeated scenario vocabulary is stable, decide whether some scenarios deserve data-first manifests or golden snapshots.

## Acceptance Criteria

- A future design pass proposes multiple concrete approaches and picks one with tradeoffs.
- The first implementation slice proves at least two pipelines:
  - captured inbound WhatsApp payload to final Baileys send;
  - captured runtime/provider payload to outbound/Baileys presentation.
- New tests read declaratively enough that fixture, pipeline, and expectation are visible without scanning harness setup.
- Existing vertical-slice behavior remains covered during migration.
