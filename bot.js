require("dotenv").config();

const { Telegraf, Markup, session } = require("telegraf");
const Database = require("better-sqlite3");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean)
  .map(Number);

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN .env faylda ko‘rsatilmagan.");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

/* =========================================================
   DATABASE
========================================================= */

const db = new Database("afarid.db");

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER UNIQUE NOT NULL,
    username TEXT,
    first_name TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    model TEXT NOT NULL,
    price TEXT NOT NULL,
    age TEXT NOT NULL,
    sizes TEXT NOT NULL,
    photo_id TEXT NOT NULL,
    description TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    store_name TEXT NOT NULL,
    manager_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    sizes TEXT NOT NULL,
    region TEXT NOT NULL,
    comment TEXT DEFAULT '',
    status TEXT DEFAULT 'NEW',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS complaints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL,
    username TEXT DEFAULT '',
    store_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT DEFAULT 'NEW',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

/* =========================================================
   CONSTANTS
========================================================= */

const CATEGORIES = [
  "🎓 Maktab pidjaklari",
  "👖 Shimlar",
  "👔 Kostyum-shimlar",
  "🤵 Klassik kostyumlar",
  "🧒 Detskiy kostyumlar",
];

const MAIN_MENU = [
  ["💎 Bizda Nimalar Bor", "📰 Kunlik Yangiliklar"],
  ["🏢 Fabrika Haqida", "📦 Mening Zakazlarim"],
  ["📞 Biz bilan Bog‘lanish", "🌐 Rasmiy Tarmoqlar"],
  ["🏬 Toshkent Do‘koni", "🏭 Namangan Fabrika"],
  ["📝 Shikoyat qoldirish"],
];

const ADMIN_MENU = [
  ["➕ Yangi Tovar Qo‘shish"],
  ["📦 Zakazlar", "📝 Shikoyatlar"],
  ["📊 Statistika"],
  ["🏠 Asosiy Menyu"],
];

const BACK_BUTTON = [["🔙 Orqaga"]];

const CANCEL_BUTTON = [["❌ Bekor qilish"]];

const botSession = new Map();

/* =========================================================
   HELPERS
========================================================= */

function isAdmin(userId) {
  return ADMIN_IDS.includes(Number(userId));
}

function saveUser(ctx) {
  try {
    const u = ctx.from;

    db.prepare(`
      INSERT INTO users
        (telegram_id, username, first_name)
      VALUES
        (?, ?, ?)
      ON CONFLICT(telegram_id)
      DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name
    `).run(
      u.id,
      u.username || "",
      u.first_name || ""
    );
  } catch (err) {
    console.error("User DB xatosi:", err);
  }
}

function setState(userId, state, data = {}) {
  botSession.set(userId, {
    state,
    data,
  });
}

function getState(userId) {
  return botSession.get(userId);
}

function clearState(userId) {
  botSession.delete(userId);
}

function backKeyboard() {
  return Markup.keyboard(BACK_BUTTON).resize();
}

function cancelKeyboard() {
  return Markup.keyboard(CANCEL_BUTTON).resize();
}

function mainKeyboard() {
  return Markup.keyboard(MAIN_MENU).resize();
}

function adminKeyboard() {
  return Markup.keyboard(ADMIN_MENU).resize();
}

function escapeHtml(text = "") {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function categoryKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🎓 Maktab pidjaklari", "cat_0"),
      Markup.button.callback("👖 Shimlar", "cat_1"),
    ],
    [
      Markup.button.callback("👔 Kostyum-shimlar", "cat_2"),
      Markup.button.callback("🤵 Klassik kostyumlar", "cat_3"),
    ],
    [
      Markup.button.callback("🧒 Detskiy kostyumlar", "cat_4"),
    ],
  ]);
}

function productText(product) {
  return (
    `<b>✨ A-FARID STYLE TURKEY</b>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `👔 <b>${escapeHtml(product.name)}</b>\n\n` +
    `🏷 <b>Model:</b> ${escapeHtml(product.model)}\n` +
    `👦 <b>Yosh:</b> ${escapeHtml(product.age)}\n` +
    `📏 <b>Razmer:</b> ${escapeHtml(product.sizes)}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `💰 <b>Optom narxi:</b> ${escapeHtml(product.price)}\n\n` +
    `⚠️ <b>FAQAT OPTOM SAVDO</b>\n` +
    `Donalab sotilmaydi.`
  );
}

function productKeyboard(productId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "🛒 OPTOM ZAKAZ BERISH",
        `order_${productId}`
      ),
    ],
  ]);
}

function formatStatus(status) {
  const map = {
    NEW: "🆕 Yangi",
    IN_PROGRESS: "🔄 Ko‘rib chiqilmoqda",
    RESOLVED: "✅ Hal qilindi",
    CONFIRMED: "✅ Tasdiqlangan",
    CANCELLED: "❌ Bekor qilingan",
  };

  return map[status] || status;
}

async function sendToAdmins(text, extra = {}) {
  for (const adminId of ADMIN_IDS) {
    try {
      await bot.telegram.sendMessage(adminId, text, {
        parse_mode: "HTML",
        ...extra,
      });
    } catch (err) {
      console.error(
        `Admin ${adminId} ga xabar yuborilmadi:`,
        err.message
      );
    }
  }
}

async function showMainMenu(ctx) {
  clearState(ctx.from.id);

  await ctx.reply(
    `<b>🏠 A-FARID STYLE TURKEY</b>\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `✨ <b>Assalomu alaykum!</b>\n\n` +
      `Siz <b>A-FARID STYLE TURKEY</b>\n` +
      `rasmiy Telegram botidasiz.\n\n` +
      `👦 1–16 yosh\n` +
      `👔 Premium bolalar kiyimlari\n` +
      `📦 Faqat optom savdo\n` +
      `🌍 Butun dunyo bo‘ylab yetkazib berish\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `👇 Kerakli bo‘limni tanlang:`,
    {
      parse_mode: "HTML",
      ...mainKeyboard(),
    }
  );
}

/* =========================================================
   START
========================================================= */

