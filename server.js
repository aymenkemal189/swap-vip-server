require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json({ limit: '100kb' }));

// ═══════════════════════════════════════════════════════════════════
// ⚙️ CONFIGURATION & ENVIRONMENT VARIABLES
// ═══════════════════════════════════════════════════════════════════
const BOT_TOKEN         = process.env.BOT_TOKEN;
const ADMIN_GROUP_ID    = process.env.ADMIN_GROUP_ID;

// 1. የ VIP ፋይናንስ መከታተያ Sheet Webhook URL
const VIP_SHEET_URL     = process.env.SHEET_WEBHOOK_URL || process.env.VIP_SHEET_URL;

// 2. ዋናው የ Swap Money Apps Script URL
const MAIN_SCRIPT_URL   = process.env.MAIN_SCRIPT_URL || 'https://script.google.com/macros/s/AKfycbxDii62Bjz7KNxIFY9deeDDxnjNx1ifHu93GRxkhmpC9srZ_ZFSAtQgttQYh8o1pXmIgQ/exec';

// ዋናው Apps Script ሚስጥራዊ ቁልፍ
const ADMIN_SECRET      = process.env.ADMIN_SECRET || 'SWAP_ADMIN_SECURE_2026';

// 🔧 Resource መቆጣጠሪያ ቅንብሮች
const MAX_UPLOAD_BYTES   = 3 * 1024 * 1024;        // የፎቶ ገደብ 3MB
const CACHE_TTL_MS       = 24 * 60 * 60 * 1000;    // Cache ለ 24 ሰዓት ብቻ
const CACHE_CLEAN_EVERY  = 30 * 60 * 1000;         // በየ 30 ደቂቃ ማጽዳት
const CACHE_MAX_ENTRIES  = 5000;                   // ከፍተኛው የ Cache ብዛት
const SHEET_TIMEOUT_MS   = 15000;                  // Sheet ጥሪ ከ 15 ሰከንድ በላይ እንዳይጠብቅ
const STATUS_LIMIT_MAX   = 12;                     // በደቂቃ ከአንድ IP ከፍተኛ ጥያቄ
const STATUS_LIMIT_WINDOW = 60 * 1000;

// Polling ቀለል ባለ መልኩ (long-polling 50 ሰከንድ)
const bot = new TelegramBot(BOT_TOKEN, {
  polling: { interval: 1000, autoStart: true, params: { timeout: 50 } }
});

bot.on('polling_error', (err) => {
  // ተመሳሳይ ስህተት log እንዳያጨናንቅ በአጭሩ ብቻ
  console.error('⚠️ Polling error:', err.code || err.message);
});

// 🛡️ ፎቶውን በ Memory (RAM) ለመያዝ
const storage = multer.memoryStorage();
const upload = multer({ storage: storage, limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

// ፈጣን In-Memory Cache (ከ timestamp ጋር)
const liveStatusCache = {};

function setStatus(userId, data) {
  // Cache ከሞላ አሮጌውን አውጣ
  const keys = Object.keys(liveStatusCache);
  if (keys.length >= CACHE_MAX_ENTRIES) {
    keys.sort((a, b) => liveStatusCache[a].ts - liveStatusCache[b].ts);
    for (let i = 0; i < Math.ceil(CACHE_MAX_ENTRIES * 0.1); i++) delete liveStatusCache[keys[i]];
  }
  liveStatusCache[userId] = { ...data, ts: Date.now() };
}

// የቆዩ ግቤቶችን በየጊዜው ማጽዳት
setInterval(() => {
  const now = Date.now();
  for (const k of Object.keys(liveStatusCache)) {
    if (now - (liveStatusCache[k].ts || 0) > CACHE_TTL_MS) delete liveStatusCache[k];
  }
}, CACHE_CLEAN_EVERY).unref();

// 🚦 ቀላል Rate Limiter (ተጨማሪ package አያስፈልግም)
const hits = new Map();
function statusRateLimiter(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.start > STATUS_LIMIT_WINDOW) {
    hits.set(ip, { start: now, count: 1 });
    return next();
  }
  rec.count++;
  if (rec.count > STATUS_LIMIT_MAX) {
    return res.status(429).json({ status: 'rate_limited' });
  }
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of hits) {
    if (now - rec.start > STATUS_LIMIT_WINDOW) hits.delete(ip);
  }
}, 5 * 60 * 1000).unref();

