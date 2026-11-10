// Outgoing email. With SMTP_URL set, mail goes out over SMTP; otherwise each
// message is written to the server log, which is enough to run everything locally.
//
//   SMTP_URL=smtps://user:password@smtp.example.com:465
//   MAIL_FROM="gridbase <no-reply@example.com>"
//   APP_URL=https://gridbase.example.com      (used for links in emails)

import nodemailer, { type Transporter } from "nodemailer";

export type MailMode = "smtp" | "log";
export type Mail = { to: string; subject: string; text: string };

let transporter: Transporter | null = null;

export function mailMode(): MailMode {
  return process.env.SMTP_URL ? "smtp" : "log";
}

/**
 * The address people use to reach this app. Links in emails always come from
 * configuration, never from the request's Host header (which an attacker controls).
 */
export function appUrl(): string {
  const configured = process.env.APP_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  return `http://${process.env.HOST ?? "localhost"}:${process.env.PORT ?? 3210}`;
}

/** Names and titles go into subjects and bodies; keep them on one line. */
export function oneLine(s: string, max = 120): string {
  return s.replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
}

export async function sendMail(mail: Mail): Promise<void> {
  const subject = oneLine(mail.subject, 200);
  if (mailMode() === "log") {
    console.log(`\n📧 Email (not sent: SMTP_URL isn't set)\nTo: ${mail.to}\nSubject: ${subject}\n\n${mail.text}\n`);
    return;
  }
  transporter ??= nodemailer.createTransport(process.env.SMTP_URL);
  await transporter.sendMail({ from: process.env.MAIL_FROM ?? "gridbase <no-reply@localhost>", to: mail.to, subject, text: mail.text });
}

/** Send without making the caller wait or fail; problems are logged. */
export function sendMailInBackground(mail: Mail): void {
  sendMail(mail).catch((e) => console.error(`Email to ${mail.to} failed:`, e instanceof Error ? e.message : e));
}

// ---- messages ----

export function resetEmail(to: string, name: string, link: string): Mail {
  return {
    to,
    subject: "Reset your gridbase password",
    text: `Hi ${oneLine(name, 60)},\n\nSomeone (hopefully you) asked to reset your gridbase password. Choose a new one here:\n\n${link}\n\nThe link works once and expires in an hour. If you didn't ask for this, you can ignore this email; your password hasn't changed.\n`,
  };
}

export function sharedEmail(to: string, inviter: string, baseName: string, role: string, link: string): Mail {
  return {
    to,
    subject: `${oneLine(inviter, 60)} shared “${oneLine(baseName, 80)}” with you`,
    text: `${oneLine(inviter, 60)} gave you ${role} access to “${oneLine(baseName, 80)}” on gridbase.\n\nOpen it here:\n\n${link}\n`,
  };
}

export function inviteEmail(to: string, inviter: string, baseName: string, role: string, link: string): Mail {
  return {
    to,
    subject: `${oneLine(inviter, 60)} invited you to “${oneLine(baseName, 80)}” on gridbase`,
    text: `${oneLine(inviter, 60)} invited you to “${oneLine(baseName, 80)}” on gridbase as ${/^[aeiou]/.test(role) ? `an ${role}` : `a ${role}`}.\n\nSign up with this email address (${to}), or confirm it if you already have an account, to get access:\n\n${link}\n`,
  };
}

export function verifyEmail(to: string, name: string, link: string): Mail {
  return {
    to,
    subject: "Confirm your email for gridbase",
    text: `Hi ${oneLine(name, 60)},\n\nPlease confirm this is your email address:\n\n${link}\n\nUntil you do, bases that others share with this address stay locked. The link works for a day. If you didn't create a gridbase account, you can ignore this email.\n`,
  };
}
