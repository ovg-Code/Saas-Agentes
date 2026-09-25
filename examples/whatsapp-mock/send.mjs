// Envía a la plataforma un webhook ENTRANTE de WhatsApp con el formato y la firma reales de Meta.
// Uso: node send.mjs <wa_id> "<texto>" <url_webhook> <app_secret> [phone_number_id] [wamid]
import { createHmac, randomUUID } from "node:crypto";

const [waId, text, url, appSecret, phoneNumberId = "555000111", wamid = `wamid.in.${randomUUID()}`] = process.argv.slice(2);
if (!waId || !text || !url || !appSecret) {
  console.error('uso: node send.mjs <wa_id> "<texto>" <url_webhook> <app_secret> [phone_number_id] [wamid]');
  process.exit(1);
}
const body = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [{
    id: "WABA_ID",
    changes: [{
      field: "messages",
      value: {
        messaging_product: "whatsapp",
        metadata: { display_phone_number: "34600000000", phone_number_id: phoneNumberId },
        contacts: [{ profile: { name: "Cliente" }, wa_id: waId }],
        messages: [{ from: waId, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
      },
    }],
  }],
});
const signature = `sha256=${createHmac("sha256", appSecret).update(body).digest("hex")}`;
const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature }, body });
console.log(r.status, await r.text());
if (!r.ok) process.exit(1);