// 💎 የፓኬጆች ዝርዝር መረጃ እና ጥቅሞች
const PACKAGE_METADATA = {
  'FOUNDERS_PASS': {
    title: '👑 Lifetime Founders Pass',
    isLifetime: true,
    perk: '4X Multiplier ለዘላለም + ቅድሚያ የሚሰጠው ፈጣን ክፍያ'
  },
  'AGENT_LICENSE': {
    title: '💼 Official Agent License',
    isLifetime: true,
    perk: '50% የዕድሜ ልክ ኮሚሽን (Lifetime Commission)'
  },
  'MEGA_BUNDLE': {
    title: '📦 All-in-One Mega Bundle',
    isLifetime: false,
    perk: '1-ወር VIP + 10 የዕድል ሳጥን + 1 Express ክፍያ'
  },
  'THRESHOLD_BREAKER': {
    title: '🔓 Threshold Breaker Pass',
    isLifetime: true,
    perk: 'ዝቅተኛው የማውጫ ገደብ ወደ 1,000 ብር ዝቅ ብሏል'
  },
  'AUTO_MINER': {
    title: '⚙️ Auto-Pilot Ad Miner Pass',
    isLifetime: false,
    perk: 'በቀን 30 ማስታወቂያ በራሱ-ሰር የሚያይ'
  },
  'GOLDEN_TICKET': {
    title: '🎫 No-Loss Golden Ticket',
    isLifetime: false,
    perk: 'ሳምንታዊ የዕጣ ውድድር + 1-ወር VIP'
  },
  'PRO': {
    title: '🥈 PRO Tier Upgrade',
    isLifetime: false,
    perk: '2X ማስታወቂያ + 75 ETB ሪፈራል'
  },
  'VIP': {
    title: '👑 VIP Tier Upgrade',
    isLifetime: false,
    perk: '4X ማስታወቂያ + 2 ሰው ብቻ መጋበዝ + 24hr ክፍያ'
  },
  'PREMIUM': {
    title: '💎 PREMIUM Tier Upgrade',
    isLifetime: false,
    perk: '8X ማስታወቂያ + 0 ሰው መጋበዝ + ቅጽበታዊ ክፍያ'
  }
};

// የመነሻ ገጽ (Render health check ላይም ያገለግላል)
app.get('/', (req, res) => {
  res.send('🚀 Swap Money V4.5 VIP & High-Ticket Bridge Server is Live and Running!');
});

// ═══════════════════════════════════════════════════════════════════
// 🌉 DUAL SHEET API CALL HELPERS
// ═══════════════════════════════════════════════════════════════════
async function callVipSheet(payload) {
  if (!VIP_SHEET_URL) return null;
  try {
    const res = await fetch(VIP_SHEET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeout: SHEET_TIMEOUT_MS
    });
    return await res.json();
  } catch (e) {
    console.error('❌ VIP Sheet Call Error:', e.message);
    return null;
  }
}

