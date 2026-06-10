const { Telegraf } = require("telegraf");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN environment variable");
  process.exit(1);
}

const API_KEY = "3dd71200967c1afb2a82bf21ee9c138c";
const BASE_URL = "https://sms-x.org/stubs/handler_api.php";

const bot = new Telegraf(BOT_TOKEN);

const sessions = new Map();

async function getNumber() {
  const url = `${BASE_URL}?api_key=${API_KEY}&action=getNumber&service=ot&server=10`;
  const res = await fetch(url);
  const text = (await res.text()).trim();
  if (text.startsWith("ACCESS_NUMBER")) {
    const parts = text.split(":");
    return { id: parts[1], phone: parts[2] };
  }
  throw new Error(text);
}

async function getStatus(id) {
  const url = `${BASE_URL}?api_key=${API_KEY}&action=getStatus&id=${id}`;
  const res = await fetch(url);
  return (await res.text()).trim();
}

async function setStatus(id, status) {
  const url = `${BASE_URL}?api_key=${API_KEY}&action=setStatus&id=${id}&status=${status}`;
  const res = await fetch(url);
  return (await res.text()).trim();
}

async function pollForSms(ctx, id, intervalMs = 5000, timeoutMs = 120000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(async () => {
      try {
        const status = await getStatus(id);
        if (status.startsWith("STATUS_OK")) {
          clearInterval(timer);
          const code = status.split(":")[1];
          resolve(code);
        } else if (status === "STATUS_CANCEL") {
          clearInterval(timer);
          reject(new Error("Number was cancelled"));
        } else if (Date.now() - start >= timeoutMs) {
          clearInterval(timer);
          reject(new Error("Timed out waiting for SMS (2 min)"));
        }
      } catch (err) {
        clearInterval(timer);
        reject(err);
      }
    }, intervalMs);
  });
}

bot.start((ctx) => {
  ctx.reply(
    `👋 Welcome to the SMS Number Bot!\n\n` +
      `Commands:\n` +
      `📱 /get\\_number — Get a new phone number\n` +
      `🔄 /check — Check status of your active number\n` +
      `❌ /cancel — Cancel your active number\n` +
      `ℹ️ /help — Show this message`,
    { parse_mode: "Markdown" }
  );
});

bot.help((ctx) => {
  ctx.reply(
    `Commands:\n` +
      `📱 /get\\_number — Get a new phone number\n` +
      `🔄 /check — Check status of your active number\n` +
      `❌ /cancel — Cancel your active number`,
    { parse_mode: "Markdown" }
  );
});

bot.command("get_number", async (ctx) => {
  const userId = ctx.from.id;

  if (sessions.has(userId)) {
    const { phone } = sessions.get(userId);
    return ctx.reply(
      `⚠️ You already have an active number: \`${phone}\`\nUse /cancel first to get a new one.`,
      { parse_mode: "Markdown" }
    );
  }

  const msg = await ctx.reply("⏳ Requesting a phone number...");

  try {
    const { id, phone } = await getNumber();
    sessions.set(userId, { id, phone, startedAt: Date.now() });

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      msg.message_id,
      null,
      `✅ *Your number is ready!*\n\n📱 \`${phone}\`\n\n⏳ Waiting for SMS code (up to 2 min)...`,
      { parse_mode: "Markdown" }
    );

    const code = await pollForSms(ctx, id);
    sessions.delete(userId);
    await setStatus(id, 6);

    await ctx.reply(
      `🎉 *SMS Code Received!*\n\n🔑 Code: \`${code}\`\n📱 Number: \`${phone}\``,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    sessions.delete(userId);
    await ctx.reply(`❌ Error: ${err.message}`);
  }
});

bot.command("check", async (ctx) => {
  const userId = ctx.from.id;
  const session = sessions.get(userId);

  if (!session) {
    return ctx.reply("ℹ️ You have no active number. Use /get_number to get one.");
  }

  try {
    const status = await getStatus(session.id);
    const elapsed = Math.floor((Date.now() - session.startedAt) / 1000);

    if (status.startsWith("STATUS_OK")) {
      const code = status.split(":")[1];
      sessions.delete(userId);
      await setStatus(session.id, 6);
      return ctx.reply(
        `🎉 *SMS Code Received!*\n\n🔑 Code: \`${code}\`\n📱 Number: \`${session.phone}\``,
        { parse_mode: "Markdown" }
      );
    }

    ctx.reply(
      `📊 *Status Update*\n\n📱 Number: \`${session.phone}\`\n🕐 Status: ${status}\n⏱ Elapsed: ${elapsed}s`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    ctx.reply(`❌ Error checking status: ${err.message}`);
  }
});

bot.command("cancel", async (ctx) => {
  const userId = ctx.from.id;
  const session = sessions.get(userId);

  if (!session) {
    return ctx.reply("ℹ️ You have no active number to cancel.");
  }

  try {
    await setStatus(session.id, 8);
    sessions.delete(userId);
    ctx.reply(`✅ Number \`${session.phone}\` has been cancelled.`, {
      parse_mode: "Markdown",
    });
  } catch (err) {
    sessions.delete(userId);
    ctx.reply(`⚠️ Cancelled locally (API error: ${err.message})`);
  }
});

bot.launch(() => {
  console.log("🤖 Telegram bot is running...");
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
