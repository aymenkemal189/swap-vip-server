require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════════════════════════════
// ⚙️ CONFIGURATION & ENVIRONMENT VARIABLES
// ═══════════════════════════════════════════════════════════════════
const BOT_TOKEN         = process.env.BOT_TOKEN;
const ADMIN_GROUP_ID    = process.env.ADMIN_GROUP_ID;

// 1. አዲሱ የ VIP ፋይናንስ መከታተያ Sheet Webhook URL
const VIP_SHEET_URL     = process.env.SHEET_WEBHOOK_URL || process.env.VIP_SHEET_URL;

// 2. ዋናው የ Swap Money Apps Script URL
const MAIN_SCRIPT_URL   = process.env.MAIN_SCRIPT_URL || 'https://script.google.com/macros/s/AKfycbxDii62Bjz7KNxIFY9deeDDxnjNx1ifHu93GRxkhmpC9srZ_ZFSAtQgttQYh8o1pXmIgQ/exec';

// ዋናው Apps Script ሚስጥራዊ ቁልፍ
const ADMIN_SECRET      = process.env.ADMIN_SECRET || 'SWAP_ADMIN_SECURE_2026';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const upload = multer({ dest: 'uploads/' });

// ፈጣን In-Memory Cache (አፑ በ 10 ሚሊሰከንድ ውስጥ ምላሽ እንዲያገኝ)
const liveStatusCache = {};

// ═══════════════════════════════════════════════════════════════════
// 🌉 DUAL SHEET API CALL HELPERS
// ═══════════════════════════════════════════════════════════════════

