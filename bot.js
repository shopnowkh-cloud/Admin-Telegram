const { Telegraf, Markup } = require("telegraf");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) { console.error("Missing TELEGRAM_BOT_TOKEN"); process.exit(1); }

const API_KEY  = process.env.SMS_API_KEY;
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);
if (!API_KEY)   { console.error("Missing SMS_API_KEY"); process.exit(1); }
if (!ADMIN_ID)  { console.error("Missing ADMIN_ID");   process.exit(1); }

const BASE_URL = "https://sms-x.org/stubs/handler_api.php";

const bot      = new Telegraf(BOT_TOKEN);
const sessions = new Map();
let   history  = [];

const BTN = {
  CAMBODIA: "🇰🇭 Cambodia",
  THAILAND: "🇹🇭 Thailand",
  VIETNAM:  "🇻🇳 Vietnam",
  BALANCE:  "💰 Balance",
  HISTORY:  "📋 History",
};

const SERVICES = {
  [BTN.CAMBODIA]: { label: BTN.CAMBODIA, service: "2839", server: "1"  },
  [BTN.THAILAND]: { label: BTN.THAILAND, service: "ot",   server: "10" },
  [BTN.VIETNAM]:  { label: BTN.VIETNAM,  service: "2839", server: "32" },
};

function mainMenu() {
  return Markup.keyboard([
    [BTN.CAMBODIA, BTN.THAILAND, BTN.VIETNAM],
    [BTN.BALANCE,  BTN.HISTORY],
  ]).resize();
}

function isAdmin(ctx) {
  return ctx.from && ctx.from.id === ADMIN_ID;
}

function addHistoryEntry(entry) {
  history.unshift(entry);
  if (history.length > 100) history.splice(100);
}

function updateHistoryEntry(id, updates) {
  const idx = history.findIndex((e) => e.id === id);
  if (idx !== -1) history[idx] = { ...history[idx], ...updates };
}

