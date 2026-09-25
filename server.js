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

// ⚙️ Environment Variables (በ Render ላይ የሚሞሉ)
const BOT_TOKEN = process.env.BOT_TOKEN; 
const ADMIN_GROUP_ID = process.env.ADMIN_GROUP_ID; // ምሳሌ: -100xxxxxxxxxx
const SHEET_WEBHOOK_URL = process.env.SHEET_WEBHOOK_URL; // ከደረጃ 1 ያገኘኸው URL

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const upload = multer({ dest: 'uploads/' });

// ፈጣን Cache (ተጠቃሚው አፕ ላይ ሲጠይቅ በ 5ms እንዲመልስለት)
const liveStatusCache = {};

// Helper: ከ Google Sheet ጋር መገናኛ
async function callSheet(payload) {
  if (!SHEET_WEBHOOK_URL) return null;
  try {
    const res = await fetch(SHEET_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (e) {
    console.error('Sheet API Error:', e.message);
    return null;
  }
}

// -------------------------------------------------------------
// 1. ከአፑ የክፍያ ጥያቄ ሲላክ (ፎቶ + SMS)
// -------------------------------------------------------------
app.post('/api/submit-vip-payment', upload.single('receiptPhoto'), async (req, res) => {
  try {
    const { userId, username, vipTier, amount, txId, fullSms, method } = req.body;
    const file = req.file;

    // Cache ላይ Pending አድርገን እንይዛለን
    liveStatusCache[userId] = { status: 'pending', tier: vipTier };

    // 1. Google Sheet ላይ "PENDING" ብሎ መመዝገብ
    callSheet({
      action: 'record_pending',
      userId: userId,
      username: username,
      tier: vipTier,
      amount: amount,
      method: method || 'Telebirr',
      txId: txId
    });

    // 2. ወደ ቴሌግራም አድሚን ግሩፕ መልዕክት መላክ
    const caption = 
      `💎 <b>አዲስ የ VIP ክፍያ ጥያቄ ደርሷል!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>ተጠቃሚ:</b> @${username || 'N/A'} (ID: <code>${userId}</code>)\n` +
      `📦 <b>የተመረጠ ጥቅል:</b> <b>${vipTier}</b> (${amount} ETB)\n` +
      `🏦 <b>የክፍያ መንገድ:</b> ${method || 'Telebirr'}\n` +
      `🧾 <b>TxID:</b> <code>${txId || 'ያልተገኘ'}</code>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📱 <b>የ SMS መልዕክት:</b>\n<i>${fullSms ? fullSms.slice(0, 150) + '...' : 'የደረሰኝ ፎቶ ብቻ ተልኳል'}</i>\n\n` +
      `👇 <i>እባክዎ ደረሰኙን አረጋግጠው አንዱን ይምረጡ፦</i>`;

    const inlineKeyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: `✅ Approve (${amount} ETB)`, callback_data: `v_app:${userId}:${vipTier}:${amount}` },
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

    res.json({ status: 'success', message: 'ክፍያዎ ወደ አድሚን ግሩፕ ተልኳል!' });

  } catch (error) {
    console.error('Submit Error:', error);
    res.status(500).json({ status: 'error', message: 'ክፍያውን ማድረስ አልተቻለም' });
  }
});

// -------------------------------------------------------------
// 2. አድሚኑ በቴሌግራም ግሩፑ ላይ ሲጫን (Approve / Reject)
// -------------------------------------------------------------
bot.on('callback_query', async (query) => {
  const data = query.data;
  const adminTag = query.from.username ? `@${query.from.username}` : (query.from.first_name || 'Admin');

  // APPROVE ሲጫን
  if (data.startsWith('v_app:')) {
    const [_, userId, tier, amount] = data.split(':');

    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 30);
    const expiryStr = expiryDate.toISOString().split('T')[0];

    // Cache ማዘመን (አፑ ወዲያው እንዲያውቀው)
    liveStatusCache[userId] = {
      status: 'approved',
      tier: tier.toUpperCase(),
      expiry: expiryStr
    };

    // Google Sheet ማዘመን
    callSheet({
      action: 'approve_vip',
      userId: userId,
      approvedBy: adminTag
    });

    // የግሩፑን መልዕክት ማዘመን
    const originalText = query.message.caption || query.message.text || '';
    const updatedCaption = originalText + `\n\n✅ <b>በ ${adminTag} ጸድቋል! (APPROVED)</b>`;

    if (query.message.photo) {
      await bot.editMessageCaption(updatedCaption, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'HTML'
      });
    } else {
      await bot.editMessageText(updatedCaption, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'HTML'
      });
    }

    // ለተጠቃሚው በቦቱ የግል ማሳወቂያ መላክ
    try {
      await bot.sendMessage(userId, 
        `🎉 <b>እንኳን ደስ አለዎት!</b>\n` +
        `የ <b>${tier} አባልነትዎ</b> በአድሚን ጸድቋል! አሁኑኑ አፑን ከፍተው በልዩ ጥቅማጥቅሞች ይደሰቱ!`, 
        { parse_mode: 'HTML' }
      );
    } catch (e) {}

    bot.answerCallbackQuery(query.id, { text: `✅ ${tier} በተሳካ ሁኔታ ጸድቋል!` });
  }

  // REJECT ሲጫን
  else if (data.startsWith('v_rej:')) {
    const [_, userId] = data.split(':');
    liveStatusCache[userId] = { status: 'rejected' };

    callSheet({
      action: 'reject_vip',
      userId: userId,
      rejectedBy: adminTag
    });

    const originalText = query.message.caption || query.message.text || '';
    const updatedCaption = originalText + `\n\n❌ <b>በ ${adminTag} ውድቅ ተደርጓል (REJECTED)!</b>`;

    if (query.message.photo) {
      await bot.editMessageCaption(updatedCaption, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'HTML'
      });
    } else {
      await bot.editMessageText(updatedCaption, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'HTML'
      });
    }

    try {
      await bot.sendMessage(userId, `⚠️ <b>ማሳሰቢያ፦</b> ያስገቡት የክፍያ ደረሰኝ ትክክል ስላልሆነ በአድሚን ውድቅ ተደርጓል።`, { parse_mode: 'HTML' });
    } catch (e) {}

    bot.answerCallbackQuery(query.id, { text: `❌ ውድቅ ተደርጓል!` });
  }
});