bot.start(async (ctx) => {
  saveUser(ctx);

  clearState(ctx.from.id);

  await ctx.reply(
    `<b>✨ A-FARID STYLE TURKEY</b>\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🏛 <b>AFARID | 1998-yildan beri</b>\n\n` +
      `Premium sifat.\n` +
      `Mukammal uslub.\n\n` +
      `👦 1–16 yoshdagi bolalar uchun\n` +
      `premium klassik kiyimlar.\n\n` +
      `🌍 O‘zbekistondan butun dunyoga\n` +
      `✈️ Yetkazib berish butun dunyo bo‘ylab\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `👔 Klassik kostyumlar\n` +
      `👖 Shimlar\n` +
      `🧥 Pidjaklar\n` +
      `🎓 Maktab pidjaklari\n` +
      `👔 Kostyum-shimlar\n` +
      `🧒 Detskiy kostyumlar\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `⚡️ <b>FAQAT OPTOM SAVDO</b>\n` +
      `Donalab sotilmaydi.\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🤝 <b>XUSH KELIBSIZ!</b>\n\n` +
      `Kerakli bo‘limni tanlang 👇\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `✅ <b>A-FARID STYLE TURKEY</b>\n` +
      `🏛 RASMIY BOT`,
    {
      parse_mode: "HTML",
      ...mainKeyboard(),
    }
  );
});

/* =========================================================
   MAIN MENU
========================================================= */

bot.hears("🏠 Asosiy Menyu", async (ctx) => {
  saveUser(ctx);
  await showMainMenu(ctx);
});

bot.hears("🔙 Orqaga", async (ctx) => {
  const state = getState(ctx.from.id);

  if (!state) {
    await showMainMenu(ctx);
    return;
  }

  clearState(ctx.from.id);

  if (isAdmin(ctx.from.id)) {
    await ctx.reply(
      "⚙️ <b>A-FARID ADMIN PANEL</b>\n\nKerakli bo‘limni tanlang:",
      {
        parse_mode: "HTML",
        ...adminKeyboard(),
      }
    );
  } else {
    await showMainMenu(ctx);
  }
});

/* =========================================================
   BIZDA NIMALAR BOR
========================================================= */

bot.hears("💎 Bizda Nimalar Bor", async (ctx) => {
  saveUser(ctx);

  await ctx.reply(
    `<b>💎 BIZDA NIMALAR BOR?</b>\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `👦 <b>1 yoshdan 16 yoshgacha:</b>\n\n` +
      `🎓 Maktab pidjaklari\n` +
      `👖 Shimlar\n` +
      `👔 Kostyum-shimlar\n` +
      `🤵 Klassik kostyumlar\n` +
      `🧒 Detskiy kostyumlar\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `⚠️ <b>FAQAT OPTOM SAVDO</b>\n` +
      `Donalab sotilmaydi.\n\n` +
      `👇 Kategoriyani tanlang:`,
    {
      parse_mode: "HTML",
      ...Markup.keyboard([
        ["🎓 Maktab pidjaklari", "👖 Shimlar"],
        ["👔 Kostyum-shimlar", "🤵 Klassik kostyumlar"],
        ["🧒 Detskiy kostyumlar"],
        ["🔙 Orqaga"],
      ]).resize(),
    }
  );

  await ctx.reply(
    "Mahsulot turini tanlang:",
    categoryKeyboard()
  );
});

/* =========================================================
   CATEGORY CALLBACKS
========================================================= */

for (let i = 0; i < CATEGORIES.length; i++) {
  bot.action(`cat_${i}`, async (ctx) => {
    try {
      await ctx.answerCbQuery();

      const category = CATEGORIES[i];

      const products = db.prepare(`
        SELECT *
        FROM products
        WHERE category = ?
          AND is_active = 1
        ORDER BY id DESC
      `).all(category);

      if (!products.length) {
        await ctx.reply(
          `📭 <b>Ushbu kategoriyada hozircha mahsulot mavjud emas.</b>\n\n` +
            `👇 Boshqa bo‘limni tanlashingiz mumkin.`,
          {
            parse_mode: "HTML",
            ...Markup.keyboard([
              ["💎 Bizda Nimalar Bor"],
              ["🔙 Orqaga"],
            ]).resize(),
          }
        );
        return;
      }

      await ctx.reply(
        `<b>${escapeHtml(category)}</b>\n\n` +
          `Mavjud mahsulotlar: <b>${products.length} ta</b>`,
        {
          parse_mode: "HTML",
          ...Markup.keyboard([
            ["💎 Bizda Nimalar Bor"],
            ["🔙 Orqaga"],
          ]).resize(),
        }
      );

      for (const product of products) {
        if (product.photo_id) {
          await ctx.replyWithPhoto(
            product.photo_id,
            {
              caption: productText(product),
              parse_mode: "HTML",
              ...productKeyboard(product.id),
            }
          );
        } else {
          await ctx.reply(
            productText(product),
            {
              parse_mode: "HTML",
              ...productKeyboard(product.id),
            }
          );
        }
      }
    } catch (err) {
      console.error("Kategoriya xatosi:", err);
      await ctx.reply("❌ Mahsulotlarni yuklashda xatolik yuz berdi.");
    }
  });
}

/* =========================================================
   CATEGORY REPLY BUTTONS
========================================================= */

for (const category of CATEGORIES) {
  bot.hears(category, async (ctx) => {
    const products = db.prepare(`
      SELECT *
      FROM products
      WHERE category = ?
        AND is_active = 1
      ORDER BY id DESC
    `).all(category);

    if (!products.length) {
      await ctx.reply(
        "📭 Ushbu kategoriyada hozircha mahsulot mavjud emas.",
        backKeyboard()
      );
      return;
    }

    await ctx.reply(
      `<b>${escapeHtml(category)}</b>\n\n` +
        `Mavjud mahsulotlar: <b>${products.length} ta</b>`,
      {
        parse_mode: "HTML",
        ...backKeyboard(),
      }
    );

    for (const product of products) {
      if (product.photo_id) {
        await ctx.replyWithPhoto(product.photo_id, {
          caption: productText(product),
          parse_mode: "HTML",
          ...productKeyboard(product.id),
        });
      } else {
        await ctx.reply(
          productText(product),
          {
            parse_mode: "HTML",
            ...productKeyboard(product.id),
          }
        );
      }
    }
  });
}

/* =========================================================
   KUNLIK YANGILIKLAR
========================================================= */

bot.hears("📰 Kunlik Yangiliklar", async (ctx) => {
  saveUser(ctx);

  const products = db.prepare(`
    SELECT *
    FROM products
    WHERE is_active = 1
    ORDER BY id DESC
    LIMIT 10
  `).all();

  if (!products.length) {
    await ctx.reply(
      `<b>📰 KUNLIK YANGILIKLAR</b>\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `Hozircha yangi mahsulotlar kiritilmagan.\n\n` +
        `Tez orada yangi kolleksiyalar shu yerda paydo bo‘ladi. ✨`,
      {
        parse_mode: "HTML",
        ...backKeyboard(),
      }
    );
    return;
  }

  await ctx.reply(
    `<b>📰 KUNLIK YANGILIKLAR</b>\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `A-FARID STYLE TURKEY yangiliklari va yangi qo‘shilgan mahsulotlar:`,
    {
      parse_mode: "HTML",
      ...backKeyboard(),
    }
  );

  for (const product of products) {
    if (product.photo_id) {
      await ctx.replyWithPhoto(product.photo_id, {
        caption: productText(product),
        parse_mode: "HTML",
        ...productKeyboard(product.id),
      });
    } else {
      await ctx.reply(
        productText(product),
        {
          parse_mode: "HTML",
          ...productKeyboard(product.id),
        }
      );
    }
  }
});

/* =========================================================
   FABRIKA HAQIDA
========================================================= */

bot.hears("🏢 Fabrika Haqida", async (ctx) => {
  saveUser(ctx);

  await ctx.reply(
    `<b>🏢 A-FARID FABRIKASI HAQIDA</b>\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<b>AFARID | 1998-yildan beri</b>\n\n` +
      `A-FARID Style Turkey — 1 yoshdan 16 yoshgacha bo‘lgan bolalar uchun premium klassik kiyimlar ishlab chiqaruvchi kompaniya.\n\n` +
      `Bizning asosiy yo‘nalishlarimiz:\n\n` +
      `👔 Klassik kostyumlar\n` +
      `👖 Kostyum shimlar\n` +
      `🧥 Pidjaklar\n` +
      `🎓 Maktab pidjaklari\n` +
      `🧒 Detskiy kostyumlar\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<b>Bizning ustunliklarimiz:</b>\n\n` +
      `✨ Premium sifat\n` +
      `✂️ Mukammal bichim\n` +
      `🛡 Qulay va chidamli mahsulotlar\n` +
      `👔 Zamonaviy dizayn\n` +
      `🌍 Xalqaro bozorga yo‘naltirilgan ishlab chiqarish\n` +
      `✈️ Butun dunyo bo‘ylab yetkazib berish\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Sizning ishonchingiz — bizning bosh maqsadimiz! 🤝\n\n` +
      `⚡️ <b>FAQAT OPTOM SAVDO</b>\n` +
      `Donalab sotilmaydi.`,
    {
      parse_mode: "HTML",
      ...backKeyboard(),
    }
  );
});

/* =========================================================
   BOG‘LANISH
========================================================= */

bot.hears("📞 Biz bilan Bog‘lanish", async (ctx) => {
  saveUser(ctx);

  await ctx.reply(
    `<b>📞 BIZ BILAN BOG‘LANISH</b>\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `☎️ <b>Telefon raqamlarimiz:</b>\n\n` +
      `📞 +998 90 798 74 74\n` +
      `📞 +998 91 354 61 61\n` +
      `📞 +998 91 052 74 74\n` +
      `📞 +998 91 341 74 74\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `💬 Menejer bilan bog‘lanish uchun quyidagi tugmalardan foydalaning.\n\n` +
      `A-FARID STYLE TURKEY jamoasi sizga yordam berishga tayyor. 🤝`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.url(
            "📞 +998 90 798 74 74",
            "https://t.me/afarid_official"
          ),
        ],
        [
          Markup.button.url(
            "📞 +998 91 354 61 61",
            "https://t.me/afarid_official"
          ),
        ],
        [
          Markup.button.url(
            "📞 +998 91 052 74 74",
            "https://t.me/afarid_official"
          ),
        ],
        [
          Markup.button.url(
            "📞 +998 91 341 74 74",
            "https://t.me/afarid_official"
          ),
        ],
        [
          Markup.button.url(
            "💬 Telegram orqali yozish",
            "https://t.me/afarid_official"
          ),
        ],
      ]),
    }
  );

  await ctx.reply(
    "🔙 Bosh menyuga qaytish:",
    backKeyboard()
  );
});

/* =========================================================
   IJTIMOIY TARMOQLAR
========================================================= */

bot.hears("🌐 Rasmiy Tarmoqlar", async (ctx) => {
  saveUser(ctx);

  await ctx.reply(
    `<b>🌐 RASMIY IJTIMOIY TARMOQLARIMIZ</b>\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Bizni kuzatib boring! 👇\n\n` +
      `📱 Telegram — @afarid_fashion\n` +
      `📸 Instagram / Threads — @afarid_0fficial\n` +
      `▶️ YouTube — @AfaridTextil\n` +
      `🛍 Online do‘kon — afarid.uz`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.url(
            "📱 Telegram",
            "https://t.me/afarid_fashion"
          ),
        ],
        [
          Markup.button.url(
            "📸 Instagram / Threads",
            "https://www.threads.com/@afarid_0fficial"
          ),
        ],
        [
          Markup.button.url(
            "▶️ YouTube",
            "https://www.youtube.com/@AfaridTextil"
          ),
        ],
        [
          Markup.button.url(
            "🛍 Online do‘kon",
            "https://afarid.uz/"
          ),
        ],
      ]),
      ...backKeyboard()
    }
  );
});

/* =========================================================
   TOSHKENT DO‘KONI
========================================================= */

bot.hears("🏬 Toshkent Do‘koni", async (ctx) => {
  saveUser(ctx);

  await ctx.reply(
    `<b>🏬 TOSHKENT DO‘KONI</b>\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📞 <b>Telefon:</b>\n` +
      `+998 90 798 74 74\n\n` +
      `👤 <b>Telegram:</b>\n` +
      `@afarid_official\n\n` +
      `📍 <b>Manzil:</b>\n` +
      `Toshkent shahri,\n` +
      `Toshkent Gipermarketi,\n` +
      `3-etaj, 318-do‘kon\n\n` +
      `🕐 <b>Ish vaqti:</b>\n` +
      `05:00 — 15:00\n\n` +
      `📅 <b>Ish kunlari:</b>\n` +
      `Seshanbadan — Yakshanbagacha\n\n` +
      `🔴 <b>Dam olish:</b>\n` +
      `Dushanba`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.url(
            "💬 @afarid_official",
            "https://t.me/afarid_official"
          ),
        ],
      ]),
      ...backKeyboard()
    }
  );
});

/* =========================================================
   NAMANGAN FABRIKA
========================================================= */

bot.hears("🏭 Namangan Fabrika", async (ctx) => {
  saveUser(ctx);

  await ctx.reply(
    `<b>🏭 NAMANGAN FABRIKA</b>\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📍 <b>Manzil:</b>\n` +
      `O‘zbekiston Respublikasi,\n` +
      `Namangan shahri,\n` +
      `Sanoatchi ko‘chasi, 3-uy.\n\n` +
      `📞 <b>Telefon:</b>\n` +
      `+998 91 341 74 74\n\n` +
      `🕐 <b>Ish vaqti:</b>\n` +
      `08:00 — 17:00\n\n` +
      `📅 <b>Ish kunlari:</b>\n` +
      `Dushanbadan — Yakshanbagacha\n\n` +
      `🔴 <b>Dam olish:</b>\n` +
      `Seshanba\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `A-FARID STYLE TURKEY ishlab chiqarish jamoasi. 🇺🇿`,
    {
      parse_mode: "HTML",
      ...backKeyboard(),
    }
  );
});

