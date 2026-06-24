import { createHash } from "node:crypto";
import { proto } from "@whiskeysockets/baileys";
import { aesEncryptGCM, hmacSign } from "@whiskeysockets/baileys/lib/Utils/crypto.js";

export const RAW_LID_POLL_FIXTURE = Object.freeze({
  chatId: "120363000000000000@g.us",
  pollMsgId: "POLL-LID-1",
  botPhoneJid: "111111111111:1@s.whatsapp.net",
  botLidJid: "222222222222222@lid",
  voterLidJid: "333333333333333@lid",
  voterPhoneJid: "444444444444@s.whatsapp.net",
  selectedOption: "✅ any",
  pollEncKey: Buffer.from("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", "hex"),
  encIv: Buffer.from("00112233445566778899aabb", "hex"),
});

/**
 * Create an encrypted Baileys poll vote using the same derivation as
 * `decryptPollVote`, so tests can exercise raw vote decryption without
 * storing real WhatsApp identifiers.
 * @param {{
 *   pollMsgId: string;
 *   pollCreatorJid: string;
 *   voterJid: string;
 *   pollEncKey: Buffer;
 *   encIv: Buffer;
 *   selectedOption: string;
 * }} input
 * @returns {{ encPayload: Buffer, encIv: Buffer }}
 */
export function createEncryptedPollVote({
  pollMsgId,
  pollCreatorJid,
  voterJid,
  pollEncKey,
  encIv,
  selectedOption,
}) {
  const selectedOptionHash = createHash("sha256").update(selectedOption).digest();
  const plaintext = proto.Message.PollVoteMessage.encode({
    selectedOptions: [selectedOptionHash],
  }).finish();
  const sign = Buffer.concat([
    Buffer.from(pollMsgId),
    Buffer.from(pollCreatorJid),
    Buffer.from(voterJid),
    Buffer.from("Poll Vote"),
    new Uint8Array([1]),
  ]);
  const key0 = hmacSign(pollEncKey, new Uint8Array(32), "sha256");
  const decKey = hmacSign(sign, key0, "sha256");
  const aad = Buffer.from(`${pollMsgId}\u0000${voterJid}`);
  return {
    encPayload: aesEncryptGCM(plaintext, decKey, encIv, aad),
    encIv,
  };
}
