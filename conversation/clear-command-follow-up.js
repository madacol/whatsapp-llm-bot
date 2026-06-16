/**
 * @param {string} text
 * @param {"!" | "/"} prefix
 * @returns {{ prompt: string } | null}
 */
function parseClearCommandText(text, prefix) {
  const escapedPrefix = prefix === "/" ? "\\/" : "!";
  const match = text.match(new RegExp(`^${escapedPrefix}clear(?:\\s+([\\s\\S]*))?$`, "i"));
  if (!match) {
    return null;
  }
  return { prompt: match[1]?.trim() ?? "" };
}

/**
 * @param {ChatTurn} turn
 * @param {TextContentBlock} firstBlock
 * @param {"!" | "/"} prefix
 * @returns {{ followUpTurn: ChatTurn | null } | null}
 */
export function buildClearCommandFollowUp(turn, firstBlock, prefix) {
  const parsed = parseClearCommandText(firstBlock.text, prefix);
  if (!parsed) {
    return null;
  }
  const firstTextIndex = turn.content.indexOf(firstBlock);
  if (firstTextIndex === -1) {
    return { followUpTurn: null };
  }
  /** @type {IncomingContentBlock[]} */
  const followUpContent = [];
  for (let index = 0; index < turn.content.length; index += 1) {
    const block = turn.content[index];
    if (index === firstTextIndex) {
      if (parsed.prompt) {
        followUpContent.push({ type: "text", text: parsed.prompt });
      }
      continue;
    }
    followUpContent.push(block);
  }
  if (followUpContent.length === 0) {
    return { followUpTurn: null };
  }
  return {
    followUpTurn: {
      ...turn,
      content: followUpContent,
      facts: {
        ...turn.facts,
        addressedToBot: true,
      },
    },
  };
}
