const { Telegraf, Markup } = require("telegraf");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN environment variable");
  process.exit(1);
}

const API_KEY = process.env.SMS_API_KEY;
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);
if (!API_KEY) { console.error("Missing SMS_API_KEY"); process.exit(1); }
if (!ADMIN_ID) { console.error("Missing ADMIN_ID"); process.exit(1); }

const BASE_URL = "https://sms-x.org/stubs/handler_api.php";

const bot = new Telegraf(BOT_TOKEN);
const sessions = new Map();

function isAdmin(ctx) {
  return ctx.from && ctx.from.id === ADMIN_ID;
}

function adminOnly(handler) {
  return async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery("⛔ Access denied").catch(() => {});
      return;
    }
    return handler(ctx);
  };
}

const SERVICES = {
  cambodia: { label: "🇰🇭 Cambodia", service: "2839", server: "1" },
  thailand: { label: "🇹🇭 Thailand", service: "ot", server: "10" },
};

function mainMenuKeyboard(hasActive) {
  const rows = [
    [
      Markup.button.callback("🇰🇭 Cambodia", "get_cambodia"),
      Markup.button.callback("🇹🇭 Thailand", "get_thailand"),
    ],
    [
      Markup.button.callback("💰 Balance", "balance"),
    ],
  ];
  if (hasActive) {
    rows.push([
      Markup.button.callback("❌ Cancel Number", "cancel"),
    ]);
  }
  return Markup.inlineKeyboard(rows);
}

async function smsApiGet(params) {
  const qs = Object.entries({ api_key: API_KEY, ...params })
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const res = await fetch(`${BASE_URL}?${qs}`);
  return (await res.text()).trim();
}

async function getNumber(serviceKey) {
  const { service, server } = SERVICES[serviceKey];
  const text = await smsApiGet({ action: "getNumber", service, server });
  console.log("getNumber:", text);
  if (text.startsWith("ACCESS_NUMBER")) {
    const parts = text.split(":");
    return { id: parts[1], phone: parts[2] };
  }
  throw new Error(text);
}

async function getStatus(id) {
  const text = await smsApiGet({ action: "getStatus", id });
  console.log(`getStatus [${id}]:`, text);
  return text;
}

async function setStatus(id, status) {
  return smsApiGet({ action: "setStatus", id, status });
}

