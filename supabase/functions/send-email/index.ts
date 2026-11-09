const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-session",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type SendEmailPayload = {
  to?: string[];
  subject?: string;
  message?: string;
  text?: string;
  brandLogoUrl?: string;
  campaignImageUrl?: string;
  storeName?: string;
  storeLocation?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  try {
    const adminToken = req.headers.get("x-admin-session") || "";
    const projectUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!/^[a-f0-9]{64}$/i.test(adminToken) || !projectUrl || !serviceKey) return json({ error: "Admin sign-in is required." }, 401);
    const verification = await fetch(`${projectUrl}/rest/v1/rpc/commerce_validate_admin_token`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input_token: adminToken }),
      signal: AbortSignal.timeout(15000),
    });
    if (!verification.ok || await verification.json() !== true) return json({ error: "Your admin session has expired." }, 401);
    const readiness = await fetch(`${projectUrl}/rest/v1/rpc/commerce_get_settings`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input_public: false }),
      signal: AbortSignal.timeout(15000),
    });
    if (!readiness.ok || !(await readiness.json())?.admin_password_ready) return json({ error: "Change the administrator password before sending campaigns." }, 403);
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const fromEmailSecret = Deno.env.get("RESEND_FROM_EMAIL");

    if (!resendApiKey || !fromEmailSecret) {
      return json({ error: "Missing RESEND_API_KEY or RESEND_FROM_EMAIL secret." }, 500);
    }

    const fromEmail = formatSenderAddress(fromEmailSecret);

    const payload = await req.json() as SendEmailPayload;
    const requestedRecipients = Array.isArray(payload.to)
      ? payload.to.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const subject = String(payload.subject || "").trim();
    const message = String(payload.message || payload.text || "").trim();
    const senderAddress = extractEmailAddress(fromEmail).toLowerCase();
    const campaignInbox = String(Deno.env.get("RESEND_CAMPAIGN_TO") || "").trim();
    const campaignInboxAddress = campaignInbox
      ? extractEmailAddress(campaignInbox).toLowerCase()
      : "";
    const excludedAddresses = new Set([senderAddress, campaignInboxAddress].filter(Boolean));
    const seenRecipientAddresses = new Set<string>();
    const recipients = requestedRecipients.filter((recipient) => {
      const recipientAddress = extractEmailAddress(recipient).toLowerCase();
      if (!recipientAddress || excludedAddresses.has(recipientAddress) || seenRecipientAddresses.has(recipientAddress)) {
        return false;
      }
      seenRecipientAddresses.add(recipientAddress);
      return true;
    });

    if (!requestedRecipients.length) {
      return json({ error: "At least one recipient is required." }, 400);
    }
    if (!recipients.length) {
      return json({ error: "No customer recipients remain after removing the sender address." }, 400);
    }
    if (recipients.length > 100) {
      return json({ error: "Campaign sends are limited to 100 recipients." }, 400);
    }
    if (!subject) {
      return json({ error: "Email subject is required." }, 400);
    }
    if (!message) {
      return json({ error: "Email message is required." }, 400);
    }

    const storeName = String(payload.storeName || "Anurag Apparel").trim();
    const storeLocation = String(payload.storeLocation || "Hazaribagh, Jharkhand").trim();
    const brandLogoUrl = safeImageUrl(payload.brandLogoUrl);
    const campaignImageUrl = safeImageUrl(payload.campaignImageUrl);
    const text = buildPlainText({ storeName, storeLocation, subject, message });
    const html = buildCampaignHtml({
      storeName,
      storeLocation,
      subject,
      message,
      brandLogoUrl,
      campaignImageUrl,
    });

    const resendResponse = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(recipients.map((recipient) => ({
        from: fromEmail,
        to: [recipient],
        subject,
        html,
        text,
      }))),
    });

    const result = await resendResponse.json().catch(() => ({}));

    if (!resendResponse.ok) {
      return json({
        error: result?.message || result?.error || "Resend failed to send the campaign.",
        details: result,
      }, resendResponse.status);
    }

    const ids = Array.isArray(result?.data)
      ? result.data.map((item: { id?: string }) => item?.id).filter(Boolean)
      : [];
    return json({ id: ids[0] || null, ids, count: recipients.length });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to send campaign." }, 500);
  }
});