/* =========================================================
   ORDER START
========================================================= */

bot.action(/^order_(\d+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery();

    const productId = Number(ctx.match[1]);

    const product = db.prepare(`
      SELECT *
      FROM products
      WHERE id = ?
        AND is_active = 1
    `).get(productId);

    if (!product) {
      await ctx.reply("❌ Ushbu mahsulot topilmadi yoki mavjud emas.");
      return;
    }

    setState(ctx.from.id, "ORDER_STORE", {
      productId,
      product,
    });

    await ctx.reply(
      `<b>🛒 OPTOM ZAKAZ</b>\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `👔 <b>Mahsulot:</b> ${escapeHtml(product.name)}\n` +
        `🏷 <b>Model:</b> ${escapeHtml(product.model)}\n` +
        `💰 <b>Optom narxi:</b> ${escapeHtml(product.price)}\n` +
        `👦 <b>Yosh:</b> ${escapeHtml(product.age)}\n` +
        `📏 <b>Razmer:</b> ${escapeHtml(product.sizes)}\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🏪 <b>Do‘kon nomini kiriting:</b>`,
      {
        parse_mode: "HTML",
        ...cancelKeyboard(),
      }
    );
  } catch (err) {
    console.error("Order start:", err);
    await ctx.reply("❌ Zakazni boshlashda xatolik.");
  }
});

/* =========================================================
   ORDER FSM
========================================================= */

bot.on("text", async (ctx, next) => {
  const state = getState(ctx.from.id);

  if (!state) {
    return next();
  }

  const text = ctx.message.text.trim();

  if (text === "❌ Bekor qilish") {
    clearState(ctx.from.id);

    await ctx.reply(
      "❌ Amal bekor qilindi.",
      mainKeyboard()
    );

    return;
  }

  if (text === "🔙 Orqaga") {
    clearState(ctx.from.id);

    await showMainMenu(ctx);
    return;
  }

  /* -------------------------------------------------------
     ORDER
  ------------------------------------------------------- */

  if (state.state === "ORDER_STORE") {
    state.data.storeName = text;
    setState(ctx.from.id, "ORDER_MANAGER", state.data);

    await ctx.reply(
      "👤 <b>Mas’ul shaxs</b>\n\nIsm va familiyangizni kiriting:",
      {
        parse_mode: "HTML",
        ...backKeyboard(),
      }
    );

    return;
  }

  if (state.state === "ORDER_MANAGER") {
    state.data.managerName = text;
    setState(ctx.from.id, "ORDER_PHONE", state.data);

    await ctx.reply(
      "📞 <b>Telefon raqamingizni yuboring:</b>",
      {
        parse_mode: "HTML",
        ...Markup.keyboard([
          [
            Markup.button.contactRequest(
              "📱 Telefon raqamni yuborish"
            ),
          ],
          ["🔙 Orqaga"],
        ]).resize(),
      }
    );

    return;
  }

  if (state.state === "ORDER_PHONE") {
    state.data.phone = text;

    setState(ctx.from.id, "ORDER_QUANTITY", state.data);

    await ctx.reply(
      "📦 <b>NECHA DONA?</b>\n\nNecha dona zakaz qilmoqchisiz?",
      {
        parse_mode: "HTML",
        ...backKeyboard(),
      }
    );

    return;
  }

  if (state.state === "ORDER_QUANTITY") {
    const quantity = Number(text);

    if (!Number.isInteger(quantity) || quantity <= 0) {
      await ctx.reply(
        "❌ Iltimos, miqdorni faqat musbat son bilan kiriting.\n\nMasalan: <b>20</b>",
        {
          parse_mode: "HTML",
          ...backKeyboard(),
        }
      );
      return;
    }

    state.data.quantity = quantity;

    setState(ctx.from.id, "ORDER_SIZES", state.data);

    await ctx.reply(
      `📏 <b>RAZMER</b>\n\n` +
        `Kerakli razmerni kiriting:\n\n` +
        `Masalan: <b>${escapeHtml(
          state.data.product.sizes
        )}</b>`,
      {
        parse_mode: "HTML",
        ...backKeyboard(),
      }
    );

    return;
  }

  if (state.state === "ORDER_SIZES") {
    state.data.sizes = text;

    setState(ctx.from.id, "ORDER_REGION", state.data);

    await ctx.reply(
      "📍 <b>HUDUD</b>\n\nQaysi viloyat yoki shahardansiz?",
      {
        parse_mode: "HTML",
        ...backKeyboard(),
      }
    );

    return;
  }

  if (state.state === "ORDER_REGION") {
    state.data.region = text;

    setState(ctx.from.id, "ORDER_COMMENT", state.data);

    await ctx.reply(
      "📝 <b>IZOH</b>\n\nQo‘shimcha izoh bo‘lsa yozing.\nAgar izoh bo‘lmasa <b>Yo‘q</b> deb yozing.",
      {
        parse_mode: "HTML",
        ...backKeyboard(),
      }
    );

    return;
  }

  if (state.state === "ORDER_COMMENT") {
    state.data.comment = text;

    const d = state.data;
    const p = d.product;

    setState(ctx.from.id, "ORDER_CONFIRM", d);

    await ctx.reply(
      `<b>━━━━━━━━━━━━━━━━━━━━━━</b>\n` +
        `<b>🛒 ZAKAZNI TEKSHIRISH</b>\n` +
        `<b>━━━━━━━━━━━━━━━━━━━━━━</b>\n\n` +
        `👔 <b>Mahsulot:</b> ${escapeHtml(p.name)}\n` +
        `🏷 <b>Model:</b> ${escapeHtml(p.model)}\n` +
        `👦 <b>Yosh:</b> ${escapeHtml(p.age)}\n` +
        `📏 <b>Razmer:</b> ${escapeHtml(d.sizes)}\n` +
        `💰 <b>Optom narxi:</b> ${escapeHtml(p.price)}\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🏪 <b>Do‘kon:</b> ${escapeHtml(d.storeName)}\n` +
        `👤 <b>Mas’ul:</b> ${escapeHtml(d.managerName)}\n` +
        `📞 <b>Telefon:</b> ${escapeHtml(d.phone)}\n` +
        `📦 <b>Miqdor:</b> ${d.quantity} dona\n` +
        `📍 <b>Hudud:</b> ${escapeHtml(d.region)}\n` +
        `📝 <b>Izoh:</b> ${escapeHtml(d.comment)}\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `⚠️ <b>FAQAT OPTOM SAVDO</b>\n` +
        `Donalab sotilmaydi.`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "✅ ZAKAZNI TASDIQLASH",
              "confirm_order"
            ),
          ],
          [
            Markup.button.callback(
              "❌ BEKOR QILISH",
              "cancel_order"
            ),
          ],
        ]),
      }
    );

    return;
  }

  /* -------------------------------------------------------
     COMPLAINT
  ------------------------------------------------------- */

  if (state.state === "COMPLAINT_MESSAGE") {
    state.data.message = text;

    setState(ctx.from.id, "COMPLAINT_PHONE", state.data);

    await ctx.reply(
      "📞 <b>Telefon raqamingizni kiriting:</b>",
      {
        parse_mode: "HTML",
        ...Markup.keyboard([
          [
            Markup.button.contactRequest(
              "📱 Telefon raqamni yuborish"
            ),
          ],
          ["🔙 Orqaga"],
        ]).resize(),
      }
    );

    return;
  }

  if (state.state === "COMPLAINT_PHONE") {
    state.data.phone = text;

    setState(ctx.from.id, "COMPLAINT_STORE", state.data);

    await ctx.reply(
      "🏪 <b>Do‘kon nomini kiriting:</b>",
      {
        parse_mode: "HTML",
        ...backKeyboard(),
      }
    );

    return;
  }

  if (state.state === "COMPLAINT_STORE") {
    state.data.storeName = text;

    const d = state.data;

    try {
      const result = db.prepare(`
        INSERT INTO complaints
        (telegram_id, username, store_name, phone, message, status)
        VALUES (?, ?, ?, ?, ?, 'NEW')
      `).run(
        ctx.from.id,
        ctx.from.username || "",
        d.storeName,
        d.phone,
        d.message
      );

      clearState(ctx.from.id);

      await ctx.reply(
        `<b>✅ SHIKOYATINGIZ QABUL QILINDI</b>\n\n` +
          `🆔 <b>Murojaat #${result.lastInsertRowid}</b>\n\n` +
          `Murojaatingiz mas’ullarimizga yuborildi.\n` +
          `Tez orada siz bilan bog‘lanamiz. 🤝`,
        {
          parse_mode: "HTML",
          ...mainKeyboard(),
        }
      );

      await sendToAdmins(
        `<b>🚨 YANGI SHIKOYAT</b>\n\n` +
          `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `🆔 <b>Murojaat #${result.lastInsertRowid}</b>\n` +
          `👤 <b>Username:</b> @${escapeHtml(
            ctx.from.username || "username yo‘q"
          )}\n` +
          `🏪 <b>Do‘kon:</b> ${escapeHtml(d.storeName)}\n` +
          `📞 <b>Telefon:</b> ${escapeHtml(d.phone)}\n` +
          `📝 <b>Shikoyat:</b>\n${escapeHtml(d.message)}\n\n` +
          `📊 <b>Status:</b> 🆕 Yangi`
      );
    } catch (err) {
      console.error("Complaint save:", err);

      await ctx.reply(
        "❌ Shikoyatni saqlashda xatolik yuz berdi. Iltimos, qaytadan urinib ko‘ring.",
        mainKeyboard()
      );

      clearState(ctx.from.id);
    }

    return;
  }

  /* -------------------------------------------------------
     ADMIN ADD PRODUCT
  ------------------------------------------------------- */

  if (!isAdmin(ctx.from.id)) {
    return next();
  }

  if (state.state === "ADMIN_NAME") {
    state.data.name = text;

    setState(ctx.from.id, "ADMIN_MODEL", state.data);

    await ctx.reply(
      "🏷 <b>MODEL</b>\n\nModel kodini kiriting:\n\nMasalan: <b>AF-101</b>",
      {
        parse_mode: "HTML",
        ...backKeyboard(),
      }
    );

    return;
  }

  if (state.state === "ADMIN_MODEL") {
    state.data.model = text;

    setState(ctx.from.id, "ADMIN_PRICE", state.data);

    await ctx.reply(
      "💰 <b>OPTOM NARXI</b>\n\nMasalan: <b>$45</b>",
      {
        parse_mode: "HTML",
        ...backKeyboard(),
      }
    );

    return;
  }

  if (state.state === "ADMIN_PRICE") {
    state.data.price = text;

    setState(ctx.from.id, "ADMIN_AGE", state.data);

    await ctx.reply(
      "👦 <b>YOSH</b>\n\nMasalan: <b>7–10 yosh</b>",
      {
        parse_mode: "HTML",
        ...backKeyboard(),
      }
    );

    return;
  }

  if (state.state === "ADMIN_AGE") {
    state.data.age = text;

    setState(ctx.from.id, "ADMIN_SIZES", state.data);

    await ctx.reply(
      "📏 <b>RAZMER</b>\n\nMasalan: <b>28–44</b>\n\nAdmin qanday kiritsa, aynan shu qiymat saqlanadi.",
      {
        parse_mode: "HTML",
        ...backKeyboard(),
      }
    );

    return;
  }

  if (state.state === "ADMIN_SIZES") {
    state.data.sizes = text;

    setState(ctx.from.id, "ADMIN_PHOTO", state.data);

    await ctx.reply(
      "📸 <b>MAHSULOT RASMI</b>\n\nMahsulot rasmini <b>PHOTO</b> ko‘rinishida yuboring.",
      {
        parse_mode: "HTML",
        ...backKeyboard(),
      }
    );

    return;
  }

  if (state.state === "ADMIN_DESCRIPTION") {
    state.data.description = text;

    await showAdminPreview(ctx, state.data);
    return;
  }

  if (state.state === "ADMIN_EDIT_FIELD") {
    const field = state.data.editField;

    state.data[field] = text;

    await showAdminPreview(ctx, state.data);
    return;
  }

  return next();
});