// ሀ. ከአዲሱ VIP Sheet ጋር መገናኛ
async function callVipSheet(payload) {
  if (!VIP_SHEET_URL) return null;
  try {
    const res = await fetch(VIP_SHEET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (e) {
    console.error('❌ VIP Sheet Call Error:', e.message);
    return null;
  }
}

// ለ. ከዋናው Swap Money Apps Script ጋር መገናኛ
async function callMainSheet(payload) {
  if (!MAIN_SCRIPT_URL) return null;
  try {
    const res = await fetch(MAIN_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (e) {
    console.error('❌ Main Sheet Call Error:', e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// 1. ተጠቃሚው በአፑ ላይ ክፍያ ሲልክ (SUBMIT VIP PAYMENT)
// ═══════════════════════════════════════════════════════════════════
app.post('/api/submit-vip-payment', upload.single('receiptPhoto'), async (req, res) => {
  try {
    const { userId, username, vipTier, amount, txId, fullSms, method } = req.body;
    const file = req.file;

    const tierName = String(vipTier || 'VIP').toUpperCase();
    const cleanMethod = String(method || 'Telebirr');

    // Cache ላይ Pending አድርገን እንይዛለን
    liveStatusCache[userId] = { 
      status: 'pending', 
      tier: tierName, 
      amount: amount, 
      txId: txId 
    };

    // 1. VIP Sheet ላይ መመዝገብ (ለገንዘብ ኦዲት)
    callVipSheet({
      action: 'record_pending',
      userId: userId,
      username: username || 'User',
      tier: tierName,
      amount: amount,
      method: cleanMethod,
      txId: txId || 'N/A'
    });

    // 2. ወደ ቴሌግራም አድሚን ግሩፕ መላክ
    const caption = 
      `💎 <b>አዲስ የ ${tierName} ክፍያ ጥያቄ ደርሷል!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>ተጠቃሚ:</b> @${username || 'N/A'} (ID: <code>${userId}</code>)\n` +
      `📦 <b>ጥቅል:</b> <b>${tierName}</b> (${amount} ETB)\n` +
      `🏦 <b>የክፍያ መንገድ:</b> ${cleanMethod}\n` +
      `🧾 <b>TxID:</b> <code>${txId || 'PHOTO_PROOF'}</code>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📱 <b>የ SMS መልዕክት:</b>\n<i>${fullSms ? fullSms.slice(0, 160) + '...' : 'የደረሰኝ ፎቶ ብቻ ተያይዟል'}</i>\n\n` +
      `👇 <i>ክፍያውን ካረጋገጡ በኋላ አንዱን ይምረጡ፦</i>`;

    // 🛡️ የቴሌግራም 64-byte limit እንዳይሰበር callback_data አጭር ተደርጓል
    const inlineKeyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: `✅ Approve (${amount} ETB)`, callback_data: `v_app:${userId}:${tierName}:${amount}` },
            { text: `❌ Reject`, callback_data: `v_rej:${userId}` }
          ]
        ]
      },
      parse_mode: 'HTML'
    };

    if (file) {
      await bot.sendPhoto(ADMIN_GROUP_ID, fs.createReadStream(file.path), {
        caption: caption,
        ...inlineKeyboard
      });
      fs.unlinkSync(file.path);
    } else {
      await bot.sendMessage(ADMIN_GROUP_ID, caption, inlineKeyboard);
    }

    res.json({ 
      status: 'success', 
      message: 'ክፍያዎ ወደ አድሚን ግሩፕ ተልኳል! በደቂቃዎች ውስጥ ይረጋገጣል።' 
    });

  } catch (error) {
    console.error('Submit Error:', error);
    res.status(500).json({ status: 'error', message: 'ክፍያውን ማድረስ አልተቻለም' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// 2. አድሚን በቴሌግራም ሲጫን (APPROVE / REJECT) - ⚡ ፈጣን ምላሽ
// ═══════════════════════════════════════════════════════════════════
bot.on('callback_query', async (query) => {
  const data = query.data;
  const adminTag = query.from.username ? `@${query.from.username}` : (query.from.first_name || 'Admin');

  // ─────────────────────────────────────────────────────────────
  // ✅ አድሚኑ APPROVE ሲጫን
  // ─────────────────────────────────────────────────────────────
  if (data.startsWith('v_app:')) {
    const [_, userId, tier, amount] = data.split(':');

    // ⚡ 1. መዘግየት እንዳይኖር ወዲያውኑ ለቴሌግራም ክሊክ ምላሽ መስጠት
    bot.answerCallbackQuery(query.id, { text: `✅ ${tier} ጸድቋል!` }).catch(() => {});

    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 30);
    const expiryStr = expiryDate.toISOString().split('T')[0];

    // 2. Live Cache ማዘመን (አፑ በቅጽበት ወደ PRO እንዲቀየር)
    liveStatusCache[userId] = {
      status: 'approved',
      tier: tier.toUpperCase(),
      expiry: expiryStr
    };

    // 3. የግሩፑን መልዕክት ወዲያውኑ መቀየር
    const originalText = query.message.caption || query.message.text || '';
    const updatedCaption = originalText + `\n\n✅ <b>በ ${adminTag} ጸድቋል! (APPROVED)</b>`;

    if (query.message.photo) {
      bot.editMessageCaption(updatedCaption, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'HTML'
      }).catch(() => {});
    } else {
      bot.editMessageText(updatedCaption, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'HTML'
      }).catch(() => {});
    }

    // 4. VIP Sheet ማዘመን (ለገንዘብ ኦዲት)
    callVipSheet({
      action: 'approve_vip',
      userId: userId,
      approvedBy: adminTag
    });

    // 5. 🛡️ ዋናው Sheet ላይ በ Users ሺት Col 9 (VIP_Tier) እና Col 10 ላይ መመዝገብ
    callMainSheet({
      action: 'approvevip',
      adminKey: ADMIN_SECRET,
      userId: String(userId).trim(),
      vipTier: tier.toUpperCase(),
      txId: ''
    });

    // 6. ለተጠቃሚው በቦቱ ማሳወቅ
    try {
      await bot.sendMessage(userId, 
        `🎉 <b>እንኳን ደስ አለዎት!</b>\n\n` +
        `የ <b>${tier} አባልነትዎ</b> በተሳካ ሁኔታ ጸድቋል!\n` +
        `🌟 አሁኑኑ አፑን ከፍተው በልዩ ጥቅማጥቅሞች ይደሰቱ!\n` +
        `📅 የሚያበቃበት ቀን: <b>${expiryStr}</b>`, 
        { parse_mode: 'HTML' }
      );
    } catch (e) {}
  }

  // ─────────────────────────────────────────────────────────────
  // ❌ አድሚኑ REJECT ሲጫን
  // ─────────────────────────────────────────────────────────────
  else if (data.startsWith('v_rej:')) {
    const [_, userId] = data.split(':');

    bot.answerCallbackQuery(query.id, { text: `❌ ውድቅ ተደርጓል!` }).catch(() => {});

    liveStatusCache[userId] = { status: 'rejected' };

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
    const updatedCaption = originalText + `\n\n❌ <b>በ ${adminTag} ውድቅ ተደርጓል (REJECTED)!</b>`;

    if (query.message.photo) {
      bot.editMessageCaption(updatedCaption, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'HTML'
      }).catch(() => {});
    } else {
      bot.editMessageText(updatedCaption, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'HTML'
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
});

// ═══════════════════════════════════════════════════════════════════
// 3. አፑ በጀርባ ፈጣን ሁኔታውን የሚጠይቅበት (POLLING ENDPOINT)
// ═══════════════════════════════════════════════════════════════════
app.get('/api/check-vip-status', (req, res) => {
  const userId = req.query.userId;
  const user = liveStatusCache[userId];
  if (user) {
    res.json(user);
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
    `📊 <b>SWAP MONEY VIP FINANCIAL DASHBOARD</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💰 <b>ጠቅላላ የጸደቀ ገቢ፦</b> <b>${stats.totalRevenue.toLocaleString()} ETB</b>\n` +
    `📱 <b>በ Telebirr የገባ፦</b> ${stats.telebirrTotal.toLocaleString()} ETB\n` +
    `🏦 <b>በ CBE Bank የገባ፦</b> ${stats.cbeTotal.toLocaleString()} ETB\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👑 <b>ንቁ VIP አባላት፦</b> ${stats.activeVips} ሰዎች\n` +
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Dual Sheet VIP Bridge Server running on port ${PORT}`));
