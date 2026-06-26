// Send a one-off test email to whatever ALERT_TO currently is, using the exact
// SMTP settings from .env. Proves the mail path works before you rely on it.
//   npm run test-send
import 'dotenv/config';
import nodemailer from 'nodemailer';

const to = process.env.ALERT_TO;
const failTo = process.env.FAIL_ALERT_TO || to;
if (!to) {
  console.error('ALERT_TO is empty — fill in .env first.');
  process.exit(1);
}
console.log(`[test] case-list  ALERT_TO      = ${to}`);
console.log(`[test] fail-list  FAIL_ALERT_TO = ${failTo}`);

const t = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || '587'),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  tls: { rejectUnauthorized: process.env.SMTP_STRICT_TLS === 'true' },
});

const info = await t.sendMail({
  from: process.env.ALERT_FROM,
  to,
  subject: `${process.env.CASE_NAME || 'casenet-monitor'}: TEST`,
  text: [
    'This is a one-off TEST from casenet-monitor.',
    '',
    'If you can read this, the SMTP path works.',
    `Case alerts (ALERT_TO):    ${to}`,
    `Failure alerts (FAIL_TO):  ${failTo}`,
  ].join('\n'),
});
console.log('[test] sent OK; messageId=', info.messageId, ' accepted=', JSON.stringify(info.accepted), ' rejected=', JSON.stringify(info.rejected));
