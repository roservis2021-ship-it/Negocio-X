import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Envío de emails.
// - Con RESEND_API_KEY: se envían de verdad a través de Resend (https://resend.com).
// - Sin ella: se guardan como archivos .html en `outboxDir` para revisarlos en local.
// Los adjuntos con `cid` se muestran dentro del email (imágenes de los QR).
export function createMailer({ apiKey, from, outboxDir }) {
  if (apiKey) {
    return {
      mode: 'resend',
      async send({ to, subject, html, text, attachments = [] }) {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from,
            to: [to],
            subject,
            html,
            text,
            attachments: attachments.map((a) => ({
              filename: a.filename,
              content: a.content.toString('base64'),
              content_type: a.contentType,
              content_id: a.cid,
            })),
          }),
        });
        if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
      },
    };
  }

  return {
    mode: 'outbox',
    async send({ to, subject, html, attachments = [] }) {
      await mkdir(outboxDir, { recursive: true });
      let body = html;
      for (const a of attachments) {
        body = body.replaceAll(`cid:${a.cid}`, `data:${a.contentType};base64,${a.content.toString('base64')}`);
      }
      const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
      const header = `<div style="font:13px monospace;background:#fff3cd;color:#333;padding:10px 14px;border-bottom:1px solid #e0c36a">
        EMAIL NO ENVIADO (modo local) · Para: ${esc(to)} · Asunto: ${esc(subject)}</div>`;
      const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').slice(0, 40);
      const file = join(outboxDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${slug(to)}-${slug(subject)}.html`);
      await writeFile(file, body.replace(/<body([^>]*)>/, `<body$1>${header}`));
      console.log(`Email guardado en ${file}`);
    },
  };
}
