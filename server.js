/**
 * ═══════════════════════════════════════════════════════════════════
 * SWAP MONEY V4 — FAST VIP & PAYMENT API SERVER
 * Instant Submissions • Zero CORS Errors • Direct Telegram Bot Alerts
 * ═══════════════════════════════════════════════════════════════════
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const BOT_TOKEN = process.env.BOT_TOKEN || '8925694023:AAHA0DvvHAYLkXNprRaQ6eKC99AwqeX8Kbc';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '5884065141';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'SWAP_ADMIN_SECURE_2026';

// Middleware
app.use(cors()); // ሁሉንም የብሮውዘር CORS ችግር ያስቀረዋል
app.use(express.json());

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

// 🛡️ የቴሌግራም መልዕክት እንዳይዘጋ ምልክቶችን ማጣሪያ
function escapeTg(text) {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendTgMessage(chatId, text) {
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: String(chatId),
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    return true;
  } catch (err) {
    console.error('Telegram Send Error:', err.response?.data || err.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════

// Health Check
app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'Swap Money VIP Server V4' });
});

// 💎 1. ተጠቃሚው የክፍያ SMS ወይም TxID ሲልክ (SUBMIT PAYMENT)
app.post('/api/submit-payment', async (req, res) => {
  try {
    const { userId, username, vipTier, amount, txId, fullSms, method } = req.body;

    if (!userId || !txId) {
      return res.status(400).json({ status: 'error', message: 'User ID እና TxID ያስፈልጋል!' });
    }

    const db = loadDB();

    // የተደጋገመ TxID ማጣራት (Replay Protection)
    const exists = db.subscriptions.find(s => String(s.txId).trim().toLowerCase() === String(txId).trim().toLowerCase());
    if (exists) {
      return res.status(400).json({ status: 'error', message: 'ይህ የትራንዛክሽን ቁጥር (TxID) አስቀድሞ ተመዝግቧል!' });
    }

    const newOrder = {
      id: 'ORD_' + Date.now(),
      date: new Date().toISOString(),
      userId: String(userId),
      username: username || 'User',
      vipTier: (vipTier || 'PRO').toUpperCase(),
      amount: Number(amount) || 0,
      txId: String(txId).trim(),
      fullSms: fullSms || '',
      method: method || 'Telebirr/CBE',
      status: 'Pending',
      expiryDate: ''
    };

    db.subscriptions.unshift(newOrder);
    saveDB(db);

    // 🔔 ለአድሚን ቴሌግራም ላይ የማንቂያ መልዕክት መላክ
    const cleanSms = escapeTg(fullSms ? fullSms.substring(0, 150) + (fullSms.length > 150 ? '...' : '') : '');
    const alertMsg = `🔔 <b>አዲስ የክፍያ ጥያቄ ደርሷል!</b>\n\n` +
      `👤 <b>ተጠቃሚ:</b> @${escapeTg(username)} (<code>${userId}</code>)\n` +
      `💎 <b>ጥቅል:</b> ${escapeTg(vipTier)}\n` +
      `💰 <b>መጠን:</b> ${amount} ETB\n` +
      `🧾 <b>TxID:</b> <code>${escapeTg(txId)}</code>\n` +
      `🏦 <b>መንገድ:</b> ${escapeTg(method)}\n` +
      (cleanSms ? `📩 <b>SMS:</b> <i>${cleanSms}</i>\n` : '') +
      `⏳ <b>ሁኔታ:</b> በጥበቃ ላይ (Pending)\n\n` +
      `👉 <i>በዳሽቦርድ ላይ ገብተው ማጽደቅ (Approve) ይችላሉ።</i>`;

    sendTgMessage(ADMIN_CHAT_ID, alertMsg);

    res.json({
      status: 'success',
      message: 'የክፍያ ጥያቄዎ በተሳካ ሁኔታ ተልኳል! በቅርቡ ተረጋግጦ ይከፈትልዎታል',
      order: newOrder
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 📊 2. አድሚን ዳሽቦርድ ትዕዛዞችን ሲያነብ (GET ALL SUBSCRIPTIONS)
app.get('/api/subscriptions', (req, res) => {
  const db = loadDB();
  res.json({ status: 'success', subscriptions: db.subscriptions });
});

// 👑 3. አድሚኑ ክፍያን ሲያጸድቅ (APPROVE VIP)
app.post('/api/approve-vip', async (req, res) => {
  try {
    const { userId, txId, vipTier, adminKey } = req.body;

    if (adminKey !== ADMIN_SECRET) {
      return res.status(403).json({ status: 'error', message: 'Unauthorized Admin Key' });
    }

    const db = loadDB();
    const order = db.subscriptions.find(s => String(s.userId) === String(userId) && (String(s.txId) === String(txId) || !txId));

    if (!order) {
      return res.status(404).json({ status: 'error', message: 'Order not found' });
    }

    const tierToSet = (vipTier || order.vipTier || 'PRO').toUpperCase();
    const expiry = (tierToSet === 'REFERRAL_BOOSTER')
      ? new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000).toISOString()
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    order.status = 'Approved';
    order.expiryDate = expiry;

    // የተጠቃሚውን VIP መብት መመዝገብ
    db.usersVip[userId] = {
      vipTier: tierToSet,
      vipExpiry: expiry,
      approvedAt: new Date().toISOString()
    };

    saveDB(db);

    // ለተጠቃሚው በቴሌግራም መልካም ዜና መላክ
    const userMsg = `🎉 <b>እንኳን ደስ አለዎት!</b>\n\n` +
      `የ <b>${tierToSet}</b> አገልግሎትዎ በተሳካ ሁኔታ ጸድቋል!\n` +
      `🌟 አሁን አፑን በመክፈት የልዩ ጥቅማጥቅምዎ ተጠቃሚ ይሁኑ።\n` +
      `📅 የሚያበቃበት ቀን: ${new Date(expiry).toLocaleDateString()}`;

    sendTgMessage(userId, userMsg);

    res.json({ status: 'success', message: 'VIP Approved successfully', expiry });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ❌ 4. አድሚኑ ክፍያን ውድቅ ሲያደርግ (REJECT VIP)
app.post('/api/reject-vip', async (req, res) => {
  try {
    const { userId, txId, reason, adminKey } = req.body;

    if (adminKey !== ADMIN_SECRET) {
      return res.status(403).json({ status: 'error', message: 'Unauthorized Admin Key' });
    }

    const db = loadDB();
    const order = db.subscriptions.find(s => String(s.userId) === String(userId) && (String(s.txId) === String(txId) || !txId));

    if (!order) {
      return res.status(404).json({ status: 'error', message: 'Order not found' });
    }

    order.status = 'Rejected';
    saveDB(db);

    const userMsg = `⚠️ <b>የክፍያ ማሳሰቢያ</b>\n\n` +
      `የላኩት የክፍያ ማረጋገጫ ውድቅ ተደርጓል።\n` +
      `📌 <b>ምክንያት:</b> ${escapeTg(reason || 'የከፈሉበት ደረሰኝ ወይም TxID አልተገኘም')}\n` +
      `እባክዎ ትክክለኛውን ደረሰኝ ለድጋፍ ሰጪ ቡድናችን ይላኩ።`;

    sendTgMessage(userId, userMsg);

    res.json({ status: 'success', message: 'VIP rejected' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 🔍 5. ተጠቃሚው የ VIP ደረጃውን ሲፈትሽ (CHECK VIP STATUS)
app.get('/api/check-vip/:userId', (req, res) => {
  const db = loadDB();
  const vipData = db.usersVip[req.params.userId];
  const pendingOrder = db.subscriptions.find(s => String(s.userId) === String(req.params.userId) && s.status === 'Pending');

  if (vipData) {
    // ማለፉን ማጣራት
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
  console.log(`Server running on port ${PORT}`);
});