/* =========================================================
   CONTACT HANDLER
========================================================= */

bot.on("contact", async (ctx) => {
  const state = getState(ctx.from.id);

  if (!state) return;

  const phone = ctx.message.contact.phone_number;

  if (
    state.state === "ORDER_PHONE"
  ) {
    state.data.phone = phone;

    setState(ctx.from.id, "ORDER_QUANTITY", state.data);

    await ctx.reply(
      "📦 <b>NECHA DONA?</b>\n\nNecha dona zakaz qilmoqchisiz?",
      {
        parse_mode: "HTML",
        ...backKeyboard(),
      }
    );

    return;
  }

  if (
    state.state === "COMPLAINT_PHONE"
  ) {
    state.data.phone = phone;

    setState(ctx.from.id, "COMPLAINT_STORE", state.data);

    await ctx.reply(
      "🏪 <b>Do‘kon nomini kiriting:</b>",
      {
        parse_mode: "HTML",
        ...backKeyboard(),
      }
    );

    return;
  }
});

/* =========================================================
   ORDER CONFIRM
========================================================= */

bot.action("confirm_order", async (ctx) => {
  try {
    await ctx.answerCbQuery();

    const state = getState(ctx.from.id);

    if (!state || state.state !== "ORDER_CONFIRM") {
      await ctx.reply("❌ Zakaz ma’lumotlari topilmadi.");
      return;
    }

    const d = state.data;

    const result = db.prepare(`
      INSERT INTO orders
      (
        telegram_id,
        product_id,
        store_name,
        manager_name,
        phone,
        quantity,
        sizes,
        region,
        comment,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'NEW')
    `).run(
      ctx.from.id,
      d.productId,
      d.storeName,
      d.managerName,
      d.phone,
      d.quantity,
      d.sizes,
      d.region,
      d.comment
    );

    const orderId = result.lastInsertRowid;

    clearState(ctx.from.id);

    await ctx.editMessageReplyMarkup({
      inline_keyboard: [],
    });

    await ctx.reply(
      `<b>✅ ZAKAZINGIZ QABUL QILINDI!</b>\n\n` +
        `🆔 <b>Zakaz #${orderId}</b>\n\n` +
        `Menejerimiz tez orada siz bilan bog‘lanadi.\n\n` +
        `🤝 A-FARID STYLE TURKEY`,
      {
        parse_mode: "HTML",
        ...mainKeyboard(),
      }
    );

    await sendToAdmins(
      `<b>🚨 YANGI ZAKAZ</b>\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🆔 <b>Zakaz #${orderId}</b>\n\n` +
        `👔 <b>Mahsulot:</b> ${escapeHtml(d.product.name)}\n` +
        `🏷 <b>Model:</b> ${escapeHtml(d.product.model)}\n` +
        `👦 <b>Yosh:</b> ${escapeHtml(d.product.age)}\n` +
        `📏 <b>Razmer:</b> ${escapeHtml(d.sizes)}\n` +
        `💰 <b>Narx:</b> ${escapeHtml(d.product.price)}\n\n` +
        `🏪 <b>Do‘kon:</b> ${escapeHtml(d.storeName)}\n` +
        `👤 <b>Mas’ul:</b> ${escapeHtml(d.managerName)}\n` +
        `📞 <b>Telefon:</b> ${escapeHtml(d.phone)}\n` +
        `📦 <b>Miqdor:</b> ${d.quantity} dona\n` +
        `📍 <b>Hudud:</b> ${escapeHtml(d.region)}\n` +
        `📝 <b>Izoh:</b> ${escapeHtml(d.comment)}\n\n` +
        `📊 <b>Status:</b> 🆕 Yangi`
    );
  } catch (err) {
    console.error("Confirm order:", err);
    await ctx.reply("❌ Zakazni saqlashda xatolik yuz berdi.");
  }
});

