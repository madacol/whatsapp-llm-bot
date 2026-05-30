/**
 * Build WhatsApp text payloads with URL preview generation disabled. Baileys
 * otherwise tries to lazy-load an optional preview dependency on every URL.
 *
 * @template {Record<string, unknown>} T
 * @param {string} text
 * @param {T} [extra]
 * @returns {{ text: string, linkPreview: null } & T}
 */
export function makeTextMessage(text, extra) {
  return {
    text,
    ...(extra ?? /** @type {T} */ ({})),
    linkPreview: null,
  };
}

/**
 * Build WhatsApp image payloads without asking Baileys to derive thumbnails
 * from generated buffers.
 *
 * @param {Buffer} image
 * @param {string | undefined} [caption]
 * @returns {{ image: Buffer, jpegThumbnail: "", caption?: string }}
 */
export function makeImageMessage(image, caption) {
  return {
    image,
    jpegThumbnail: "",
    ...(caption && { caption }),
  };
}