async function callMainSheet(payload) {
  if (!MAIN_SCRIPT_URL) return null;
  try {
    const res = await fetch(MAIN_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      timeout: SHEET_TIMEOUT_MS
    });
    return await res.json();
  } catch (e) {
    console.error('❌ Main Sheet Call Error:', e.message);
    return null;
  }
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ═══════════════════════════════════════════════════════════════════
// 1. ተጠቃሚው ክፍያ ሲልክ (SUBMIT VIP / HIGH-TICKET PAYMENT)
// ═══════════════════════════════════════════════════════════════════
app.post('/api/submit-vip-payment', (req, res, next) => {
  upload.single('receiptPhoto')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'ፎቶው ከ 3MB መብለጥ የለበትም'
        : 'ፋይሉን መቀበል አልተቻለም';
      return res.status(400).json({ status: 'error', message: msg });
    }
    next();
  });
}, async (req, res) => {
  try {
    const { userId, username, vipTier, amount, txId, fullSms, method } = req.body;
    const file = req.file;

    if (!userId) {
      return res.status(400).json({ status: 'error', message: 'userId ያስፈልጋል' });
    }

    const tierKey = String(vipTier || 'VIP').toUpperCase();
    const pkgInfo = PACKAGE_METADATA[tierKey] || { title: `${tierKey} Package`, perk: 'ልዩ ጥቅማጥቅሞች' };
    const cleanMethod = String(method || 'Telebirr');

    // 1. Cache ላይ Pending ማድረግ
    setStatus(userId, {
      status: 'pending',
      tier: tierKey,
      amount: amount,
      txId: txId
    });

    // 2. VIP Sheet ላይ መመዝገብ
    callVipSheet({
      action: 'record_pending',
      userId: userId,
      username: username || 'User',
      tier: tierKey,
      amount: amount,
      method: cleanMethod,
      txId: txId || 'N/A'
    });

    // 3. ወደ ቴሌግራም አድሚን ግሩፕ የሚላክ መልዕክት ማዘጋጀት
    const smsText = fullSms
      ? escapeHtml(String(fullSms).slice(0, 160)) + (String(fullSms).length > 160 ? '...' : '')
      : 'የደረሰኝ ፎቶ ብቻ ተያይዟል';

    const caption =
      `💎 <b>አዲስ የክፍያ ጥያቄ ደርሷል!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>ተጠቃሚ:</b> @${escapeHtml(username || 'N/A')} (ID: <code>${escapeHtml(userId)}</code>)\n` +
      `📦 <b>የተመረጠው ፓኬጅ:</b> <b>${pkgInfo.title}</b>\n` +
      `💰 <b>መጠን:</b> <b>${escapeHtml(amount)} ETB</b>\n` +
      `🏦 <b>የክፍያ መንገድ:</b> ${escapeHtml(cleanMethod)}\n` +
      `🧾 <b>TxID:</b> <code>${escapeHtml(txId || 'PHOTO_PROOF')}</code>\n` +
      `✨ <b>ጥቅም:</b> <i>${pkgInfo.perk}</i>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📱 <b>የ SMS መልዕክት:</b>\n<i>${smsText}</i>\n\n` +
      `👇 <i>ክፍያውን ካረጋገጡ በኋላ አንዱን ይምረጡ፦</i>`;

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: `✅ Approve (${amount} ETB)`, callback_data: `v_app:${userId}:${tierKey}:${amount}` },
          { text: `❌ Reject`, callback_data: `v_rej:${userId}` }
        ]
      ]
    };

    // 4. ቴሌግራም ላይ ፎቶውን መላክ (ከነ Fail-Safe መከላከያው)
    let sentSuccess = false;

    if (file && file.buffer) {
      try {
        await bot.sendPhoto(ADMIN_GROUP_ID, file.buffer, {
          caption: caption,
          parse_mode: 'HTML',
          reply_markup: inlineKeyboard
        }, {
          filename: 'receipt.jpg',
          contentType: file.mimetype || 'image/jpeg'
        });
        sentSuccess = true;
      } catch (photoErr) {
        console.error('⚠️ Photo send failed, trying text fallback:', photoErr.message);
      }
    }

    if (!sentSuccess) {
      await bot.sendMessage(ADMIN_GROUP_ID, caption, {
        parse_mode: 'HTML',
        reply_markup: inlineKeyboard
      });
    }

    res.json({
      status: 'success',
      message: 'ክፍያዎ ወደ አድሚን ግሩፕ ተልኳል! በደቂቃዎች ውስጥ ይረጋገጣል።'
    });

  } catch (error) {
    console.error('Submit Error:', error.response?.body || error.message);
    res.status(500).json({ status: 'error', message: 'ክፍያውን ማድረስ አልተቻለም' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 2. አድሚን ሲያጸድቅ ወይም ውድቅ ሲያደርግ (CALLBACK QUERY)
// ═══════════════════════════════════════════════════════════════════
bot.on('callback_query', async (query) => {
  try {
    const data = query.data || '';

    // ከአድሚን ግሩፕ ውጭ የመጣ ጥያቄን ችላ በል (ደህንነት)
    if (!query.message || String(query.message.chat.id) !== String(ADMIN_GROUP_ID)) {
      return bot.answerCallbackQuery(query.id).catch(() => {});
    }

    const adminTag = query.from.username ? `@${query.from.username}` : (query.from.first_name || 'Admin');

    if (data.startsWith('v_app:')) {
      const [, userId, tierKey, amount] = data.split(':');
      const pkg = PACKAGE_METADATA[tierKey] || { title: tierKey, isLifetime: false, perk: '' };

      // ተመሳሳይ ጥያቄ ሁለት ጊዜ እንዳይጸድቅ
      if (liveStatusCache[userId]?.status === 'approved') {
        return bot.answerCallbackQuery(query.id, { text: 'ይህ ቀደም ብሎ ጸድቋል!' }).catch(() => {});
      }

      bot.answerCallbackQuery(query.id, { text: `✅ ${pkg.title} ጸድቋል!` }).catch(() => {});

      // Lifetime እና Monthly አያያዝ
      let expiryStr = 'LIFETIME';
      if (!pkg.isLifetime) {
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + 30);
        expiryStr = expiryDate.toISOString().split('T')[0];
      }

      setStatus(userId, {
        status: 'approved',
        tier: tierKey,
        expiry: expiryStr
      });

      const originalText = query.message.caption || query.message.text || '';
      const updatedCaption = originalText + `\n\n✅ በ ${adminTag} ጸድቋል! (APPROVED)`;

      if (query.message.photo) {
        bot.editMessageCaption(updatedCaption, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id
        }).catch(() => {});
      } else {
        bot.editMessageText(updatedCaption, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id
        }).catch(() => {});
      }

      callVipSheet({
        action: 'approve_vip',
        userId: userId,
        tier: tierKey,
        expiry: expiryStr,
        approvedBy: adminTag
      });

      callMainSheet({
        action: 'approvevip',
        adminKey: ADMIN_SECRET,
        userId: String(userId).trim(),
        vipTier: tierKey,
        expiry: expiryStr,
        txId: ''
      });

      // ለተጠቃሚው የሚላክ የተሟላ ማስታወቂያ
      try {
        const expiryNotice = pkg.isLifetime
          ? `📅 የአባልነት ጊዜ፦ <b>የዕድሜ ልክ (Lifetime - አያልቅም!)</b>`
          : `📅 የሚያበቃበት ቀን፦ <b>${expiryStr} (ለ 30 ቀናት)</b>`;

        await bot.sendMessage(userId,
          `🎉 <b>እንኳን ደስ አለዎት!</b>\n\n` +
          `የ <b>${pkg.title}</b> ክፍያዎ በተሳካ ሁኔታ ጸድቋል!\n` +
          `✨ <b>የነቃ ጥቅማጥቅም፦</b> ${pkg.perk}\n` +
          `${expiryNotice}\n\n` +
          `🌟 አሁኑኑ አፑን ከፍተው አዳዲስ ጥቅማጥቅሞችዎን መጠቀም ይችላሉ!`,
          { parse_mode: 'HTML' }
        );
      } catch (e) {
        console.error('User Notify Error:', e.message);
      }
    }

    else if (data.startsWith('v_rej:')) {
      const [, userId] = data.split(':');

      bot.answerCallbackQuery(query.id, { text: `❌ ውድቅ ተደርጓል!` }).catch(() => {});

      setStatus(userId, { status: 'rejected' });

      callVipSheet({
        action: 'reject_vip',
        userId: userId,
        rejectedBy: adminTag
      });

      callMainSheet({
        action: 'rejectvip',
        adminKey: ADMIN_SECRET,
        userId: userId,
        reason: 'የላኩት ደረሰኝ ወይም TxID ትክክል አይደለም'
      });

      const originalText = query.message.caption || query.message.text || '';
      const updatedCaption = originalText + `\n\n❌ በ ${adminTag} ውድቅ ተደርጓል (REJECTED)!`;

      if (query.message.photo) {
        bot.editMessageCaption(updatedCaption, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id
        }).catch(() => {});
      } else {
        bot.editMessageText(updatedCaption, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id
        }).catch(() => {});
      }

      try {
        await bot.sendMessage(userId,
          `⚠️ <b>የክፍያ ማሳሰቢያ፦</b>\n` +
          `ያስገቡት የክፍያ ደረሰኝ ወይም TxID ትክክል ስላልሆነ በአድሚን ውድቅ ተደርጓል። እባክዎ ትክክለኛውን ደረሰኝ ይላኩ።`,
          { parse_mode: 'HTML' }
        );
      } catch (e) {}
    }
  } catch (err) {
    console.error('Callback Error:', err.message);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 3. አፑ በጀርባ ፈጣን ሁኔታውን የሚጠይቅበት (POLLING ENDPOINT)
// ═══════════════════════════════════════════════════════════════════
app.get('/api/check-vip-status', statusRateLimiter, (req, res) => {
  const userId = req.query.userId;
  const user = liveStatusCache[userId];
  if (user) {
    const { ts, ...publicData } = user;
    res.json(publicData);
  } else {
    res.json({ status: 'none' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 4. በቴሌግራም አድሚን ግሩፕ ውስጥ የሚሰራ /stats ሪፖርት
// ═══════════════════════════════════════════════════════════════════
bot.onText(/\/stats|\/dashboard/, async (msg) => {
  if (String(msg.chat.id) !== String(ADMIN_GROUP_ID)) return;

  const waitMsg = await bot.sendMessage(msg.chat.id, '⏳ ከ Google Sheet መረጃዎችን በማስላት ላይ...');
  const stats = await callVipSheet({ action: 'get_stats' });

  if (!stats || stats.status !== 'success') {
    return bot.editMessageText('❌ መረጃዎችን ከ VIP Sheet ማምጣት አልተቻለም።', {
      chat_id: msg.chat.id,
      message_id: waitMsg.message_id
    });
  }

  const report =
    `📊 <b>SWAP MONEY V4.5 FINANCIAL DASHBOARD</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💰 <b>ጠቅላላ የጸደቀ ገቢ፦</b> <b>${stats.totalRevenue.toLocaleString()} ETB</b>\n` +
    `📱 <b>በ Telebirr የገባ፦</b> ${stats.telebirrTotal.toLocaleString()} ETB\n` +
    `🏦 <b>በ CBE Bank የገባ፦</b> ${stats.cbeTotal.toLocaleString()} ETB\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👑 <b>ንቁ አባላት፦</b> ${stats.activeVips} ሰዎች\n` +
    `⏳ <b>በጥበቃ ላይ ያሉ፦</b> ${stats.pendingCount} ጥያቄዎች\n` +
    `❌ <b>ውድቅ የተደረጉ፦</b> ${stats.rejectedCount} ጥያቄዎች\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⚡ <i>መረጃው በቀጥታ ከኦፊሴላዊው የ VIP Sheet የተወሰደ ነው።</i>`;

  bot.editMessageText(report, {
    chat_id: msg.chat.id,
    message_id: waitMsg.message_id,
    parse_mode: 'HTML'
  });
});

// ═══════════════════════════════════════════════════════════════════
// 🛑 Graceful shutdown (Render ሲያድስ 409 Conflict እንዳይፈጠር)
// ═══════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`🚀 Dual Sheet VIP Bridge Server running on port ${PORT}`));

function shutdown() {
  bot.stopPolling().catch(() => {}).finally(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