bot.action("cancel_order", async (ctx) => {
  await ctx.answerCbQuery();

  clearState(ctx.from.id);

  try {
    await ctx.editMessageReplyMarkup({
      inline_keyboard: [],
    });
  } catch (_) {}

  await ctx.reply(
    "❌ Zakaz bekor qilindi.",
    mainKeyboard()
  );
});

/* =========================================================
   MENING ZAKAZLARIM
========================================================= */

bot.hears("📦 Mening Zakazlarim", async (ctx) => {
  saveUser(ctx);

  const orders = db.prepare(`
    SELECT
      orders.*,
      products.name,
      products.model
    FROM orders
    LEFT JOIN products
      ON products.id = orders.product_id
    WHERE orders.telegram_id = ?
    ORDER BY orders.id DESC
  `).all(ctx.from.id);

  if (!orders.length) {
    await ctx.reply(
      `<b>📦 MENING ZAKAZLARIM</b>\n\n` +
        `Sizda hozircha zakazlar mavjud emas.`,
      {
        parse_mode: "HTML",
        ...backKeyboard(),
      }
    );

    return;
  }

  let message = `<b>📦 MENING ZAKAZLARIM</b>\n\n`;

  for (const order of orders) {
    message +=
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🆔 <b>Zakaz #${order.id}</b>\n` +
      `👔 ${escapeHtml(order.name || "Mahsulot")}\n` +
      `🏷 <b>Model:</b> ${escapeHtml(order.model || "-")}\n` +
      `📦 <b>Miqdor:</b> ${order.quantity} dona\n` +
      `📏 <b>Razmer:</b> ${escapeHtml(order.sizes)}\n` +
      `📍 <b>Hudud:</b> ${escapeHtml(order.region)}\n` +
      `📊 <b>Status:</b> ${formatStatus(order.status)}\n\n`;
  }

  await ctx.reply(message, {
    parse_mode: "HTML",
    ...backKeyboard(),
  });
});