function startAutoPolling(userId, chatId, waitingMsgId, id, phone, svcLabel) {
  const INTERVAL = 5000;
  const TIMEOUT = 120000;
  const start = Date.now();

  const timer = setInterval(async () => {
    try {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      const status = await getStatus(id);

      if (status.startsWith("STATUS_OK")) {
        clearInterval(timer);
        sessions.delete(userId);
        const code = status.split(":")[1];
        try { await setStatus(id, 6); } catch (_) {}

        await bot.telegram.editMessageText(
          chatId, waitingMsgId, null,
          `✅ Number: \`${phone}\` | ${svcLabel}`,
          { parse_mode: "Markdown" }
        ).catch(() => {});

        await bot.telegram.sendMessage(
          chatId,
          `🎉 *SMS Code Received!*\n\n🔑 Code: \`${code}\`\n📱 Number: \`${phone}\``,
          { parse_mode: "Markdown", ...mainMenuKeyboard(false) }
        ).catch((e) => console.error("sendMessage error:", e.message));
        return;
      }

      if (status === "STATUS_CANCEL") {
        clearInterval(timer);
        sessions.delete(userId);
        await bot.telegram.editMessageText(
          chatId, waitingMsgId, null,
          `❌ Number \`${phone}\` was cancelled.\n\nChoose a service to get a new number:`,
          { parse_mode: "Markdown", ...mainMenuKeyboard(false) }
        ).catch(() => {});
        return;
      }

      if (Date.now() - start >= TIMEOUT) {
        clearInterval(timer);
        sessions.delete(userId);
        await bot.telegram.editMessageText(
          chatId, waitingMsgId, null,
          `⏰ *Timed out!* No SMS in 2 min for \`${phone}\`.\n\nChoose a service to try again:`,
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

  await ctx.answerCbQuery().catch(() => {});

  if (sessions.has(userId)) {
    const { phone } = sessions.get(userId);
    return ctx.editMessageText(
      `⚠️ You already have an active number: \`${phone}\`\nCancel it first before getting a new one.`,
      { parse_mode: "Markdown", ...mainMenuKeyboard(true) }
    ).catch(() => {});
  }

  const svcLabel = SERVICES[serviceKey].label;

  try {
    const { id, phone } = await getNumber(serviceKey);

    const waitMsg = await bot.telegram.sendMessage(
      chatId,
      `⏳ *Waiting for SMS...*\n\n📱 Number: \`${phone}\`\n🌐 Service: ${svcLabel}\n🕐 Elapsed: 0s`,
      { parse_mode: "Markdown", ...mainMenuKeyboard(true) }
    );

    sessions.set(userId, {
      id, phone, serviceKey, chatId,
      waitMsgId: waitMsg.message_id,
      startedAt: Date.now(),
    });

    startAutoPolling(userId, chatId, waitMsg.message_id, id, phone, svcLabel);

  } catch (err) {
    console.error("handleGetNumber error:", err.message);
    await bot.telegram.sendMessage(
      chatId,
      `❌ Failed to get number: ${err.message}`,
      { ...mainMenuKeyboard(false) }
    ).catch(() => {});
  }
}

bot.catch((err, ctx) => {
  console.error(`Bot error for ${ctx.updateType}:`, err.message);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err.message);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

bot.start(async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("⛔ Access denied.").catch(() => {});
  }
  const userId = ctx.from.id;
  await ctx.reply(
    `👋 *Welcome to SMS Number Bot!*\n\nChoose a service to get a phone number:`,
    { parse_mode: "Markdown", ...mainMenuKeyboard(sessions.has(userId)) }
  ).catch(() => {});
});

bot.action("get_cambodia", adminOnly((ctx) => handleGetNumber(ctx, "cambodia")));
bot.action("get_thailand", adminOnly((ctx) => handleGetNumber(ctx, "thailand")));

bot.action("balance", adminOnly(async (ctx) => {
  const userId = ctx.from.id;
  await ctx.answerCbQuery().catch(() => {});
  try {
    const text = await smsApiGet({ action: "getBalance" });
    const amount = text.startsWith("ACCESS_BALANCE") ? text.split(":")[1] : text;
    await ctx.reply(
      `💰 *Account Balance*\n\n💵 \`$${amount}\``,
      { parse_mode: "Markdown", ...mainMenuKeyboard(sessions.has(userId)) }
    ).catch(() => {});
  } catch (err) {
    await ctx.reply(`❌ Failed to get balance: ${err.message}`, {
      ...mainMenuKeyboard(sessions.has(userId)),
    }).catch(() => {});
  }
}));

bot.action("cancel", adminOnly(async (ctx) => {
  const userId = ctx.from.id;
  await ctx.answerCbQuery().catch(() => {});
  const session = sessions.get(userId);

  if (!session) {
    return ctx.editMessageText(
      `ℹ️ You have no active number to cancel.`,
      { ...mainMenuKeyboard(false) }
    ).catch(() => {});
  }

  try { await setStatus(session.id, 8); } catch (_) {}
  sessions.delete(userId);

  await ctx.editMessageText(
    `✅ Number \`${session.phone}\` has been cancelled.\n\nChoose a service to get a new number:`,
    { parse_mode: "Markdown", ...mainMenuKeyboard(false) }
  ).catch(() => {});
}));

async function launch() {
  try {
    await bot.launch({
      allowedUpdates: ["message", "callback_query"],
      dropPendingUpdates: true,
    });
    console.log("🤖 Telegram bot is running (live 100%)...");
  } catch (err) {
    console.error("Launch error:", err.message, "— retrying in 5s...");
    setTimeout(launch, 5000);
  }
}

setInterval(async () => {
  try {
    await bot.telegram.getMe();
  } catch (err) {
    console.error("Heartbeat failed:", err.message);
  }
}, 30000);

launch();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
