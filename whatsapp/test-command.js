import { contentEvent } from "../outbound-events.js";

const TMP_PROBE_GROUP_JID = "120363426153979898@g.us";
const TMP_PROBE_GROUP_SUBJECT = "probe-external-link-raw";

const TEST_COMMAND_USAGE = [
  "Usage: `!tmp`",
  "Usage: `!test wa methods`",
  "Usage: `!test wa smoke <base subject>`",
  "Usage: `!test wa community-create <subject>` or `!test wa community-create <subject>: <description>`",
  "Usage: `!test wa community-create-group <community-jid>: <subject>`",
  "Usage: `!test wa community-link <community-jid> <group-jid>`",
  "Usage: `!test wa community-link-smoke <community-jid>: <subject>`",
  "Usage: `!test wa community-metadata <jid>`",
  "Usage: `!test wa community-linked <jid>`",
].join("\n");

/**
 * @param {ExecuteActionContext} context
 * @param {string} message
 * @returns {Promise<void>}
 */
async function replyError(context, message) {
  await context.reply(contentEvent("error", message));
}

/**
 * @param {ExecuteActionContext} context
 * @param {string} message
 * @returns {Promise<void>}
 */
async function replyResult(context, message) {
  await context.reply(contentEvent("tool-result", message));
}

/**
 * @param {string[]} senderIds
 * @param {string[] | undefined} senderJids
 * @returns {string[]}
 */
function getTestParticipants(senderIds, senderJids) {
  const jids = senderJids ?? [];
  const preferred = jids.find((jid) => typeof jid === "string" && jid.includes("@"));
  if (preferred) {
    return [preferred];
  }
  const senderId = senderIds[0];
  if (!senderId) {
    return [];
  }
  return [`${senderId}@s.whatsapp.net`];
}

/**
 * @param {string} input
 * @returns {{ head: string, tail: string } | null}
 */
function parseColonSeparatedInput(input) {
  const separatorIndex = input.indexOf(":");
  if (separatorIndex === -1) {
    return null;
  }
  const head = input.slice(0, separatorIndex).trim();
  const tail = input.slice(separatorIndex + 1).trim();
  if (!head || !tail) {
    return null;
  }
  return { head, tail };
}

/**
 * @param {string} argsText
 * @param {string[]} participants
 * @returns {WhatsAppTestCommandInput | null}
 */
function parseWhatsAppTestArgs(argsText, participants) {
  const trimmed = argsText.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "methods") {
    return { kind: "methods" };
  }
  if (trimmed.startsWith("smoke ")) {
    const baseSubject = trimmed.slice("smoke ".length).trim();
    if (!baseSubject) {
      return null;
    }
    return {
      kind: "smoke",
      baseSubject,
      participants,
    };
  }
  if (trimmed.startsWith("community-create ")) {
    const rawSubject = trimmed.slice("community-create ".length).trim();
    if (!rawSubject) {
      return null;
    }
    const parsed = parseColonSeparatedInput(rawSubject);
    if (!parsed) {
      return {
        kind: "community-create",
        subject: rawSubject,
        description: "",
      };
    }
    return {
      kind: "community-create",
      subject: parsed.head,
      description: parsed.tail,
    };
  }
  if (trimmed.startsWith("community-create-group ")) {
    const rawArgs = trimmed.slice("community-create-group ".length).trim();
    const parsed = parseColonSeparatedInput(rawArgs);
    if (!parsed) {
      return null;
    }
    return {
      kind: "community-create-group",
      parentCommunityJid: parsed.head,
      subject: parsed.tail,
      participants,
    };
  }
  if (trimmed.startsWith("community-link ")) {
    const [parentCommunityJid, groupJid] = trimmed.slice("community-link ".length).trim().split(/\s+/, 2);
    if (!parentCommunityJid || !groupJid) {
      return null;
    }
    return {
      kind: "community-link",
      parentCommunityJid,
      groupJid,
    };
  }
  if (trimmed.startsWith("community-link-smoke ")) {
    const rawArgs = trimmed.slice("community-link-smoke ".length).trim();
    const parsed = parseColonSeparatedInput(rawArgs);
    if (!parsed) {
      return null;
    }
    return {
      kind: "community-link-smoke",
      parentCommunityJid: parsed.head,
      subject: parsed.tail,
      participants,
    };
  }
  if (trimmed.startsWith("community-metadata ")) {
    const jid = trimmed.slice("community-metadata ".length).trim();
    return jid ? { kind: "community-metadata", jid } : null;
  }
  if (trimmed.startsWith("community-linked ")) {
    const jid = trimmed.slice("community-linked ".length).trim();
    return jid ? { kind: "community-linked", jid } : null;
  }
  return null;
}

/**
 * @param {{
 *   context: ExecuteActionContext,
 *   inputText: string,
 *   senderIds: string[],
 *   senderJids?: string[],
 *   transport?: ChatTransport,
 * }} input
 * @returns {Promise<boolean>}
 */
export async function tryHandleWhatsAppTestCommand({ context, inputText, senderIds, senderJids, transport }) {
  const trimmed = inputText.trim();
  const participants = getTestParticipants(senderIds, senderJids);
  if (trimmed === "tmp") {
    if (!transport?.runWhatsAppTest) {
      await replyError(context, "WhatsApp test command is unavailable in this runtime.");
      return true;
    }
    const result = await transport.runWhatsAppTest({
      kind: "tmp",
      participants,
      groupJid: TMP_PROBE_GROUP_JID,
      groupSubject: TMP_PROBE_GROUP_SUBJECT,
    });
    await replyResult(context, result.summary);
    return true;
  }

  if (trimmed !== "test" && !trimmed.startsWith("test ")) {
    return false;
  }

  if (!transport?.runWhatsAppTest) {
    await replyError(context, "WhatsApp test command is unavailable in this runtime.");
    return true;
  }

  const remainder = trimmed.slice("test".length).trim();
  if (!remainder.startsWith("wa")) {
    await replyError(context, TEST_COMMAND_USAGE);
    return true;
  }

  const argsText = remainder.slice("wa".length).trim();
  const command = parseWhatsAppTestArgs(argsText, participants);
  if (!command) {
    await replyError(context, TEST_COMMAND_USAGE);
    return true;
  }

  const result = await transport.runWhatsAppTest(command);
  await replyResult(context, result.summary);
  return true;
}