/* =========================================================
   SHIKOYAT START
========================================================= */

bot.hears("📝 Shikoyat qoldirish", async (ctx) => {
  saveUser(ctx);

  setState(ctx.from.id, "COMPLAINT_MESSAGE", {});

  await ctx.reply(
    `<b>📝 SHIKOYAT QOLDIRISH</b>\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Muammo yoki shikoyatingizni yozing:`,
    {
      parse_mode: "HTML",
      ...cancelKeyboard(),
    }
  );
});

/* =========================================================
   ADMIN
========================================================= */

bot.command("admin", async (ctx) => {
  saveUser(ctx);

  if (!isAdmin(ctx.from.id)) {
    await ctx.reply("❌ Sizda admin huquqi yo‘q.");
    return;
  }

  clearState(ctx.from.id);

  await ctx.reply(
    `<b>⚙️ A-FARID ADMIN PANEL</b>\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Kerakli bo‘limni tanlang:`,
    {
      parse_mode: "HTML",
      ...adminKeyboard(),
    }
  );
});

bot.hears("⚙️ Admin Panel", async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.reply("❌ Sizda admin huquqi yo‘q.");
    return;
  }

  clearState(ctx.from.id);

  await ctx.reply(
    `<b>⚙️ A-FARID ADMIN PANEL</b>\n\nKerakli bo‘limni tanlang:`,
    {
      parse_mode: "HTML",
      ...adminKeyboard(),
    }
  );
});

/* =========================================================
   ADMIN ADD PRODUCT
========================================================= */

bot.hears("➕ Yangi Tovar Qo‘shish", async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.reply("❌ Sizda admin huquqi yo‘q.");
    return;
  }

  setState(ctx.from.id, "ADMIN_CATEGORY", {});

  await ctx.reply(
    `<b>➕ YANGI TOVAR QO‘SHISH</b>\n\n` +
      `📂 <b>KATEGORIYANI TANLANG</b>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "🎓 Maktab pidjaklari",
            "admin_cat_0"
          ),
        ],
        [
          Markup.button.callback(
            "👖 Shimlar",
            "admin_cat_1"
          ),
        ],
        [
          Markup.button.callback(
            "👔 Kostyum-shimlar",
            "admin_cat_2"
          ),
        ],
        [
          Markup.button.callback(
            "🤵 Klassik kostyumlar",
            "admin_cat_3"
          ),
        ],
        [
          Markup.button.callback(
            "🧒 Detskiy kostyumlar",
            "admin_cat_4"
          ),
        ],
      ]),
    }
  );
});

for (let i = 0; i < CATEGORIES.length; i++) {
  bot.action(`admin_cat_${i}`, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery("Admin huquqi kerak.");
      return;
    }

    await ctx.answerCbQuery();

    const state = getState(ctx.from.id);

    if (!state || state.state !== "ADMIN_CATEGORY") {
      await ctx.reply("❌ Amal muddati tugagan. Qaytadan boshlang.");
      return;
    }

    state.data.category = CATEGORIES[i];

    setState(ctx.from.id, "ADMIN_NAME", state.data);

    await ctx.reply(
      "✍️ <b>MAHSULOT NOMI</b>\n\nMahsulot nomini kiriting:\n\nMasalan: <b>Klassik Kostyum</b>",
      {
        parse_mode: "HTML",
        ...backKeyboard(),
      }
    );
  });
}

/* =========================================================
   ADMIN PHOTO
========================================================= */

bot.on("photo", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const state = getState(ctx.from.id);

  if (!state || state.state !== "ADMIN_PHOTO") {
    return;
  }

  const photo = ctx.message.photo;

  if (!photo || !photo.length) {
    await ctx.reply(
      "❌ Iltimos, mahsulot rasmini PHOTO ko‘rinishida yuboring."
    );
    return;
  }

  const bestPhoto = photo[photo.length - 1];

  state.data.photo_id = bestPhoto.file_id;

  setState(ctx.from.id, "ADMIN_DESCRIPTION", state.data);

  await ctx.reply(
    "📝 <b>TAVSIF</b>\n\nMahsulot haqida qisqacha ma’lumot kiriting:",
    {
      parse_mode: "HTML",
      ...backKeyboard(),
    }
  );
});

/* =========================================================
   ADMIN PREVIEW
========================================================= */

async function showAdminPreview(ctx, data) {
  setState(ctx.from.id, "ADMIN_PREVIEW", data);

  const preview =
    `<b>━━━━━━━━━━━━━━━━━━━━━━</b>\n` +
    `<b>✨ YANGI MAHSULOT</b>\n` +
    `<b>━━━━━━━━━━━━━━━━━━━━━━</b>\n\n` +
    `📂 <b>Kategoriya:</b> ${escapeHtml(data.category)}\n` +
    `👔 <b>Nomi:</b> ${escapeHtml(data.name)}\n` +
    `🏷 <b>Model:</b> ${escapeHtml(data.model)}\n` +
    `💰 <b>Narx:</b> ${escapeHtml(data.price)}\n` +
    `👦 <b>Yosh:</b> ${escapeHtml(data.age)}\n` +
    `📏 <b>Razmer:</b> ${escapeHtml(data.sizes)}\n\n` +
    `📝 <b>Tavsif:</b>\n${escapeHtml(
      data.description || "Tavsif kiritilmagan"
    )}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `⚠️ <b>FAQAT OPTOM SAVDO</b>\n` +
    `Donalab sotilmaydi.`;

  if (data.photo_id) {
    await ctx.replyWithPhoto(data.photo_id, {
      caption: preview,
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "✅ SAQLASH",
            "admin_save_product"
          ),
        ],
        [
          Markup.button.callback(
            "✏️ O‘ZGARTIRISH",
            "admin_edit_product"
          ),
        ],
        [
          Markup.button.callback(
            "❌ BEKOR QILISH",
            "admin_cancel_product"
          ),
        ],
      ]),
    });
  } else {
    await ctx.reply(
      preview,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "✅ SAQLASH",
              "admin_save_product"
            ),
          ],
          [
            Markup.button.callback(
              "✏️ O‘ZGARTIRISH",
              "admin_edit_product"
            ),
          ],
          [
            Markup.button.callback(
              "❌ BEKOR QILISH",
              "admin_cancel_product"
            ),
          ],
        ]),
      }
    );
  }
}

/* =========================================================
   ADMIN SAVE
========================================================= */

