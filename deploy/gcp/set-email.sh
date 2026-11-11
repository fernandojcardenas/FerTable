#!/bin/bash
# Lets FerTable send email (password resets, invites, mentions) through a Gmail account.
# Run on the server as root:  sudo bash set-email.sh
# It asks for the Gmail address and its 16-letter App Password (hidden as you type),
# sends a test email to that address, and only if it arrives saves them in
# /etc/fertable/fertable.env (readable only by root and FerTable) and restarts FerTable.
set -euo pipefail
ENV=/etc/fertable/fertable.env
APP=/opt/fertable

echo "Email for FerTable (Gmail)"
echo "Use a Gmail address with 2-Step Verification on, and an App Password from"
echo "myaccount.google.com/apppasswords (not the account's normal password)."
echo
read -r -p "Gmail address: " ADDRESS
ADDRESS="$(echo "$ADDRESS" | tr -d '[:space:]')"
if ! [[ "$ADDRESS" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then echo "That doesn't look like an email address."; exit 1; fi
read -r -s -p "App Password (hidden): " PASS; echo
PASS="$(echo "$PASS" | tr -d '[:space:]')"
if ! [[ "$PASS" =~ ^[A-Za-z]{16}$ ]]; then echo "An App Password is 16 letters (spaces are fine). Nothing was changed."; exit 1; fi
read -r -p "Sender name shown in emails [FerTable]: " NAME
NAME="${NAME:-FerTable}"
NAME="$(echo "$NAME" | tr -d '"<>\n')"

USER_ENC="${ADDRESS//@/%40}"
SMTP_URL="smtps://${USER_ENC}:${PASS}@smtp.gmail.com:465"

echo "Sending a test email to $ADDRESS…"
if sudo -u fertable env SMTP_URL="$SMTP_URL" FROM="$NAME <$ADDRESS>" TO="$ADDRESS" node -e '
  const nodemailer = require(process.argv[1]);
  nodemailer.createTransport(process.env.SMTP_URL).sendMail({
    from: process.env.FROM, to: process.env.TO,
    subject: "FerTable can send email",
    text: "This is a test from your FerTable server. Password resets, invites and mention alerts will come from this address.",
  }).then(() => { console.log("Test email sent."); }, (e) => { console.error("Sending failed: " + e.message); process.exit(1); });
' "$APP/node_modules/nodemailer"; then
  # Replace any earlier email settings, keep everything else.
  TMP="$(mktemp)"
  grep -vE '^(SMTP_URL|MAIL_FROM)=' "$ENV" > "$TMP" || true
  {
    cat "$TMP"
    echo "SMTP_URL=$SMTP_URL"
    echo "MAIL_FROM=\"$NAME <$ADDRESS>\""
  } > "$ENV"
  rm -f "$TMP"
  chown root:fertable "$ENV" && chmod 0640 "$ENV"
  systemctl restart fertable
  echo "Saved. FerTable restarted and now sends email from $ADDRESS."
else
  echo "Nothing was saved. Check the address and App Password, then run this again."
  exit 1
fi
