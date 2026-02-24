import nodemailer from "nodemailer";

/** Status codes that indicate auth credentials are invalid and must be cleared.
 *  401 = logged out, 403 = forbidden, 405 = session rejected, 419 = auth expired */
const AUTH_FAILURE_CODES = new Set([401, 403, 405, 419]);

/**
 * Check if a Baileys disconnect error requires clearing auth and re-pairing.
 * Baileys wraps errors as Boom objects with an `output.statusCode` field.
 * @param {{ error?: Error | (Error & { output?: { statusCode?: number } }) } | undefined} lastDisconnect
 * @returns {boolean}
 */
export function needsAuthReset(lastDisconnect) {
  const error = /** @type {{ output?: { statusCode?: number } } | undefined} */ (lastDisconnect?.error);
  return AUTH_FAILURE_CODES.has(error?.output?.statusCode ?? 0);
}

/**
 * Send an alert email notification.
 * Requires SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and ALERT_EMAIL env vars.
 * Silently logs and returns if env vars are not configured.
 * @param {string} subject
 * @param {string} body
 */
export async function sendAlertEmail(subject, body) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_EMAIL } = process.env;

  if (!SMTP_HOST || !ALERT_EMAIL) {
    console.warn("Email alert skipped: SMTP_HOST and ALERT_EMAIL env vars required");
    return;
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: (Number(SMTP_PORT) || 587) === 465,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });

  try {
    await transporter.sendMail({
      from: SMTP_USER || `alert@${SMTP_HOST}`,
      to: ALERT_EMAIL,
      subject,
      text: body,
    });
    console.log("Alert email sent to", ALERT_EMAIL);
  } catch (err) {
    console.error("Failed to send alert email:", err);
  }
}