bot.action("admin_save_product", async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery("Admin huquqi kerak.");
    return;
  }

  await ctx.answerCbQuery();

  const state = getState(ctx.from.id);

  if (!state || state.state !== "ADMIN_PREVIEW") {
    await ctx.reply("❌ Mahsulot ma’lumotlari topilmadi.");
    return;
  }

  const d = state.data;

  try {
    const result = db.prepare(`
      INSERT INTO products
      (
        category,
        name,
        model,
        price,
        age,
        sizes,
        photo_id,
        description,
        is_active
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      d.category,
      d.name,
      d.model,
      d.price,
      d.age,
      d.sizes,
      d.photo_id,
      d.description || ""
    );

    clearState(ctx.from.id);

    try {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [],
      });
    } catch (_) {}

    await ctx.reply(
      `✅ <b>Mahsulot muvaffaqiyatli qo‘shildi!</b>\n\n` +
        `🆔 ID: <b>${result.lastInsertRowid}</b>\n` +
        `👔 ${escapeHtml(d.name)}\n` +
        `🏷 ${escapeHtml(d.model)}`,
      {
        parse_mode: "HTML",
        ...adminKeyboard(),
      }
    );
  } catch (err) {
    console.error("Product save:", err);

    await ctx.reply(
      "❌ Mahsulotni saqlashda xatolik yuz berdi."
    );
  }
});

/* =========================================================
   ADMIN CANCEL PRODUCT
========================================================= */

bot.action("admin_cancel_product", async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery("Admin huquqi kerak.");
    return;
  }

  await ctx.answerCbQuery();

  clearState(ctx.from.id);

  try {
    await ctx.editMessageReplyMarkup({
      inline_keyboard: [],
    });
  } catch (_) {}

  await ctx.reply(
    "❌ Amal bekor qilindi.",
    adminKeyboard()
  );
});

/* =========================================================
   ADMIN EDIT PRODUCT
========================================================= */

bot.action("admin_edit_product", async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery("Admin huquqi kerak.");
    return;
  }

  await ctx.answerCbQuery();

  await ctx.reply(
    "✏️ <b>Qaysi ma’lumotni o‘zgartirmoqchisiz?</b>",
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("✍️ Nomi", "edit_name"),
          Markup.button.callback("🏷 Model", "edit_model"),
        ],
        [
          Markup.button.callback("💰 Narx", "edit_price"),
          Markup.button.callback("👦 Yosh", "edit_age"),
        ],
        [
          Markup.button.callback("📏 Razmer", "edit_sizes"),
        ],
        [
          Markup.button.callback("📝 Tavsif", "edit_description"),
        ],
        [
          Markup.button.callback("📸 Rasm", "edit_photo"),
        ],
      ]),
    }
  );
});

const editFields = {
  edit_name: ["name", "✍️ Yangi mahsulot nomini kiriting:"],
  edit_model: ["model", "🏷 Yangi modelni kiriting:"],
  edit_price: ["price", "💰 Yangi optom narxini kiriting:"],
  edit_age: ["age", "👦 Yangi yoshni kiriting:"],
  edit_sizes: ["sizes", "📏 Yangi razmerni kiriting:"],
  edit_description: [
    "description",
    "📝 Yangi tavsifni kiriting:",
  ],
};

for (const [actionName, [field, question]] of Object.entries(
  editFields
)) {
  bot.action(actionName, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery("Admin huquqi kerak.");
      return;
    }

    await ctx.answerCbQuery();

    const state = getState(ctx.from.id);

    if (!state || !state.data) {
      await ctx.reply("❌ Mahsulot ma’lumotlari topilmadi.");
      return;
    }

    state.data.editField = field;

    setState(ctx.from.id, "ADMIN_EDIT_FIELD", state.data);

    await ctx.reply(question, backKeyboard());
  });
}

/* =========================================================
   ADMIN EDIT PHOTO
========================================================= */

bot.action("edit_photo", async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery("Admin huquqi kerak.");
    return;
  }

  await ctx.answerCbQuery();

  const state = getState(ctx.from.id);

  if (!state || !state.data) {
    await ctx.reply("❌ Mahsulot ma’lumotlari topilmadi.");
    return;
  }

  setState(ctx.from.id, "ADMIN_EDIT_PHOTO", state.data);

  await ctx.reply(
    "📸 Yangi mahsulot rasmini PHOTO ko‘rinishida yuboring.",
    backKeyboard()
  );
});

bot.on("photo", async (ctx, next) => {
  if (!isAdmin(ctx.from.id)) return next();

  const state = getState(ctx.from.id);

  if (!state || state.state !== "ADMIN_EDIT_PHOTO") {
    return next();
  }

  const photo = ctx.message.photo;

  if (!photo || !photo.length) {
    await ctx.reply(
      "❌ Iltimos, PHOTO yuboring."
    );
    return;
  }

  state.data.photo_id = photo[photo.length - 1].file_id;

  await showAdminPreview(ctx, state.data);
});

/* =========================================================
   ADMIN ORDERS
========================================================= */

bot.hears("📦 Zakazlar", async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.reply("❌ Sizda admin huquqi yo‘q.");
    return;
  }

  clearState(ctx.from.id);

  const orders = db.prepare(`
    SELECT
      orders.*,
      products.name,
      products.model,
      products.price,
      products.age
    FROM orders
    LEFT JOIN products
      ON products.id = orders.product_id
    ORDER BY orders.id DESC
    LIMIT 50
  `).all();

  if (!orders.length) {
    await ctx.reply(
      "📦 Hozircha zakazlar mavjud emas.",
      adminKeyboard()
    );
    return;
  }

  await ctx.reply(
    `<b>📦 ZAKAZLAR</b>\n\nJami ko‘rsatilmoqda: <b>${orders.length}</b>`,
    {
      parse_mode: "HTML",
      ...adminKeyboard(),
    }
  );

  for (const order of orders) {
    await ctx.reply(
      `<b>🛒 ZAKAZ #${order.id}</b>\n\n` +
        `👔 <b>Mahsulot:</b> ${escapeHtml(order.name || "-")}\n` +
        `🏷 <b>Model:</b> ${escapeHtml(order.model || "-")}\n` +
        `💰 <b>Narx:</b> ${escapeHtml(order.price || "-")}\n` +
        `👦 <b>Yosh:</b> ${escapeHtml(order.age || "-")}\n` +
        `📏 <b>Razmer:</b> ${escapeHtml(order.sizes)}\n\n` +
        `🏪 <b>Do‘kon:</b> ${escapeHtml(order.store_name)}\n` +
        `👤 <b>Mas’ul:</b> ${escapeHtml(order.manager_name)}\n` +
        `📞 <b>Telefon:</b> ${escapeHtml(order.phone)}\n` +
        `📦 <b>Miqdor:</b> ${order.quantity} dona\n` +
        `📍 <b>Hudud:</b> ${escapeHtml(order.region)}\n` +
        `📝 <b>Izoh:</b> ${escapeHtml(order.comment)}\n\n` +
        `📊 <b>Status:</b> ${formatStatus(order.status)}\n` +
        `🕐 <b>Sana:</b> ${escapeHtml(order.created_at)}`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "🔄 Ko‘rib chiqilmoqda",
              `order_status_${order.id}_IN_PROGRESS`
            ),
          ],
          [
            Markup.button.callback(
              "✅ Tasdiqlangan",
              `order_status_${order.id}_CONFIRMED`
            ),
            Markup.button.callback(
              "❌ Bekor",
              `order_status_${order.id}_CANCELLED`
            ),
          ],
        ]),
      }
    );
  }
});

/* =========================================================
   ADMIN ORDER STATUS
========================================================= */

