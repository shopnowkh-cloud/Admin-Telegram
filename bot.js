const { Telegraf, Markup } = require("telegraf");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) { console.error("Missing TELEGRAM_BOT_TOKEN"); process.exit(1); }

const API_KEY = process.env.SMS_API_KEY;
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);
if (!API_KEY) { console.error("Missing SMS_API_KEY"); process.exit(1); }
if (!ADMIN_ID) { console.error("Missing ADMIN_ID"); process.exit(1); }

const BASE_URL = "https://sms-x.org/stubs/handler_api.php";

const bot = new Telegraf(BOT_TOKEN);
const sessions = new Map();

const BTN = {
  CAMBODIA: "🇰🇭 Cambodia",
  THAILAND: "🇹🇭 Thailand",
  BALANCE:  "💰 Balance",
  CANCEL:   "❌ Cancel Number",
};

const SERVICES = {
  [BTN.CAMBODIA]: { label: BTN.CAMBODIA, service: "2839", server: "1" },
  [BTN.THAILAND]: { label: BTN.THAILAND, service: "ot",   server: "10" },
};

function mainMenu(hasActive) {
  const rows = [
    [BTN.CAMBODIA, BTN.THAILAND],
    [BTN.BALANCE],
  ];
  if (hasActive) rows.push([BTN.CANCEL]);
  return Markup.keyboard(rows).resize();
}

function isAdmin(ctx) {
  return ctx.from && ctx.from.id === ADMIN_ID;
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
  const TIMEOUT  = 120000;
  const start    = Date.now();

  const timer = setInterval(async () => {
    try {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      const status  = await getStatus(id);

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
          { parse_mode: "Markdown", ...mainMenu(false) }
        ).catch((e) => console.error("sendMessage error:", e.message));
        return;
      }

      if (status === "STATUS_CANCEL") {
        clearInterval(timer);
        sessions.delete(userId);
        await bot.telegram.sendMessage(
          chatId,
          `❌ Number \`${phone}\` was cancelled.`,
          { parse_mode: "Markdown", ...mainMenu(false) }
        ).catch(() => {});
        return;
      }

      if (Date.now() - start >= TIMEOUT) {
        clearInterval(timer);
        sessions.delete(userId);
        await bot.telegram.sendMessage(
          chatId,
          `⏰ *Timed out!* No SMS in 2 min for \`${phone}\`.`,
          { parse_mode: "Markdown", ...mainMenu(false) }
        ).catch(() => {});
        return;
      }

      await bot.telegram.editMessageText(
        chatId, waitingMsgId, null,
        `⏳ *Waiting for SMS...*\n\n📱 Number: \`${phone}\`\n🌐 Service: ${svcLabel}\n🕐 Elapsed: ${elapsed}s`,
        { parse_mode: "Markdown" }
      ).catch(() => {});

    } catch (err) {
      console.error("Poll error:", err.message);
    }
  }, INTERVAL);

  return timer;
}

async function handleGetNumber(ctx, serviceKey) {
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;

  if (sessions.has(userId)) {
    const { phone } = sessions.get(userId);
    return ctx.reply(
      `⚠️ You already have an active number: \`${phone}\`\nTap ❌ Cancel Number first.`,
      { parse_mode: "Markdown", ...mainMenu(true) }
    ).catch(() => {});
  }

  const svcLabel = SERVICES[serviceKey].label;
  await ctx.reply(`⏳ Requesting a ${svcLabel} number...`, mainMenu(false)).catch(() => {});

  try {
    const { id, phone } = await getNumber(serviceKey);

    const waitMsg = await bot.telegram.sendMessage(
      chatId,
      `⏳ *Waiting for SMS...*\n\n📱 Number: \`${phone}\`\n🌐 Service: ${svcLabel}\n🕐 Elapsed: 0s`,
      { parse_mode: "Markdown" }
    );

    sessions.set(userId, {
      id, phone, serviceKey, chatId,
      waitMsgId: waitMsg.message_id,
      startedAt: Date.now(),
    });

    await ctx.reply(
      `✅ *Number Ready!*\n📱 \`${phone}\`\n\nAuto-checking SMS every 5s...`,
      { parse_mode: "Markdown", ...mainMenu(true) }
    ).catch(() => {});

    startAutoPolling(userId, chatId, waitMsg.message_id, id, phone, svcLabel);

  } catch (err) {
    console.error("handleGetNumber error:", err.message);
    await ctx.reply(`❌ Failed to get number: ${err.message}`, mainMenu(false)).catch(() => {});
  }
}

bot.catch((err, ctx) => {
  console.error(`Bot error [${ctx.updateType}]:`, err.message);
});

process.on("uncaughtException",  (err)    => console.error("Uncaught Exception:", err.message));
process.on("unhandledRejection", (reason) => console.error("Unhandled Rejection:", reason));

bot.start(async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.").catch(() => {});
  await ctx.reply(
    `👋 *Welcome to SMS Number Bot!*\n\nChoose a service:`,
    { parse_mode: "Markdown", ...mainMenu(sessions.has(ctx.from.id)) }
  ).catch(() => {});
});

bot.hears(BTN.CAMBODIA, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await handleGetNumber(ctx, BTN.CAMBODIA);
});

bot.hears(BTN.THAILAND, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await handleGetNumber(ctx, BTN.THAILAND);
});

bot.hears(BTN.BALANCE, async (ctx) => {
  if (!isAdmin(ctx)) return;
  try {
    const text   = await smsApiGet({ action: "getBalance" });
    const amount = text.startsWith("ACCESS_BALANCE") ? text.split(":")[1] : text;
    await ctx.reply(
      `💰 *Account Balance*\n\n💵 \`$${amount}\``,
      { parse_mode: "Markdown", ...mainMenu(sessions.has(ctx.from.id)) }
    ).catch(() => {});
  } catch (err) {
    await ctx.reply(`❌ Failed to get balance: ${err.message}`, mainMenu(sessions.has(ctx.from.id))).catch(() => {});
  }
});

bot.hears(BTN.CANCEL, async (ctx) => {
  if (!isAdmin(ctx)) return;
  const userId  = ctx.from.id;
  const session = sessions.get(userId);

  if (!session) {
    return ctx.reply(`ℹ️ You have no active number to cancel.`, mainMenu(false)).catch(() => {});
  }

  try { await setStatus(session.id, 8); } catch (_) {}
  sessions.delete(userId);

  await ctx.reply(
    `✅ Number \`${session.phone}\` has been cancelled.`,
    { parse_mode: "Markdown", ...mainMenu(false) }
  ).catch(() => {});
});

bot.on("text", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.", mainMenu(false)).catch(() => {});
  const userId = ctx.from.id;
  await ctx.reply(
    `Choose a service:`,
    { ...mainMenu(sessions.has(userId)) }
  ).catch(() => {});
});

async function launch() {
  try {
    await bot.launch({
      allowedUpdates: ["message"],
      dropPendingUpdates: true,
    });
    console.log("🤖 Telegram bot is running with reply keyboard (live 100%)...");
  } catch (err) {
    console.error("Launch error:", err.message, "— retrying in 5s...");
    setTimeout(launch, 5000);
  }
}

setInterval(async () => {
  try { await bot.telegram.getMe(); }
  catch (err) { console.error("Heartbeat failed:", err.message); }
}, 30000);

launch();

process.once("SIGINT",  () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