function buildCampaignHtml(input: {
  storeName: string;
  storeLocation: string;
  subject: string;
  message: string;
  brandLogoUrl: string;
  campaignImageUrl: string;
}) {
  const paragraphs = input.message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p class="email-copy" style="margin:0 0 16px;color:#3c342b;font-size:16px;line-height:1.72;">${escapeHtml(line)}</p>`)
    .join("");

  const logoBlock = input.brandLogoUrl
    ? `<img src="${escapeAttribute(input.brandLogoUrl)}" width="132" alt="${escapeAttribute(input.storeName)}" style="display:block;max-width:132px;height:auto;margin:0 auto 18px;object-fit:contain;">`
    : `<div style="font-size:13px;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:#8a6018;margin-bottom:18px;">${escapeHtml(input.storeName)}</div>`;

  const imageBlock = input.campaignImageUrl
    ? `<tr>
        <td class="email-image-cell" align="center" style="padding:0 32px 28px;background:#fffdf9;">
          <img src="${escapeAttribute(input.campaignImageUrl)}" alt="" width="420" style="display:block;width:100%;max-width:420px;height:auto;border-radius:14px;border:1px solid #e7e1d8;">
        </td>
      </tr>`
    : "";

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light only">
    <meta name="supported-color-schemes" content="light">
    <title>${escapeHtml(input.subject)}</title>
    <style>
      :root {
        color-scheme: light only;
        supported-color-schemes: light;
      }

      body,
      table,
      td,
      p,
      div,
      h1 {
        color-scheme: light only;
      }

      @media (prefers-color-scheme: dark) {
        body,
        .email-shell {
          background: #f3eee5 !important;
        }

        .email-card,
        .email-body,
        .email-image-cell,
        .email-footer {
          background: #fffdf9 !important;
        }

        .email-header {
          background: #fbfaf7 !important;
        }

        .email-title {
          color: #171717 !important;
        }

        .email-copy {
          color: #3c342b !important;
        }

        .email-muted {
          color: #6f665b !important;
        }

        .email-kicker {
          color: #b7872d !important;
        }

        .email-divider {
          background: #e7e1d8 !important;
        }
      }

      [data-ogsc] body,
      [data-ogsc] .email-shell {
        background: #f3eee5 !important;
      }

      [data-ogsc] .email-card,
      [data-ogsc] .email-body,
      [data-ogsc] .email-image-cell,
      [data-ogsc] .email-footer {
        background: #fffdf9 !important;
      }

      [data-ogsc] .email-header {
        background: #fbfaf7 !important;
      }

      [data-ogsc] .email-title {
        color: #171717 !important;
      }

      [data-ogsc] .email-copy {
        color: #3c342b !important;
      }

      [data-ogsc] .email-muted {
        color: #6f665b !important;
      }

      [data-ogsc] .email-kicker {
        color: #b7872d !important;
      }

      [data-ogsc] .email-divider {
        background: #e7e1d8 !important;
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:#f3eee5;color:#171717;font-family:Arial,Helvetica,sans-serif;">
    <table class="email-shell" role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3eee5;margin:0;padding:28px 12px;color:#171717;">
      <tr>
        <td align="center">
          <table class="email-card" role="presentation" width="640" cellspacing="0" cellpadding="0" style="width:100%;max-width:640px;background:#fffdf9;color:#171717;border:1px solid #e7e1d8;border-radius:18px;overflow:hidden;">
            <tr>
              <td class="email-header" align="center" style="padding:34px 32px 20px;background:#fbfaf7;color:#171717;border-bottom:1px solid #eee7dc;">
                ${logoBlock}
                <div class="email-kicker" style="font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#b7872d;">Hi from ${escapeHtml(input.storeName)}!</div>
                <h1 class="email-title" style="margin:12px 0 0;color:#171717;font-size:30px;line-height:1.2;font-weight:700;">${escapeHtml(input.subject)}</h1>
              </td>
            </tr>
            ${imageBlock}
            <tr>
              <td class="email-body" style="padding:30px 32px 10px;background:#fffdf9;color:#3c342b;">
                ${paragraphs}
              </td>
            </tr>
            <tr>
              <td class="email-footer" style="padding:18px 32px 34px;background:#fffdf9;">
                <div class="email-divider" style="height:1px;background:#e7e1d8;margin-bottom:22px;"></div>
                <p class="email-muted" style="margin:0;color:#6f665b;font-size:13px;line-height:1.6;">
                  ${escapeHtml(input.storeName)}<br>
                  ${escapeHtml(input.storeLocation)}
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function buildPlainText(input: {
  storeName: string;
  storeLocation: string;
  subject: string;
  message: string;
}) {
  return `${input.subject}\n\n${input.message}\n\n${input.storeName}\n${input.storeLocation}`;
}

function safeImageUrl(value: unknown) {
  const url = String(value || "").trim();
  if (!url) return "";

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function extractEmailAddress(value: string) {
  const match = value.match(/<([^>]+)>/);
  return (match?.[1] || value).trim();
}

function formatSenderAddress(value: string) {
  const email = extractEmailAddress(value);
  return `Anurag Apparel <${email}>`;
}

function escapeHtml(value: unknown) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: unknown) {
  return escapeHtml(value);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}
