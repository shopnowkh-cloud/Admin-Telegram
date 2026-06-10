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
  other:    { label: "🌍 Other (OT)", service: "ot", server: "10" },
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
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
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

function startAutoPolling(userId, chatId, waitingMsgId, id, phone, svcLabel) {
  const INTERVAL = 5000;
  const TIMEOUT = 120000;
  const start = Date.now();
  let elapsed = 0;

  const timer = setInterval(async () => {
    try {
      elapsed = Math.floor((Date.now() - start) / 1000);
      const status = await getStatus(id);

      if (status.startsWith("STATUS_OK")) {
        clearInterval(timer);
        sessions.delete(userId);
        const code = status.split(":")[1];
        try { await setStatus(id, 6); } catch (_) {}

        await bot.telegram.editMessageText(
          chatId, waitingMsgId, null,
          `✅ *Number:* \`${phone}\`\n🌐 Service: ${svcLabel}`,
          { parse_mode: "Markdown" }
        ).catch(() => {});

        await bot.telegram.sendMessage(
          chatId,
          `🎉 *SMS Code Received!*\n\n🔑 Code: \`${code}\`\n📱 Number: \`${phone}\``,
          { parse_mode: "Markdown", ...mainMenuKeyboard(false) }
        );
        return;
      }

      if (status === "STATUS_CANCEL") {
        clearInterval(timer);
        sessions.delete(userId);
        await bot.telegram.editMessageText(
          chatId, waitingMsgId, null,
          `❌ Number \`${phone}\` was cancelled.`,
          { parse_mode: "Markdown", ...mainMenuKeyboard(false) }
        ).catch(() => {});
        return;
      }

      if (Date.now() - start >= TIMEOUT) {
        clearInterval(timer);
        sessions.delete(userId);
        await bot.telegram.editMessageText(
          chatId, waitingMsgId, null,
          `⏰ *Timed out!*\n\nNo SMS received within 2 minutes for \`${phone}\`.\n\nChoose a service to try again:`,
          { parse_mode: "Markdown", ...mainMenuKeyboard(false) }
        ).catch(() => {});
        return;
      }

      await bot.telegram.editMessageText(
        chatId, waitingMsgId, null,
        `⏳ *Waiting for SMS...*\n\n📱 Number: \`${phone}\`\n🌐 Service: ${svcLabel}\n🕐 Elapsed: ${elapsed}s`,
        { parse_mode: "Markdown", ...mainMenuKeyboard(true) }
      ).catch(() => {});

    } catch (err) {
      console.error("Poll error:", err.message);
    }
  }, INTERVAL);

  return timer;
}

async function handleGetNumber(ctx, serviceKey) {
  const userId = ctx.from.id;
  const chatId = ctx.callbackQuery.message.chat.id;
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

    const waitMsg = await bot.telegram.sendMessage(
      chatId,
      `⏳ *Waiting for SMS...*\n\n📱 Number: \`${phone}\`\n🌐 Service: ${svcLabel}\n🕐 Elapsed: 0s`,
      { parse_mode: "Markdown", ...mainMenuKeyboard(true) }
    );

    await ctx.editMessageText(
      `✅ *Number Ready!*\n\n📱 \`${phone}\`\n🌐 Service: ${svcLabel}`,
      { parse_mode: "Markdown" }
    ).catch(() => {});

    sessions.set(userId, { id, phone, serviceKey, chatId, waitMsgId: waitMsg.message_id, startedAt: Date.now() });

    startAutoPolling(userId, chatId, waitMsg.message_id, id, phone, svcLabel);

  } catch (err) {
    sessions.delete(userId);
    await bot.telegram.sendMessage(
      chatId,
      `❌ Failed to get number: ${err.message}`,
      { ...mainMenuKeyboard(false) }
    );
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
bot.action("get_other",    (ctx) => handleGetNumber(ctx, "other"));

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
      try { await setStatus(session.id, 6); } catch (_) {}

      await ctx.editMessageText(
        `✅ *Number:* \`${session.phone}\``,
        { parse_mode: "Markdown" }
      ).catch(() => {});

      return ctx.reply(
        `🎉 *SMS Code Received!*\n\n🔑 Code: \`${code}\`\n📱 Number: \`${session.phone}\``,
        { parse_mode: "Markdown", ...mainMenuKeyboard(false) }
      );
    }

    await ctx.editMessageText(
      `⏳ *Waiting for SMS...*\n\n📱 Number: \`${session.phone}\`\n🌐 Service: ${SERVICES[session.serviceKey].label}\n🕐 Elapsed: ${elapsed}s`,
      { parse_mode: "Markdown", ...mainMenuKeyboard(true) }
    );
  } catch (err) {
    await ctx.reply(`❌ Error: ${err.message}`, { ...mainMenuKeyboard(true) });
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

  try { await setStatus(session.id, 8); } catch (_) {}
  sessions.delete(userId);

  await ctx.editMessageText(
    `✅ Number \`${session.phone}\` has been cancelled.\n\nChoose a service to get a new number:`,
    { parse_mode: "Markdown", ...mainMenuKeyboard(false) }
  );
});

bot.launch(() => {
  console.log("🤖 Telegram bot is running with auto-poll...");
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
