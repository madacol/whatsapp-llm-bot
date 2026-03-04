import nodemailer from "nodemailer";
import config from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("notifications");

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
  const { smtp_host, smtp_port, smtp_user, smtp_pass, alert_email } = config;

  if (!smtp_host || !alert_email) {
    log.warn("Email alert skipped: SMTP_HOST and ALERT_EMAIL env vars required");
    return;
  }

  const transporter = nodemailer.createTransport({
    host: smtp_host,
    port: smtp_port,
    secure: smtp_port === 465,
    auth: smtp_user ? { user: smtp_user, pass: smtp_pass } : undefined,
  });

  try {
    await transporter.sendMail({
      from: smtp_user || `alert@${smtp_host}`,
      to: alert_email,
      subject,
      text: body,
    });
    log.info("Alert email sent to", alert_email);
  } catch (err) {
    log.error("Failed to send alert email:", err);
  }
}