bot.action(
  /^order_status_(\d+)_(NEW|IN_PROGRESS|CONFIRMED|CANCELLED)$/,
  async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery("Admin huquqi kerak.");
      return;
    }

    await ctx.answerCbQuery();

    const orderId = Number(ctx.match[1]);
    const status = ctx.match[2];

    try {
      db.prepare(`
        UPDATE orders
        SET status = ?
        WHERE id = ?
      `).run(status, orderId);

      await ctx.reply(
        `✅ <b>Zakaz #${orderId}</b> statusi o‘zgartirildi:\n\n` +
          `${formatStatus(status)}`,
        {
          parse_mode: "HTML",
        }
      );
    } catch (err) {
      console.error("Order status:", err);
      await ctx.reply(
        "❌ Statusni o‘zgartirishda xatolik."
      );
    }
  }
);

/* =========================================================
   ADMIN COMPLAINTS
========================================================= */

bot.hears("📝 Shikoyatlar", async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.reply("❌ Sizda admin huquqi yo‘q.");
    return;
  }

  clearState(ctx.from.id);

  const complaints = db.prepare(`
    SELECT *
    FROM complaints
    ORDER BY id DESC
    LIMIT 50
  `).all();

  if (!complaints.length) {
    await ctx.reply(
      "📝 Hozircha shikoyatlar mavjud emas.",
      adminKeyboard()
    );
    return;
  }

  await ctx.reply(
    `<b>📝 SHIKOYATLAR</b>\n\nJami: <b>${complaints.length}</b>`,
    {
      parse_mode: "HTML",
      ...adminKeyboard(),
    }
  );

  for (const complaint of complaints) {
    await ctx.reply(
      `<b>📝 MUROJAAT #${complaint.id}</b>\n\n` +
        `👤 <b>Username:</b> @${escapeHtml(
          complaint.username || "username yo‘q"
        )}\n` +
        `🏪 <b>Do‘kon:</b> ${escapeHtml(complaint.store_name)}\n` +
        `📞 <b>Telefon:</b> ${escapeHtml(complaint.phone)}\n\n` +
        `📝 <b>Shikoyat:</b>\n${escapeHtml(
          complaint.message
        )}\n\n` +
        `📊 <b>Status:</b> ${formatStatus(
          complaint.status
        )}\n` +
        `🕐 <b>Sana:</b> ${escapeHtml(complaint.created_at)}`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "👀 Ko‘rib chiqilmoqda",
              `complaint_status_${complaint.id}_IN_PROGRESS`
            ),
          ],
          [
            Markup.button.callback(
              "✅ Hal qilindi",
              `complaint_status_${complaint.id}_RESOLVED`
            ),
          ],
        ]),
      }
    );
  }
});

/* =========================================================
   ADMIN COMPLAINT STATUS
========================================================= */

bot.action(
  /^complaint_status_(\d+)_(IN_PROGRESS|RESOLVED)$/,
  async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery("Admin huquqi kerak.");
      return;
    }

    await ctx.answerCbQuery();

    const complaintId = Number(ctx.match[1]);
    const status = ctx.match[2];

    try {
      db.prepare(`
        UPDATE complaints
        SET status = ?
        WHERE id = ?
      `).run(status, complaintId);

      await ctx.reply(
        `✅ <b>Murojaat #${complaintId}</b> statusi o‘zgartirildi:\n\n` +
          `${formatStatus(status)}`,
        {
          parse_mode: "HTML",
        }
      );
    } catch (err) {
      console.error("Complaint status:", err);

      await ctx.reply(
        "❌ Statusni o‘zgartirishda xatolik."
      );
    }
  }
);

/* =========================================================
   ADMIN STATISTICS
========================================================= */

bot.hears("📊 Statistika", async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.reply("❌ Sizda admin huquqi yo‘q.");
    return;
  }

  try {
    const users = db
      .prepare("SELECT COUNT(*) AS count FROM users")
      .get().count;

    const products = db
      .prepare("SELECT COUNT(*) AS count FROM products")
      .get().count;

    const orders = db
      .prepare("SELECT COUNT(*) AS count FROM orders")
      .get().count;

    const newOrders = db
      .prepare(
        "SELECT COUNT(*) AS count FROM orders WHERE status = 'NEW'"
      )
      .get().count;

    const complaints = db
      .prepare("SELECT COUNT(*) AS count FROM complaints")
      .get().count;

    const newComplaints = db
      .prepare(
        "SELECT COUNT(*) AS count FROM complaints WHERE status = 'NEW'"
      )
      .get().count;

    await ctx.reply(
      `<b>📊 A-FARID STATISTIKA</b>\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `👥 <b>Jami foydalanuvchilar:</b> ${users}\n\n` +
        `👔 <b>Jami mahsulotlar:</b> ${products}\n\n` +
        `📦 <b>Jami zakazlar:</b> ${orders}\n` +
        `🆕 <b>Yangi zakazlar:</b> ${newOrders}\n\n` +
        `📝 <b>Jami shikoyatlar:</b> ${complaints}\n` +
        `🚨 <b>Yangi shikoyatlar:</b> ${newComplaints}\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `💾 Ma’lumotlar real SQLite bazadan olinmoqda.`,
      {
        parse_mode: "HTML",
        ...adminKeyboard(),
      }
    );
  } catch (err) {
    console.error("Statistics:", err);

    await ctx.reply(
      "❌ Statistikani olishda xatolik."
    );
  }
});

/* =========================================================
   UNKNOWN TEXT
========================================================= */

bot.on("text", async (ctx, next) => {
  const text = ctx.message.text;

  if (
    text.startsWith("/") ||
    MAIN_MENU.flat().includes(text) ||
    ADMIN_MENU.flat().includes(text) ||
    CATEGORIES.includes(text) ||
    text === "🔙 Orqaga" ||
    text === "❌ Bekor qilish"
  ) {
    return next();
  }

  if (isAdmin(ctx.from.id)) {
    await ctx.reply(
      "⚙️ Admin paneldan kerakli bo‘limni tanlang.",
      adminKeyboard()
    );
    return;
  }

  await ctx.reply(
    "👇 Iltimos, menyudagi kerakli bo‘limni tanlang.",
    mainKeyboard()
  );
});

/* =========================================================
   ERROR HANDLING
========================================================= */

bot.catch(async (err, ctx) => {
  console.error("BOT ERROR:", err);

  try {
    await ctx.reply(
      "❌ Kutilmagan xatolik yuz berdi. Iltimos, qaytadan urinib ko‘ring."
    );
  } catch (_) {}
});

/* =========================================================
   LAUNCH
========================================================= */

process.once("SIGINT", () => {
  try {
    db.close();
  } catch (_) {}

  bot.stop("SIGINT");
});

process.once("SIGTERM", () => {
  try {
    db.close();
  } catch (_) {}

  bot.stop("SIGTERM");
});

(async () => {
  try {
    await bot.telegram.deleteWebhook({
      drop_pending_updates: true,
    });

    console.log("======================================");
    console.log("✨ A-FARID STYLE TURKEY BOT");
    console.log("======================================");
    console.log("💾 Database: afarid.db");
    console.log("👨‍💼 Admin IDs:", ADMIN_IDS);
    console.log("🚀 Bot ishga tushmoqda...");

    await bot.launch();

    console.log("✅ BOT ISHLAYAPTI!");
  } catch (err) {
    console.error("❌ BOTNI ISHGA TUSHIRISHDA XATOLIK:");
    console.error(err);
    process.exit(1);
  }
})();