function formatDate(ts) {
  return new Date(ts).toLocaleString("en-GB", {
    timeZone: "Asia/Phnom_Penh",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function stripCountryCode(phone) {
  if (phone.startsWith("855")) return phone.slice(3);
  if (phone.startsWith("66"))  return phone.slice(2);
  if (phone.startsWith("84"))  return phone.slice(2);
  return phone;
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
  const INTERVAL  = 5000;
  const DOTS      = ["🔄", "⏳", "🔄", "⌛"];
  let   tickCount = 0;

  const timer = setInterval(async () => {
    try {
      const status = await getStatus(id);
      tickCount++;

      if (status.startsWith("STATUS_OK")) {
        clearInterval(timer);
        sessions.delete(userId);
        const code        = status.slice("STATUS_OK:".length);
        const displayPhone = stripCountryCode(phone);
        try { await setStatus(id, 6); } catch (_) {}

        updateHistoryEntry(id, { code, status: "✅ Received", completedAt: Date.now() });

        await bot.telegram.editMessageText(
          chatId, waitingMsgId, null,
          `✅ Number: \`${displayPhone}\` | ${svcLabel}`,
          { parse_mode: "Markdown" }
        ).catch(() => {});

        await bot.telegram.sendMessage(
          chatId,
          `🎉 *SMS Code Received!*\n\n${code}`,
          { parse_mode: "Markdown", ...mainMenu() }
        ).catch((e) => console.error("sendMessage error:", e.message));
        return;
      }

      if (status === "STATUS_CANCEL") {
        clearInterval(timer);
        sessions.delete(userId);
        updateHistoryEntry(id, { status: "❌ Cancelled", completedAt: Date.now() });
        await bot.telegram.sendMessage(
          chatId,
          `❌ Number \`${stripCountryCode(phone)}\` was cancelled.`,
          { parse_mode: "Markdown", ...mainMenu() }
        ).catch(() => {});
        return;
      }

      const spin = DOTS[tickCount % DOTS.length];
      const cancelBtn = Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", `cancel_${id}`)]]);
      await bot.telegram.editMessageText(
        chatId, waitingMsgId, null,
        `${spin} *Waiting for SMS...*\n\n📱 Number: \`${stripCountryCode(phone)}\`\n🌐 Service: ${svcLabel}`,
        { parse_mode: "Markdown", ...cancelBtn }
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

  const svcLabel = SERVICES[serviceKey].label;

  try {
    const { id, phone } = await getNumber(serviceKey);
    const purchasedAt   = Date.now();

    addHistoryEntry({ id, phone, service: svcLabel, purchasedAt, status: "⏳ Waiting", code: null });

    const cancelBtn = Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", `cancel_${id}`)]]);
    const waitMsg = await bot.telegram.sendMessage(
      chatId,
      `⏳ *Waiting for SMS...*\n\n📱 Number: \`${stripCountryCode(phone)}\`\n🌐 Service: ${svcLabel}`,
      { parse_mode: "Markdown", ...mainMenu(), ...cancelBtn }
    );

    sessions.set(userId, { id, phone, serviceKey, chatId, waitMsgId: waitMsg.message_id, startedAt: purchasedAt });

    startAutoPolling(userId, chatId, waitMsg.message_id, id, phone, svcLabel);

  } catch (err) {
    console.error("handleGetNumber error:", err.message);
    await ctx.reply(`❌ Failed to get number: ${err.message}`, mainMenu()).catch(() => {});
  }
}

bot.catch((err, ctx) => {
  console.error(`Bot error [${ctx.updateType}]:`, err.message);
});

process.on("uncaughtException",  (err)    => console.error("Uncaught Exception:", err.message));
process.on("unhandledRejection", (reason) => console.error("Unhandled Rejection:", reason));

bot.start(async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.").catch(() => {});
  const userId = ctx.from.id;
  if (sessions.has(userId)) {
    const session = sessions.get(userId);
    try { await setStatus(session.id, 8); } catch (_) {}
    updateHistoryEntry(session.id, { status: "❌ Cancelled", completedAt: Date.now() });
    sessions.delete(userId);
  }
  await ctx.reply(
    `👋 *Welcome to SMS Number Bot!*\n\nChoose a service:`,
    { parse_mode: "Markdown", ...mainMenu() }
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

bot.hears(BTN.VIETNAM, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await handleGetNumber(ctx, BTN.VIETNAM);
});

bot.hears(BTN.BALANCE, async (ctx) => {
  if (!isAdmin(ctx)) return;
  try {
    const text   = await smsApiGet({ action: "getBalance" });
    const amount = text.startsWith("ACCESS_BALANCE") ? text.split(":")[1] : text;
    await ctx.reply(
      `💰 *Account Balance*\n\n💵 \`$${amount}\``,
      { parse_mode: "Markdown", ...mainMenu() }
    ).catch(() => {});
  } catch (err) {
    await ctx.reply(`❌ Failed to get balance: ${err.message}`, mainMenu()).catch(() => {});
  }
});

bot.hears(BTN.HISTORY, async (ctx) => {
  if (!isAdmin(ctx)) return;

  if (history.length === 0) {
    return ctx.reply("📋 No purchased numbers yet.", mainMenu()).catch(() => {});
  }

  const filtered = history.filter((e) => e.status === "⏳ Waiting");

  if (filtered.length === 0) {
    return ctx.reply("📋 No purchased numbers yet.", mainMenu()).catch(() => {});
  }

  const entries = filtered.slice(0, 20);
  const lines = entries.map((e, i) => {
    const flag = e.service.includes("Cambodia") ? "🇰🇭" : e.service.includes("Thailand") ? "🇹🇭" : "🇻🇳";
    const status = e.code ? `🔑 ${e.code}` : e.status;
    return `${i + 1}. ${flag} \`${e.phone}\`\n    ${status}`;
  });

  await ctx.reply(
    `📋 *Purchased Numbers* (${entries.length})\n\n` + lines.join("\n\n"),
    { parse_mode: "Markdown", ...mainMenu() }
  ).catch(() => {});
});

bot.action(/^cancel_(.+)$/, async (ctx) => {
  const id      = ctx.match[1];
  const userId  = ctx.from.id;
  const session = sessions.get(userId);

  if (session && session.id === id) {
    try { await setStatus(id, 8); } catch (_) {}
    updateHistoryEntry(id, { status: "❌ Cancelled", completedAt: Date.now() });
    sessions.delete(userId);
  }

  await ctx.answerCbQuery("Cancelled.").catch(() => {});
  await ctx.editMessageText(
    `❌ *Cancelled*\n\n📱 Number: \`${stripCountryCode(session?.phone || "")}\``,
    { parse_mode: "Markdown" }
  ).catch(() => {});
});

bot.on("text", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.", mainMenu()).catch(() => {});
  await ctx.reply("Choose a service:", mainMenu()).catch(() => {});
});

async function launch() {
  try {
    await bot.launch({
      allowedUpdates: ["message", "callback_query"],
      dropPendingUpdates: true,
    });
    console.log("🤖 Telegram bot running (live 100%)...");
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