// -------------------------------------------------------------
// 3. አፑ በጀርባ እየጠየቀ የሚያጣራበት (Status Poller)
// -------------------------------------------------------------
app.get('/api/check-vip-status', (req, res) => {
  const userId = req.query.userId;
  const user = liveStatusCache[userId];
  if (user) {
    res.json(user);
  } else {
    res.json({ status: 'none' });
  }
});

// -------------------------------------------------------------
// 4. አድሚን ግሩፕ ውስጥ የሚሰራ /stats ወይም /dashboard Command
// -------------------------------------------------------------
bot.onText(/\/stats|\/dashboard/, async (msg) => {
  if (String(msg.chat.id) !== String(ADMIN_GROUP_ID)) return;

  const waitMsg = await bot.sendMessage(msg.chat.id, '⏳ ከ Google Sheet መረጃዎችን በማስላት ላይ...');
  const stats = await callSheet({ action: 'get_stats' });

  if (!stats || stats.status !== 'success') {
    return bot.editMessageText('❌ መረጃዎችን ከ Sheet ማምጣት አልተቻለም።', {
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
    `⚡ <i>መረጃው በቀጥታ ከኦፊሴላዊው Google Sheet የተወሰደ ነው።</i>`;

  bot.editMessageText(report, {
    chat_id: msg.chat.id,
    message_id: waitMsg.message_id,
    parse_mode: 'HTML'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 VIP Server live on port ${PORT}`));
