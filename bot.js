const { Telegraf, Markup } = require("telegraf");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN environment variable");
  process.exit(1);
}

const API_KEY = "3dd71200967c1afb2a82bf21ee9c138c";
const BASE_URL = "https://sms-x.org/stubs/handler_api.php";

const bot = new Telegraf(BOT_TOKEN);

const sessions = new Map();

const SERVICES = {
  cambodia: { label: "🇰🇭 Cambodia", service: "2839", server: "1" },
  thailand: { label: "🇹🇭 Thailand", service: "ot", server: "10" },
  other: { label: "🌍 Other (OT)", service: "ot", server: "10" },
};

function mainMenuKeyboard(hasActive) {
  const rows = [
    [
      Markup.button.callback("🇰🇭 Cambodia", "get_cambodia"),
      Markup.button.callback("🇹🇭 Thailand", "get_thailand"),
    ],
    [
      Markup.button.callback("🌍 Other (OT)", "get_other"),
    ],
  ];
  if (hasActive) {
    rows.push([
      Markup.button.callback("🔄 Check Status", "check"),
      Markup.button.callback("❌ Cancel Number", "cancel"),
    ]);
  }
  return Markup.inlineKeyboard(rows);
}

async function smsApiGet(params) {
  const url =
    BASE_URL +
    "?" +
    Object.entries({ api_key: API_KEY, ...params })
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
  const res = await fetch(url);
  return (await res.text()).trim();
}

async function getNumber(serviceKey) {
  const { service, server } = SERVICES[serviceKey];
  const text = await smsApiGet({ action: "getNumber", service, server });
  if (text.startsWith("ACCESS_NUMBER")) {
    const parts = text.split(":");
    return { id: parts[1], phone: parts[2] };
  }
  throw new Error(text);
}

async function getStatus(id) {
  return smsApiGet({ action: "getStatus", id });
}

async function setStatus(id, status) {
  return smsApiGet({ action: "setStatus", id, status });
}

async function startPolling(ctx, userId, id, phone, editMsgId) {
  const intervalMs = 5000;
  const timeoutMs = 120000;
  const start = Date.now();

  const timer = setInterval(async () => {
    try {
      const status = await getStatus(id);

      if (status.startsWith("STATUS_OK")) {
        clearInterval(timer);
        sessions.delete(userId);
        await setStatus(id, 6);
        const code = status.split(":")[1];
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          editMsgId,
          null,
          `🎉 *SMS Code Received!*\n\n🔑 Code: \`${code}\`\n📱 Number: \`${phone}\``,
          {
            parse_mode: "Markdown",
            ...mainMenuKeyboard(false),
          }
        );
        return;
      }

      if (status === "STATUS_CANCEL") {
        clearInterval(timer);
        sessions.delete(userId);
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          editMsgId,
          null,
          `❌ Number \`${phone}\` was cancelled.`,
          { parse_mode: "Markdown", ...mainMenuKeyboard(false) }
        );
        return;
      }

      if (Date.now() - start >= timeoutMs) {
        clearInterval(timer);
        sessions.delete(userId);
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          editMsgId,
          null,
          `⏰ Timed out waiting for SMS on \`${phone}\`.\nNo code received within 2 minutes.`,
          { parse_mode: "Markdown", ...mainMenuKeyboard(false) }
        );
      }
    } catch (err) {
      clearInterval(timer);
      sessions.delete(userId);
    }
  }, intervalMs);
}

async function handleGetNumber(ctx, serviceKey) {
  const userId = ctx.from.id;
  await ctx.answerCbQuery();

  if (sessions.has(userId)) {
    const { phone } = sessions.get(userId);
    return ctx.editMessageText(
      `⚠️ You already have an active number: \`${phone}\`\nCancel it first before getting a new one.`,
      { parse_mode: "Markdown", ...mainMenuKeyboard(true) }
    );
  }

  const svcLabel = SERVICES[serviceKey].label;
  await ctx.editMessageText(`⏳ Requesting a ${svcLabel} number...`);

  try {
    const { id, phone } = await getNumber(serviceKey);
    sessions.set(userId, { id, phone, serviceKey, startedAt: Date.now() });

    const sent = await ctx.editMessageText(
      `✅ *Number Ready!*\n\n📱 \`${phone}\`\n🌐 Service: ${svcLabel}\n\n⏳ Waiting for SMS code (up to 2 min)...`,
      { parse_mode: "Markdown", ...mainMenuKeyboard(true) }
    );

    const msgId = sent.message_id ?? ctx.callbackQuery.message.message_id;
    await startPolling(ctx, userId, id, phone, msgId);
  } catch (err) {
    sessions.delete(userId);
    await ctx.editMessageText(`❌ Failed to get number: ${err.message}`, {
      ...mainMenuKeyboard(false),
    });
  }
}

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  await ctx.reply(
    `👋 *Welcome to SMS Number Bot!*\n\nChoose a service to get a phone number:`,
    { parse_mode: "Markdown", ...mainMenuKeyboard(sessions.has(userId)) }
  );
});

bot.action("get_cambodia", (ctx) => handleGetNumber(ctx, "cambodia"));
bot.action("get_thailand", (ctx) => handleGetNumber(ctx, "thailand"));
bot.action("get_other", (ctx) => handleGetNumber(ctx, "other"));

bot.action("check", async (ctx) => {
  const userId = ctx.from.id;
  await ctx.answerCbQuery();
  const session = sessions.get(userId);

  if (!session) {
    return ctx.editMessageText(
      `ℹ️ You have no active number.\nChoose a service below to get one:`,
      { ...mainMenuKeyboard(false) }
    );
  }

  try {
    const status = await getStatus(session.id);
    const elapsed = Math.floor((Date.now() - session.startedAt) / 1000);

    if (status.startsWith("STATUS_OK")) {
      const code = status.split(":")[1];
      sessions.delete(userId);
      await setStatus(session.id, 6);
      return ctx.editMessageText(
        `🎉 *SMS Code Received!*\n\n🔑 Code: \`${code}\`\n📱 Number: \`${session.phone}\``,
        { parse_mode: "Markdown", ...mainMenuKeyboard(false) }
      );
    }

    await ctx.editMessageText(
      `📊 *Status Update*\n\n📱 Number: \`${session.phone}\`\n🕐 Status: ${status}\n⏱ Elapsed: ${elapsed}s\n\n⏳ Still waiting for SMS...`,
      { parse_mode: "Markdown", ...mainMenuKeyboard(true) }
    );
  } catch (err) {
    await ctx.editMessageText(`❌ Error: ${err.message}`, {
      ...mainMenuKeyboard(true),
    });
  }
});

bot.action("cancel", async (ctx) => {
  const userId = ctx.from.id;
  await ctx.answerCbQuery();
  const session = sessions.get(userId);

  if (!session) {
    return ctx.editMessageText(
      `ℹ️ You have no active number to cancel.`,
      { ...mainMenuKeyboard(false) }
    );
  }

  try {
    await setStatus(session.id, 8);
  } catch (_) {}

  sessions.delete(userId);
  await ctx.editMessageText(
    `✅ Number \`${session.phone}\` has been cancelled.\n\nChoose a service to get a new number:`,
    { parse_mode: "Markdown", ...mainMenuKeyboard(false) }
  );
});

bot.launch(() => {
  console.log("🤖 Telegram bot is running with inline keyboards...");
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
