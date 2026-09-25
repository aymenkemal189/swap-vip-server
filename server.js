/**
 * ═══════════════════════════════════════════════════════════════════
 * SWAP MONEY V4 — TELEGRAM-NATIVE VIP & PAYMENT SERVER
 * Direct Photo Uploads • Telegram Inline [Approve/Reject] Buttons
 * Real-time Webhook Auto-Approval • Zero-Delay Dashboard API
 * ═══════════════════════════════════════════════════════════════════
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 3000;

// Configurations
const BOT_TOKEN = process.env.BOT_TOKEN || '8925694023:AAHA0DvvHAYLkXNprRaQ6eKC99AwqeX8Kbc';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '5884065141';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'SWAP_ADMIN_SECURE_2026';

// 🛡️ Middleware
app.use(cors()); // CORS ችግርን ሙሉ በሙሉ ያስቀረዋል
app.use(express.json());

// 📸 ፎቶዎችን በ Memory ውስጥ በፍጥነት ማስተናገጃ
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 } // እስከ 12MB ፎቶ ይቀበላል
});

// JSON ዳታቤዝ ፋይል ማዘጋጃ
const DB_FILE = path.join(__dirname, 'subscriptions.json');

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify({ subscriptions: [], usersVip: {} }, null, 2));
    }
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return { subscriptions: [], usersVip: {} };
  }
}

function saveDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Failed to save DB:', e);
  }
}

// 🛡️ ቴሌግራም መልዕክት እንዳይዘጋ ምልክቶችን ማጣሪያ
function escapeTg(text) {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ═══════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════

// Health Check
app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'Swap Money VIP Telegram Server V4' });
});

// 💎 1. ተጠቃሚው ክፍያ ሲልክ (ፎቶ እና SMS በአንድ ላይ ይቀበላል)
app.post('/api/submit-payment', upload.single('screenshot'), async (req, res) => {
  try {
    const { userId, username, vipTier, amount, txId, fullSms, method } = req.body;

    if (!userId || !txId) {
      return res.status(400).json({ status: 'error', message: 'User ID እና TxID ያስፈልጋል!' });
    }

    const db = loadDB();

    // የተደጋገመ TxID ማጣራት (Replay Attack Protection)
    const exists = db.subscriptions.find(s => String(s.txId).trim().toLowerCase() === String(txId).trim().toLowerCase());
    if (exists) {
      return res.status(400).json({ status: 'error', message: 'ይህ የትራንዛክሽን ቁጥር (TxID) አስቀድሞ ተመዝግቧል!' });
    }

    const orderId = 'ORD_' + Date.now();
    const newOrder = {
      id: orderId,
      date: new Date().toISOString(),
      userId: String(userId),
      username: username || 'User',
      vipTier: (vipTier || 'PRO').toUpperCase(),
      amount: Number(amount) || 0,
      txId: String(txId).trim(),
      fullSms: fullSms || '',
      method: method || 'Telebirr/CBE',
      status: 'Pending',
      expiryDate: '',
      hasPhoto: !!req.file
    };

    db.subscriptions.unshift(newOrder);
    saveDB(db);

    // 📱 ወደ ቴሌግራም ግሩፕ/አካውንት የሚላክ የመልዕክት ዝግጅት
    const cleanSms = escapeTg(fullSms ? fullSms.substring(0, 160) + (fullSms.length > 160 ? '...' : '') : '');
    const captionText = `💎 <b>አዲስ የክፍያ ጥያቄ ደርሷል!</b>\n\n` +
      `👤 <b>ተጠቃሚ:</b> @${escapeTg(username)} (<code>${userId}</code>)\n` +
      `📦 <b>ጥቅል:</b> <b>${escapeTg(newOrder.vipTier)}</b>\n` +
      `💰 <b>የተከፈለ መጠን:</b> <b>${newOrder.amount} ETB</b>\n` +
      `🧾 <b>TxID:</b> <code>${escapeTg(newOrder.txId)}</code>\n` +
      `🏦 <b>መንገድ:</b> ${escapeTg(newOrder.method)}\n` +
      (cleanSms ? `📩 <b>SMS:</b> <i>${cleanSms}</i>\n` : '') +
      `⏳ <b>ሁኔታ:</b> በጥበቃ ላይ (Pending)\n\n` +
      `👇 <i>ከስር ባሉት አዝራሮች በቀጥታ ማጽደቅ ይችላሉ፦</i>`;

    // 🔘 በቴሌግራም ውስጥ በቀጥታ የሚጫኑ አዝራሮች (Inline Keyboard)
    const replyMarkup = {
      inline_keyboard: [
        [
          { text: `✅ Approve (${newOrder.amount} ETB)`, callback_data: `appr_${orderId}` },
          { text: '❌ Reject', callback_data: `rej_${orderId}` }
        ]
      ]
    };

    // ፎቶ ካለው ፎቶውን ከነ አዝራሩ ይልካል፤ ካልሆነ ጽሁፉን ከነ አዝራሩ ይልካል
    if (req.file) {
      const form = new FormData();
      form.append('chat_id', ADMIN_CHAT_ID);
      form.append('photo', req.file.buffer, { filename: 'screenshot.jpg' });
      form.append('caption', captionText);
      form.append('parse_mode', 'HTML');
      form.append('reply_markup', JSON.stringify(replyMarkup));

      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, form, {
        headers: form.getHeaders()
      }).catch(e => console.error('Telegram Photo Error:', e.response?.data || e.message));
    } else {
      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: ADMIN_CHAT_ID,
        text: captionText,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: replyMarkup
      }).catch(e => console.error('Telegram Msg Error:', e.response?.data || e.message));
    }

    res.json({
      status: 'success',
      message: 'የክፍያ ጥያቄዎ በተሳካ ሁኔታ ተልኳል! በቅርቡ ተረጋግጦ ይከፈትልዎታል',
      order: newOrder
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ⚡ 2. ቴሌግራም ላይ አድሚኑ [Approve] ወይም [Reject] ሲጫን ወዲያውኑ የሚፈጽም (WEBHOOK)
app.post('/api/telegram-webhook', async (req, res) => {
  try {
    const update = req.body;

    if (update && update.callback_query) {
      const query = update.callback_query;
      const data = query.data || '';
      const message = query.message;
      const callbackQueryId = query.id;

      const db = loadDB();

      // አድሚኑ Approve ሲል
      if (data.startsWith('appr_')) {
        const orderId = data.replace('appr_', '');
        const order = db.subscriptions.find(s => s.id === orderId);

        if (order) {
          const tier = order.vipTier || 'PRO';
          const expiry = (tier === 'REFERRAL_BOOSTER')
            ? new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000).toISOString()
            : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

          order.status = 'Approved';
          order.expiryDate = expiry;

          // ተጠቃሚውን VIP ማድረግ
          db.usersVip[order.userId] = {
            vipTier: tier,
            vipExpiry: expiry,
            approvedAt: new Date().toISOString()
          };
          saveDB(db);

          // 1. ለተጠቃሚው በቦቱ የማብሰሪያ መልዕክት መላክ
          const userMsg = `🎉 <b>እንኳን ደስ አለዎት!</b>\n\n` +
            `የ <b>${tier}</b> አባልነትዎ በአድሚን ጸድቋል!\n` +
            `🌟 አሁን አፑን በመክፈት የልዩ ጥቅማጥቅምዎ ተጠቃሚ ይሁኑ።\n` +
            `📅 የሚያበቃበት ቀን: ${new Date(expiry).toLocaleDateString()}`;

          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: order.userId,
            text: userMsg,
            parse_mode: 'HTML'
          }).catch(() => {});

          // 2. በቴሌግራም ግሩፑ ላይ የመጣውን መልዕክት ወደ "APPROVED" መቀየር
          const updatedCaption = `✅ <b>ክፍያው ጸድቋል (APPROVED)!</b>\n\n` +
            `👤 <b>ተጠቃሚ:</b> @${escapeTg(order.username)} (<code>${order.userId}</code>)\n` +
            `💎 <b>ጥቅል:</b> ${order.vipTier}\n` +
            `💰 <b>መጠን:</b> ${order.amount} ETB\n` +
            `🧾 <b>TxID:</b> <code>${order.txId}</code>\n` +
            `📅 <b>የሚያበቃበት:</b> ${new Date(expiry).toLocaleDateString()}\n` +
            `✔️ <i>በአድሚን @Agent1hulubet ጸድቋል።</i>`;

          if (message.photo) {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageCaption`, {
              chat_id: message.chat.id,
              message_id: message.message_id,
              caption: updatedCaption,
              parse_mode: 'HTML'
            }).catch(() => {});
          } else {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
              chat_id: message.chat.id,
              message_id: message.message_id,
              text: updatedCaption,
              parse_mode: 'HTML'
            }).catch(() => {});
          }

          // ለቴሌግራም ስክሪን መልስ መስጠት
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: callbackQueryId,
            text: `✅ ${tier} VIP በተሳካ ሁኔታ ጸድቋል!`,
            show_alert: true
          }).catch(() => {});
        }
      }

      // አድሚኑ Reject ሲል
      else if (data.startsWith('rej_')) {
        const orderId = data.replace('rej_', '');
        const order = db.subscriptions.find(s => s.id === orderId);

        if (order) {
          order.status = 'Rejected';
          saveDB(db);

          const userMsg = `⚠️ <b>የክፍያ ማሳሰቢያ</b>\n\n` +
            `የላኩት የክፍያ ማረጋገጫ (TxID: ${order.txId}) ውድቅ ተደርጓል።\n` +
            `እባክዎ ትክክለኛውን ደረሰኝ ለድጋፍ ሰጪ ቡድናችን ይላኩ።`;

          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: order.userId,
            text: userMsg,
            parse_mode: 'HTML'
          }).catch(() => {});

          const updatedCaption = `❌ <b>ክፍያው ውድቅ ተደርጓል (REJECTED)!</b>\n\n` +
            `👤 <b>ተጠቃሚ:</b> @${escapeTg(order.username)} (<code>${order.userId}</code>)\n` +
            `💰 <b>መጠን:</b> ${order.amount} ETB\n` +
            `🧾 <b>TxID:</b> <code>${order.txId}</code>`;

          if (message.photo) {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageCaption`, {
              chat_id: message.chat.id,
              message_id: message.message_id,
              caption: updatedCaption,
              parse_mode: 'HTML'
            }).catch(() => {});
          } else {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
              chat_id: message.chat.id,
              message_id: message.message_id,
              text: updatedCaption,
              parse_mode: 'HTML'
            }).catch(() => {});
          }

          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: callbackQueryId,
            text: '❌ ክፍያው ውድቅ ተደርጓል!',
            show_alert: true
          }).catch(() => {});
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook Error:', err);
    res.sendStatus(200);
  }
});

// 🌐 3. Webhook በአንድ ክሊክ ማገናኛ (One-Click Webhook Setup)
app.get('/setup-webhook', async (req, res) => {
  try {
    const fullUrl = `${req.protocol}://${req.get('host')}/api/telegram-webhook`;
    const tgRes = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(fullUrl)}`);
    res.json({
      status: 'success',
      message: 'Telegram Webhook connected successfully!',
      webhookUrl: fullUrl,
      telegramResponse: tgRes.data
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 📊 4. ዳሽቦርድ ትዕዛዞችን ሲያመጣ (GET SUBSCRIPTIONS)
app.get('/api/subscriptions', (req, res) => {
  const db = loadDB();
  res.json({ status: 'success', subscriptions: db.subscriptions });
});

// 👑 5. ዳሽቦርድ ላይ ሆኖ Approve ሲደረግ
app.post('/api/approve-vip', async (req, res) => {
  try {
    const { userId, txId, vipTier, adminKey } = req.body;

    if (adminKey !== ADMIN_SECRET) {
      return res.status(403).json({ status: 'error', message: 'Unauthorized Admin Key' });
    }

    const db = loadDB();
    const order = db.subscriptions.find(s => String(s.userId) === String(userId) && (String(s.txId) === String(txId) || !txId));

    if (!order) return res.status(404).json({ status: 'error', message: 'Order not found' });

    const tierToSet = (vipTier || order.vipTier || 'PRO').toUpperCase();
    const expiry = (tierToSet === 'REFERRAL_BOOSTER')
      ? new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000).toISOString()
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    order.status = 'Approved';
    order.expiryDate = expiry;
    db.usersVip[userId] = { vipTier: tierToSet, vipExpiry: expiry, approvedAt: new Date().toISOString() };
    saveDB(db);

    const userMsg = `🎉 <b>እንኳን ደስ አለዎት!</b>\n\nየ <b>${tierToSet}</b> አገልግሎትዎ ጸድቋል!\n📅 የሚያበቃበት ቀን: ${new Date(expiry).toLocaleDateString()}`;
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: userId, text: userMsg, parse_mode: 'HTML' }).catch(() => {});

    res.json({ status: 'success', message: 'VIP Approved', expiry });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ❌ 6. ዳሽቦርድ ላይ ሆኖ Reject ሲደረግ
app.post('/api/reject-vip', async (req, res) => {
  try {
    const { userId, txId, reason, adminKey } = req.body;

    if (adminKey !== ADMIN_SECRET) {
      return res.status(403).json({ status: 'error', message: 'Unauthorized Admin Key' });
    }

    const db = loadDB();
    const order = db.subscriptions.find(s => String(s.userId) === String(userId) && (String(s.txId) === String(txId) || !txId));

    if (!order) return res.status(404).json({ status: 'error', message: 'Order not found' });

    order.status = 'Rejected';
    saveDB(db);

    const userMsg = `⚠️ <b>የክፍያ ማሳሰቢያ</b>\n\nየላኩት ክፍያ ውድቅ ተደርጓል።\n📌 ምክንያት: ${reason || 'ደረሰኝ አልተገኘም'}`;
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: userId, text: userMsg, parse_mode: 'HTML' }).catch(() => {});

    res.json({ status: 'success', message: 'VIP Rejected' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 🔍 7. ተጠቃሚው አፑን ሲከፍት VIP ደረጃውን ማረጋገጫ (CHECK VIP)
app.get('/api/check-vip/:userId', (req, res) => {
  const db = loadDB();
  const vipData = db.usersVip[req.params.userId];
  const pendingOrder = db.subscriptions.find(s => String(s.userId) === String(req.params.userId) && s.status === 'Pending');

  if (vipData) {
    if (new Date(vipData.vipExpiry) < new Date()) {
      return res.json({ vipTier: 'None', isVip: false, isPending: false });
    }
    return res.json({ ...vipData, isVip: true, isPending: false });
  }

  res.json({
    vipTier: 'None',
    isVip: false,
    isPending: !!pendingOrder,
    pendingOrder: pendingOrder || null
  });
});

app.listen(PORT, () => {
  console.log(`Swap VIP Server listening on port ${PORT}`);
});
