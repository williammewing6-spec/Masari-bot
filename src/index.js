// ============================================================
//  Masari (مصاري) — Telegram microtask marketplace bot
//  Cloudflare Worker + D1. One bot, three roles: worker / client / admin.
//  ALL content (categories, tasks, prices, texts, percentages) is
//  admin-managed from inside the bot. Nothing is hard-coded per category.
// ============================================================

const now = () => Math.floor(Date.now() / 1000);
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
// Accepts Arabic-Indic digits (١٢٣) too — users type them all the time.
const parseNum = (s) => {
  const t = String(s ?? '').replace(/[٠-٩]/g, (c) => '٠١٢٣٤٥٦٧٨٩'.indexOf(c)).replace(/[^0-9-]/g, '');
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : 0;
};
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------- Telegram API ----------
let _tok = null;
async function botToken(env) {
  if (_tok) return _tok;
  try {
    const row = await one(env, "SELECT value FROM settings WHERE key='bot_token'");
    if (row && row.value) { _tok = row.value; return _tok; }
  } catch (e) { /* settings table not ready yet */ }
  _tok = env.BOT_TOKEN || '';
  return _tok;
}

async function tg(env, method, body = {}) {
  try {
    const token = await botToken(env);
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await r.json().catch(() => ({ ok: false }));
  } catch (e) {
    return { ok: false }; // a Telegram network hiccup must never crash the update
  }
}
const send = (env, chat, text, kb) =>
  tg(env, 'sendMessage', { chat_id: chat, text, parse_mode: 'HTML', reply_markup: kb, disable_web_page_preview: true });
const edit = (env, chat, mid, text, kb) =>
  tg(env, 'editMessageText', { chat_id: chat, message_id: mid, text, parse_mode: 'HTML', reply_markup: kb, disable_web_page_preview: true });
const answerCb = (env, id, text = '') => tg(env, 'answerCallbackQuery', { callback_query_id: id, text });

// ---------- DB helpers ----------
const q = (env, sql, ...p) => env.DB.prepare(sql).bind(...p);
const one = async (env, sql, ...p) => q(env, sql, ...p).first();
const all = async (env, sql, ...p) => (await q(env, sql, ...p).all()).results || [];
const run = (env, sql, ...p) => q(env, sql, ...p).run();

async function setting(env, key, dflt = '') {
  const r = await one(env, 'SELECT value FROM settings WHERE key=?', key);
  return r ? r.value : dflt;
}
const setSetting = (env, key, value) =>
  run(env, 'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value));

async function getUser(env, id) { return one(env, 'SELECT * FROM users WHERE tg_id=?', id); }
async function ensureUser(env, from, refId = null) {
  let u = await getUser(env, from.id);
  if (!u) {
    await run(env, 'INSERT INTO users(tg_id,name,username,referrer_id,created_at) VALUES(?,?,?,?,?)',
      from.id, `${from.first_name || ''} ${from.last_name || ''}`.trim(), from.username || '', refId, now());
    u = await getUser(env, from.id);
    if (refId) {
      const every = parseNum(await setting(env, 'ref_milestone_every', '0'));
      const bonus = parseNum(await setting(env, 'ref_milestone_bonus', '0'));
      if (every > 0 && bonus > 0) {
        const c = await one(env, 'SELECT COUNT(*) n FROM users WHERE referrer_id=?', refId);
        if (c.n > 0 && c.n % every === 0) {
          await addBalance(env, refId, bonus, 'referral', 'milestone');
          await send(env, refId, `🎉 <b>مكافأة مرحلة إحالة!</b>\nصار عندك ${c.n} إحالة — انضاف لرصيدك ${fmt(bonus)} ل.س 🎁`);
        }
      }
    }
  }
  return u;
}
const isAdmin = (env, id) => String(env.ADMIN_ID || '') === String(id);

async function addBalance(env, uid, amount, kind, ref = '') {
  await run(env, 'UPDATE users SET balance = balance + ? WHERE tg_id=?', amount, uid);
  await run(env, 'INSERT INTO txns(user_id,kind,amount,ref,created_at) VALUES(?,?,?,?,?)', uid, kind, amount, ref, now());
}
async function getState(env, uid) {
  const r = await one(env, 'SELECT * FROM ustate WHERE user_id=?', uid);
  return r ? { state: r.state, data: JSON.parse(r.data || '{}') } : { state: '', data: {} };
}
async function setState(env, uid, state, data = {}) {
  await run(env, 'INSERT INTO ustate(user_id,state,data) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET state=excluded.state, data=excluded.data',
    uid, state, JSON.stringify(data));
}
const clearState = (env, uid) => setState(env, uid, '', {});

// ---------- Forced subscription ----------
function normRef(ref) {
  // Admins often paste a full t.me link — Telegram needs @name or a numeric id.
  let s = String(ref || '').trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^t\.me\//i, '');
  s = s.split('/')[0].split('?')[0].trim();
  if (s && !s.startsWith('@') && !/^-?\d+$/.test(s)) s = '@' + s;
  return s;
}

async function missingChannels(env, uid) {
  const chans = await all(env, 'SELECT * FROM forced_channels ORDER BY id');
  const missing = [];
  for (const c of chans) {
    const r = await tg(env, 'getChatMember', { chat_id: normRef(c.chat_ref), user_id: uid });
    const st = r?.result?.status;
    if (!r.ok) {
      // The bot cannot verify membership (usually: it is not an admin in that
      // channel) — keep the user blocked, but warn the admin (max 1/hour/channel).
      missing.push(c);
      const key = `chanwarn_${c.id}`;
      const last = parseNum(await setting(env, key, '0'));
      if (env.ADMIN_ID && now() - last > 3600) {
        await run(env, "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, String(now()));
        await send(env, env.ADMIN_ID, `⚠️ <b>تنبيه اشتراك إجباري:</b> ما عم أقدر أتحقق من الاشتراك بقناة «${esc(c.title || c.chat_ref)}» — غالباً لأنو البوت مش أدمن فيها. ضيف @masari1bot أدمن بالقناة، وإلا المستخدمين بيضلوا واقفين عند بوابة الاشتراك.`);
      }
    }
    else if (['left', 'kicked'].includes(st)) missing.push(c);
  }
  return missing;
}
async function gate(env, uid) {
  // returns true if the user may use the bot; otherwise sends the join prompt
  if (isAdmin(env, uid)) return true;
  const missing = await missingChannels(env, uid);
  if (!missing.length) return true;
  const rows = missing.map((c) => [{ text: `📢 اشترك بـ ${c.title || c.chat_ref}`, url: (c.link && /^https:\/\/t\.me\//.test(c.link)) ? c.link : `https://t.me/${normRef(c.chat_ref).replace('@', '')}` }]);
  rows.push([{ text: '✅ تحققت — أنا اشتركت', callback_data: 'check_sub' }]);
  await send(env, uid, '⛔ <b>لازم تشترك بالقنوات التالية أولاً لتقدر تستخدم البوت:</b>', { inline_keyboard: rows });
  return false;
}

// ---------- Keyboards (per role: client / worker) ----------
function roleKb(env, uid, role) {
  const rows = role === 'worker'
    ? [
      [{ text: '📋 المهام المتاحة' }, { text: '🛠 مهامي' }],
      [{ text: '👛 محفظتي' }, { text: '📄 إنشاء CV' }],
      [{ text: '🎁 الإحالة' }, { text: '🏆 أوائل الأسبوع' }],
      [{ text: '🆘 الدعم' }, { text: '👤 حسابي' }],
      [{ text: '🔄 تبديل الدور' }],
    ]
    : [
      [{ text: '➕ اطلب خدمة' }, { text: '💰 قائمة الأسعار' }],
      [{ text: '📦 طلباتي' }, { text: '👛 محفظتي' }],
      [{ text: '📄 إنشاء CV' }, { text: '🎁 الإحالة' }],
      [{ text: '🆘 الدعم' }, { text: '👤 حسابي' }],
      [{ text: '🔄 تبديل الدور' }],
    ];
  if (isAdmin(env, uid)) rows.push([{ text: '👑 لوحة الأدمن' }]);
  return { keyboard: rows, resize_keyboard: true };
}
async function mainKb(env, uid) {
  const u = await getUser(env, uid);
  return roleKb(env, uid, u?.role);
}

async function rolePick(env, uid) {
  const txt = `👋 <b>أهلاً فيك بـ Masari</b>\n\nقبل ما نكمل، اختار انت داخل بصفتك شو — وبتقدر تبدّل بيناتهن أي وقت من «🔄 تبديل الدور»:\n\n🧑‍💼 <b>عميل</b>: عندك شغل بدك مين ينفّذو، أو بدك تشتري خدمة جاهزة من خدماتنا الثابتة (متل إنشاء سيرة ذاتية). بتشحن محفظتك وبتدفع منها، وبتشوف أسعار الخدمات بس.\n\n👷 <b>عامل</b>: بتنفّذ مهام جاهزة خطوة بخطوة، وبتاخد أجرك عن كل تنفيذ بينقبل، وبتسحب أرباحك. بتشوف أجر التنفيذ بس.\n\n📄 وخدمة <b>إنشاء CV</b> متاحة للكل.`;
  return send(env, uid, txt, { inline_keyboard: [
    [{ text: '🧑‍💼 أنا عميل', callback_data: 'role:client' }],
    [{ text: '👷 أنا عامل', callback_data: 'role:worker' }],
  ]});
}

async function cvIntro(env, uid) {
  return send(env, uid, `📄 <b>إنشاء سيرة ذاتية (CV)</b>\nمنعملك سيرة ذاتية احترافية جاهزة للتوظيف.\n\nاختار النظام يلي بدك ياه:`, { inline_keyboard: [
    [{ text: '📑 ATS — متوافقة مع أنظمة فرز السير', callback_data: 'cv:ats' }],
    [{ text: '🌍 Europass — النموذج الأوروبي', callback_data: 'cv:euro' }],
    [{ text: '⬅️ رجوع', callback_data: 'home' }],
  ]});
}
const backKb = { inline_keyboard: [[{ text: '⬅️ رجوع', callback_data: 'home' }]] };
const cancelKb = { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'cancel' }]] };

async function showHome(env, uid) {
  const u = await getUser(env, uid);
  const welcome = await setting(env, 'welcome_text', 'أهلا فيك بـ مصاري 💸');
  const uc = await one(env, 'SELECT COUNT(*) n FROM users');
  const done = await one(env, 'SELECT COALESCE(SUM(slots_done),0) s FROM tasks');
  const paid = await one(env, "SELECT COALESCE(SUM(amount),0) s FROM withdrawals WHERE status='approved'");
  const stats = `\n\n📊 <b>مصاري بالأرقام:</b> 👥 ${uc.n} مستخدم • ✅ ${done.s} تنفيذ ناجح • 💸 ${fmt(paid.s)} ل.س اندفعت للعمال`;
  await send(env, uid, `${esc(welcome)}${stats}\n\n👛 رصيدك: <b>${fmt(u?.balance)} ل.س</b>`, await mainKb(env, uid));
}

// ============================================================
//  USER FLOWS
// ============================================================
async function listCategories(env, uid, parentId = null) {
  const cats = parentId
    ? await all(env, 'SELECT * FROM categories WHERE parent_id=? AND is_active=1 ORDER BY id', parentId)
    : await all(env, 'SELECT * FROM categories WHERE parent_id IS NULL AND is_active=1 ORDER BY id');
  if (!cats.length && !parentId) return send(env, uid, '📋 ما في مهام منشورة حالياً. تابعنا، الجديد بينزل هون 👌', backKb);
  const rows = cats.map((c) => [{ text: `🗂 ${c.name}`, callback_data: `cat:${c.id}` }]);
  if (parentId) rows.push([{ text: '⬅️ رجوع للتصنيفات', callback_data: 'cats' }]);
  await send(env, uid, '🗂 <b>اختار تصنيف:</b>', { inline_keyboard: rows });
}

async function listTasks(env, uid, catId) {
  const tasks = await all(env, "SELECT * FROM tasks WHERE category_id=? AND status='open' ORDER BY id DESC", catId);
  const adminRow = isAdmin(env, uid) ? [[{ text: '➕ ضيف مهمة بهالتصنيف', callback_data: `adm:newtask:${catId}` }]] : [];
  if (!tasks.length) return send(env, uid, 'ما في مهام مفتوحة بهالتصنيف حالياً.', { inline_keyboard: [...adminRow, [{ text: '⬅️ رجوع', callback_data: 'home' }]] });
  for (const t of tasks) {
    const mine = await one(env, 'SELECT status FROM claims WHERE task_id=? AND worker_id=?', t.id, uid);
    const left = t.slots_total - t.slots_done;
    const txt = `📌 <b>${esc(t.title)}</b>\n💰 الأجر: <b>${fmt(t.pay)} ل.س</b>\n🎯 التقدم: ${t.slots_done}/${t.slots_total} (بقي ${left})\n${t.deadline ? `⏰ المهلة: ${esc(t.deadline)}\n` : ''}📄 الإثبات: ${{ photo: 'صورة', text: 'نص', link: 'رابط', any: 'صورة أو نص' }[t.proof_type] || 'أي'}`;
    const btn = mine
      ? [[{ text: `حالتك: ${{ claimed: '🛠 آخدها', submitted: '⏳ سلّمت — بانتظار المراجعة', approved: '✅ مقبولة', rejected: '❌ مرفوضة' }[mine.status]}`, callback_data: `mytask:${t.id}` }]]
      : [[{ text: '✋ آخد هالمهمة', callback_data: `take:${t.id}` }]];
    await send(env, uid, txt, { inline_keyboard: btn });
  }
  if (isAdmin(env, uid)) await send(env, uid, '👑 <b>أدمن:</b>', { inline_keyboard: adminRow });
}

async function myTasks(env, uid) {
  const rows = await all(env, `SELECT c.*, t.title, t.pay FROM claims c JOIN tasks t ON t.id=c.task_id
    WHERE c.worker_id=? ORDER BY c.id DESC LIMIT 20`, uid);
  if (!rows.length) return send(env, uid, '🛠 ما عندك مهام لسا. شوف «المهام المتاحة» وبلّش 👌', backKb);
  for (const c of rows) {
    const st = { claimed: '🛠 بانتظار تسليمك', submitted: '⏳ بانتظار المراجعة', approved: `✅ مقبولة (+${fmt(c.pay)} ل.س)`, rejected: '❌ مرفوضة' }[c.status];
    const kb = c.status === 'claimed' ? { inline_keyboard: [[{ text: '📤 سلّم الإثبات', callback_data: `submit:${c.id}` }]] } : backKb;
    await send(env, uid, `📌 <b>${esc(c.title)}</b>\nالحالة: ${st}`, kb);
  }
}

async function wallet(env, uid) {
  const u = await getUser(env, uid);
  const minW = await setting(env, 'min_withdraw', '25000');
  const row = [];
  if (isAdmin(env, uid) || u?.role !== 'worker') row.push({ text: '➕ إيداع', callback_data: 'dep' });
  row.push({ text: '➖ سحب', callback_data: 'wd' });
  const kb = { inline_keyboard: [
    row,
    [{ text: '📜 آخر الحركات', callback_data: 'history' }],
  ]};
  await send(env, uid, `👛 <b>محفظتك</b>\nالرصيد: <b>${fmt(u.balance)} ل.س</b>\nحد السحب الأدنى: ${fmt(minW)} ل.س`, kb);
}

async function history(env, uid) {
  const rows = await all(env, 'SELECT * FROM txns WHERE user_id=? ORDER BY id DESC LIMIT 10', uid);
  if (!rows.length) return send(env, uid, '📜 ما في حركات لسا.', backKb);
  const names = { deposit: 'إيداع', withdraw: 'سحب', earn: 'أجر مهمة', referral: 'ربح إحالة', escrow: 'حجز ضمان', refund: 'استرجاع ضمان', adjust: 'تعديل إدارة' };
  const txt = rows.map((r) => `${r.amount >= 0 ? '➕' : '➖'} ${names[r.kind] || r.kind}: ${fmt(Math.abs(r.amount))} ل.س`).join('\n');
  await send(env, uid, `📜 <b>آخر الحركات:</b>\n${txt}`, backKb);
}

async function referral(env, uid) {
  const bot = await tg(env, 'getMe');
  const link = `https://t.me/${bot?.result?.username || 'masari1bot'}?start=ref_${uid}`;
  const rw = await setting(env, 'ref_worker_pct', '5');
  const rc = await setting(env, 'ref_client_pct', '10');
  const count = await one(env, 'SELECT COUNT(*) n FROM users WHERE referrer_id=?', uid);
  const earned = await one(env, "SELECT COALESCE(SUM(amount),0) s FROM txns WHERE user_id=? AND kind='referral'", uid);
  await send(env, uid,
    `🎁 <b>نظام الإحالة</b>\n\n` +
    `• بتاخد <b>${rw}%</b> من أجر كل عامل بيجي من رابطك — على كل مهمة بينفذها، على طول.\n` +
    `• وبتاخد <b>${rc}%</b> من قيمة كل طلب بيحطو عميل بيجي من رابطك.\n` +
    `• الأرباح بتنضاف لرصيدك تلقائياً لحظة قبول التنفيذ.\n\n` +
    `👥 إحالاتك: ${count.n} شخص\n💰 مجموع أرباحك من الإحالة: ${fmt(earned.s)} ل.س\n\n🔗 رابطك:\n${link}`, { inline_keyboard: [
    [{ text: '📣 شارك رابطك', url: shareUrl(link, 'عم نفّذ مهام واجمع مصاري من بوت مصاري 💸 جرّبو من رابطي:') }],
    [{ text: '⬅️ رجوع', callback_data: 'home' }],
  ]});
}

let _botUser = '';
async function botUsername(env) {
  if (_botUser) return _botUser;
  const me = await tg(env, 'getMe');
  _botUser = me?.result?.username || 'masari1bot';
  return _botUser;
}
async function deepLink(env, payload) {
  const base = `https://t.me/${await botUsername(env)}`;
  return payload ? `${base}?start=${payload}` : base;
}
const shareUrl = (link, text) => `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;

async function promoPost(env, text, kb) {
  const ref = normRef(await setting(env, 'promo_channel', ''));
  if (!ref) return;
  const r = await tg(env, 'sendMessage', { chat_id: ref, text, parse_mode: 'HTML', reply_markup: kb });
  if (!r.ok) {
    const last = parseNum(await setting(env, 'promo_warn_at', '0'));
    if (now() - last > 3600) {
      await setSetting(env, 'promo_warn_at', String(now()));
      if (env.ADMIN_ID) await send(env, env.ADMIN_ID, `⚠️ ما قدرت انشر بقناة النشر (${esc(ref)}). تأكد إنو البوت أدمن فيها.\nالسبب: ${esc(r.description || '')}`);
    }
  }
}

async function topWorkers(env, days = 7) {
  const since = now() - days * 86400;
  return all(env, `SELECT c.worker_id, COUNT(*) n, COALESCE(SUM(t.pay),0) earned FROM claims c JOIN tasks t ON t.id=c.task_id WHERE c.status='approved' AND c.reviewed_at>=? GROUP BY c.worker_id ORDER BY n DESC, earned DESC LIMIT 5`, since);
}

async function leaderboard(env, uid) {
  const rows = await topWorkers(env);
  if (!rows.length) return send(env, uid, '🏆 <b>أوائل الأسبوع</b>\nلسا ما في تنفيذات مقبولة هالأسبوع — كون أول واحد! 💪', backKb);
  const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
  const lines = [];
  for (let i = 0; i < rows.length; i++) {
    const w = await getUser(env, rows[i].worker_id);
    lines.push(`${medals[i]} ${esc(w?.name || 'عامل')} — ${rows[i].n} تنفيذ (${fmt(rows[i].earned)} ل.س)`);
  }
  const prize = parseNum(await setting(env, 'contest_prize', '0'));
  return send(env, uid, `🏆 <b>أوائل هالأسبوع (آخر ٧ أيام)</b>\n\n${lines.join('\n')}${prize > 0 ? `\n\n🎁 جائزة الأول مساء الجمعة: <b>${fmt(prize)} ل.س</b>` : ''}`, backKb);
}

async function taskCard(env, uid, taskId) {
  const t = await one(env, "SELECT * FROM tasks WHERE id=? AND status='open'", taskId);
  if (!t) { await send(env, uid, '⚠️ هالمهمة سكّرت أو ما عادت متاحة.'); return showHome(env, uid); }
  const left = t.slots_total - t.slots_done;
  const link = await deepLink(env, `task_${t.id}`);
  return send(env, uid, `📌 <b>${esc(t.title)}</b>\n\n📋 ${esc(t.instructions || '')}\n\n💰 الأجر: <b>${fmt(t.pay)} ل.س</b>\n📋 خانات باقية: ${left}`, { inline_keyboard: [
    [{ text: '✅ خذ المهمة', callback_data: `take:${t.id}` }],
    [{ text: '🔗 شارك المهمة', url: shareUrl(link, `مهمة بـ ${fmt(t.pay)} ل.س على بوت مصاري — نفّذها واجمع مصاريك`) }],
  ]});
}

// ---------- Client price list (services, client-facing prices only) ----------
async function priceList(env, uid) {
  const offers = await all(env, 'SELECT * FROM offers WHERE is_active=1 ORDER BY id');
  if (!offers.length) return send(env, uid, '💰 ما في خدمات ثابتة منشورة حالياً. تابعنا 👌', backKb);
  let txt = '💰 <b>قائمة الأسعار</b>\nخدماتنا الثابتة — اضغط على أي خدمة لتشوف شرحها وتشتري:\n';
  const kb = [];
  for (const o of offers) {
    txt += `\n• <b>${esc(o.name)}</b> — ${fmt(o.price)} ل.س`;
    kb.push([{ text: `🛒 ${o.name} — ${fmt(o.price)} ل.س`, callback_data: `ofr:${o.id}` }]);
  }
  kb.push([{ text: '⬅️ رجوع', callback_data: 'home' }]);
  await send(env, uid, txt, { inline_keyboard: kb });
}

// ---------- Admin category tree (drill-down: main -> subs -> services) ----------
async function svcParentView(env, uid, catId) {
  const c = await one(env, 'SELECT * FROM categories WHERE id=?', catId);
  if (!c) return adminCats(env, uid);
  return c.parent_id ? adminSubView(env, uid, c.id) : adminCatView(env, uid, c.id);
}

async function adminCatView(env, uid, catId) {
  const cat = await one(env, 'SELECT * FROM categories WHERE id=? AND parent_id IS NULL', catId);
  if (!cat) return adminCats(env, uid);
  const subs = await all(env, 'SELECT * FROM categories WHERE parent_id=? ORDER BY id', catId);
  const svcs = await all(env, 'SELECT * FROM services WHERE category_id=? ORDER BY id', catId);
  const kb = [];
  subs.forEach((s) => kb.push([{ text: `📂 ${s.name}`, callback_data: `adm:sub:${s.id}` }]));
  svcs.forEach((s) => kb.push([{ text: `🧩 ${s.name} — ${fmt(s.price)}`, callback_data: `adm:svc:${s.id}` }]));
  kb.push([{ text: '➕ إضافة فرع', callback_data: `adm:addcat:${catId}` }, { text: '➕ إضافة مهمة', callback_data: `adm:addsvc:${catId}` }]);
  kb.push([{ text: '🗑 حذف', callback_data: `adm:delpick:${catId}` }]);
  kb.push([{ text: '⬅️ رجوع للتصنيفات', callback_data: 'adm:cats' }]);
  const empty = !subs.length && !svcs.length ? '\n\nفاضي — ضيف فرع أو مهمة من الأزرار تحت 👇' : '';
  return send(env, uid, `📁 <b>${esc(cat.name)}</b>${empty}`, { inline_keyboard: kb });
}

async function adminSubView(env, uid, subId) {
  const sub = await one(env, 'SELECT * FROM categories WHERE id=? AND parent_id IS NOT NULL', subId);
  if (!sub) return adminCats(env, uid);
  const svcs = await all(env, 'SELECT * FROM services WHERE category_id=? ORDER BY id', subId);
  const kb = svcs.map((s) => [{ text: `🧩 ${s.name} — ${fmt(s.price)}`, callback_data: `adm:svc:${s.id}` }]);
  kb.push([{ text: '➕ إضافة مهمة', callback_data: `adm:addsvc:${subId}` }]);
  kb.push([{ text: '🗑 حذف', callback_data: `adm:delpick:${sub.parent_id}` }]);
  kb.push([{ text: '⬅️ رجوع', callback_data: `adm:cat:${sub.parent_id}` }]);
  const empty = svcs.length ? '' : '\n\nما في مهام بعد — ضيف أول مهمة من الزر تحت 👇';
  return send(env, uid, `📂 <b>${esc(sub.name)}</b>${empty}`, { inline_keyboard: kb });
}

async function adminSvcView(env, uid, svcId) {
  const s = await one(env, 'SELECT * FROM services WHERE id=?', svcId);
  if (!s) return adminCats(env, uid);
  const txt = `🧩 <b>${esc(s.name)}</b>\n💵 سعر العميل: ${fmt(s.price)} ل.س\n👷 أجر العامل: ${fmt(s.pay)} ل.س`;
  const kb = [
    [{ text: '✏️ سعر العميل', callback_data: `prcp:${s.id}` }, { text: '✏️ أجر العامل', callback_data: `prcy:${s.id}` }],
    [{ text: '🗑 حذف المهمة', callback_data: `adm:delsvc2:${s.id}` }],
    [{ text: '⬅️ رجوع', callback_data: `adm:back2cat:${s.category_id}` }],
  ];
  return send(env, uid, txt, { inline_keyboard: kb });
}

// ---------- Fixed offers: the price list (admin-managed inside إدارة الأسعار only) ----------
async function adminOffers(env, uid) {
  if (!isAdmin(env, uid)) return send(env, uid, 'هاد القسم للأدمن بس.', backKb);
  const offers = await all(env, 'SELECT * FROM offers ORDER BY id');
  let txt = '💰 <b>إدارة الأسعار — الخدمات الثابتة</b>\nهي القائمة يلي بيشوفها العميل بـ «قائمة الأسعار» وبيشتري منها:\n';
  if (!offers.length) txt += '\nما في خدمات ثابتة بعد — ضيف أول وحدة من الزر تحت 👇';
  const kb = [];
  for (const o of offers) {
    txt += `\n• <b>${esc(o.name)}</b> — ${fmt(o.price)} ل.س`;
    kb.push([{ text: `✏️ سعر «${o.name}»`, callback_data: `adm:ofrprice:${o.id}` }, { text: `✏️ شرح «${o.name}»`, callback_data: `adm:ofrdet:${o.id}` }]);
    kb.push([{ text: `🗑 حذف «${o.name}»`, callback_data: `adm:delofr:${o.id}` }]);
  }
  kb.push([{ text: '➕ إضافة تصنيف (خدمة ثابتة)', callback_data: 'adm:addofr' }]);
  kb.push([{ text: '⬅️ رجوع', callback_data: 'adm:grp:work' }]);
  return send(env, uid, txt, { inline_keyboard: kb });
}

async function adminBuys(env, uid) {
  if (!isAdmin(env, uid)) return send(env, uid, 'هاد القسم للأدمن بس.', backKb);
  const rows = await all(env, 'SELECT * FROM purchases ORDER BY id DESC LIMIT 15');
  if (!rows.length) return send(env, uid, '🧾 ما في مشتريات لسا.', { inline_keyboard: [[{ text: '⬅️ رجوع', callback_data: 'adm:grp:work' }]] });
  const stTxt = { awaiting_payment: '⏳ بانتظار الدفع', paid: '✅ مدفوع — بانتظار التسليم', delivered: '📦 تم التسليم', cancelled: '❌ ملغي' };
  for (const p of rows) {
    const kb = p.status === 'paid' ? { inline_keyboard: [[{ text: '📦 تم التسليم', callback_data: `adm:buydone:${p.id}` }]] } : undefined;
    await send(env, uid, `🧾 <b>شراء #${p.id}</b> — ${esc(p.offer_name)} × ${p.qty}\nالمجموع: ${fmt(p.total)} ل.س\nالعميل: ${p.user_id}\nالحالة: ${stTxt[p.status] || p.status}`, kb);
  }
  return send(env, uid, '🧾 آخر المشتريات 👆', { inline_keyboard: [[{ text: '⬅️ رجوع', callback_data: 'adm:grp:work' }]] });
}

async function offerView(env, uid, offerId) {
  const o = await one(env, 'SELECT * FROM offers WHERE id=? AND is_active=1', offerId);
  if (!o) return priceList(env, uid);
  const txt = `🛒 <b>${esc(o.name)}</b>\n\n${esc(o.details || '')}\n\n💵 السعر: <b>${fmt(o.price)} ل.س</b> للوحدة\n\nهل تريد الشراء؟`;
  const link = await deepLink(env, `ofr_${o.id}`);
  return send(env, uid, txt, { inline_keyboard: [
    [{ text: '✅ نعم، بدي اشتري', callback_data: `ofrbuy:${o.id}` }],
    [{ text: '🔗 شارك الخدمة', url: shareUrl(link, `خدمة «${o.name}» بـ ${fmt(o.price)} ل.س على بوت مصاري`) }],
    [{ text: '⬅️ رجوع لقائمة الأسعار', callback_data: 'prices' }],
  ]});
}

async function offerPayScreen(env, uid, purchase) {
  const u = await getUser(env, uid);
  const methods = JSON.parse(await setting(env, 'deposit_methods', '[]'));
  let txt = `🧾 <b>ملخص الشراء</b>\nالخدمة: ${esc(purchase.offer_name)}\nالعدد: ${purchase.qty}\n<b>المجموع: ${fmt(purchase.total)} ل.س</b>\n\nاختار طريقة الدفع:`;
  const kb = [];
  if (u && u.balance >= purchase.total) kb.push([{ text: `💰 ادفع من رصيدي (${fmt(u.balance)} ل.س)`, callback_data: `ofrpay:${purchase.id}` }]);
  methods.forEach((mm, i) => kb.push([{ text: `💳 إيداع عبر ${mm.name}`, callback_data: `ofrdm:${purchase.id}:${i}` }]));
  if (!methods.length && !kb.length) txt += '\n\n⚠️ ما في وسائل دفع مفعّلة حالياً — راجع الدعم.';
  kb.push([{ text: '❌ إلغاء الشراء', callback_data: `ofrcancel:${purchase.id}` }]);
  return send(env, uid, txt, { inline_keyboard: kb });
}

async function adminDelPick(env, uid, mainId) {
  const cat = await one(env, 'SELECT * FROM categories WHERE id=? AND parent_id IS NULL', mainId);
  if (!cat) return adminCats(env, uid);
  const subs = await all(env, 'SELECT * FROM categories WHERE parent_id=? ORDER BY id', mainId);
  const kb = [[{ text: `🗑 الرئيسي «${cat.name}» وكل شي جواتو`, callback_data: `adm:delcat:${cat.id}` }]];
  for (const s of subs) {
    const n = await one(env, 'SELECT COUNT(*) AS c FROM services WHERE category_id=?', s.id);
    kb.push([{ text: `🗑 الفرع «${s.name}» (${n.c} مهمة)`, callback_data: `adm:delcat:${s.id}` }]);
  }
  kb.push([{ text: '⬅️ رجوع', callback_data: `adm:cat:${mainId}` }]);
  return send(env, uid, '🗑 <b>حذف</b> — اختار يلي بدك تحذفو:', { inline_keyboard: kb });
}

// ---------- Client self-serve ordering ----------
async function orderIntro(env, uid) {
  return send(env, uid, '➕ <b>طلب خدمة</b>\nاختار خدمة جاهزة من القائمة والسعر بينحسب و بينخصم من رصيدك فوراً، والمهمة بتنزل للعمال لحالها.\nأو إذا طلبك خاص ومش موجود بالقائمة، ابعتو كنص حر و الإدارة بتراجعو:',
    { inline_keyboard: [
      [{ text: '🛒 اطلب من قائمة الخدمات', callback_data: 'ordcats' }],
      [{ text: '💰 قائمة الأسعار', callback_data: 'prices' }, { text: '✍️ طلب خاص', callback_data: 'ordspecial' }],
    ] });
}

async function orderCategories(env, uid, parentId = null) {
  const cats = parentId
    ? await all(env, 'SELECT * FROM categories WHERE parent_id=? AND is_active=1 ORDER BY id', parentId)
    : await all(env, 'SELECT * FROM categories WHERE parent_id IS NULL AND is_active=1 ORDER BY id');
  if (!cats.length) return send(env, uid, '🛒 ما في تصنيفات لسا. جرّب «طلب خاص» أو راجع الدعم.', backKb);
  const rows = cats.map((c) => [{ text: `🗂 ${c.name}`, callback_data: `ordcat:${c.id}` }]);
  if (parentId) rows.push([{ text: '⬅️ رجوع للتصنيفات', callback_data: 'ordcats' }]);
  await send(env, uid, '🛒 <b>اختار التصنيف:</b>', { inline_keyboard: rows });
}

async function orderServices(env, uid, catId) {
  const svcs = await all(env, 'SELECT * FROM services WHERE category_id=? AND is_active=1 ORDER BY id', catId);
  if (!svcs.length) return send(env, uid, 'ما في خدمات بهالتصنيف لسا. جرّب تصنيف تاني أو «طلب خاص».', backKb);
  const rows = svcs.map((s) => [{ text: `${s.name} — ${fmt(s.price)} ل.س`, callback_data: `ordsel:${s.id}` }]);
  rows.push([{ text: '⬅️ رجوع', callback_data: 'ordcats' }]);
  await send(env, uid, '🛒 <b>اختار الخدمة</b> (السعر عن كل تنفيذ واحد):', { inline_keyboard: rows });
}

async function account(env, uid) {
  const u = await getUser(env, uid);
  await send(env, uid, `👤 <b>حسابك</b>\nالاسم: ${esc(u.name)}\nالآيدي: <code>${uid}</code>\nالرصيد: <b>${fmt(u.balance)} ل.س</b>`, backKb);
}

// ---------- Approving a claim (shared by admin / client / auto) ----------
async function approveClaim(env, claim) {
  const t = await one(env, 'SELECT * FROM tasks WHERE id=?', claim.task_id);
  if (!t || claim.status === 'approved') return;
  await run(env, "UPDATE claims SET status='approved', reviewed_at=? WHERE id=?", now(), claim.id);
  await run(env, 'UPDATE tasks SET slots_done = slots_done + 1 WHERE id=?', t.id);
  await addBalance(env, claim.worker_id, t.pay, 'earn', `task:${t.id}`);
  await send(env, claim.worker_id, `✅ <b>انقبل تنفيذك!</b>\n📌 ${esc(t.title)}\nانضاف لرصيدك ${fmt(t.pay)} ل.س 💸`);
  const ftb = parseNum(await setting(env, 'first_task_bonus', '0'));
  if (ftb > 0) {
    const cnt = await one(env, "SELECT COUNT(*) n FROM claims WHERE worker_id=? AND status='approved'", claim.worker_id);
    if (cnt.n === 1) {
      await addBalance(env, claim.worker_id, ftb, 'earn', 'first_task');
      await send(env, claim.worker_id, `🎁 <b>مكافأة أول مهمة!</b> انضاف لرصيدك ${fmt(ftb)} ل.س — بداية موفقة، كمل هيك 💪`);
    }
  }

  // Referrals — paid out of the platform commission (price - pay), capped by it.
  let commission = Math.max(0, t.price - t.pay);
  const worker = await getUser(env, claim.worker_id);
  if (worker?.referrer_id) {
    const pct = parseNum(await setting(env, 'ref_worker_pct', '5'));
    const amt = Math.min(commission, Math.floor((t.pay * pct) / 100));
    if (amt > 0) { await addBalance(env, worker.referrer_id, amt, 'referral', `task:${t.id}`); commission -= amt; }
  }
  if (t.client_id) {
    const client = await getUser(env, t.client_id);
    if (client?.referrer_id) {
      const pct = parseNum(await setting(env, 'ref_client_pct', '10'));
      const amt = Math.min(commission, Math.floor((t.price * pct) / 100));
      if (amt > 0) { await addBalance(env, client.referrer_id, amt, 'referral', `task:${t.id}`); commission -= amt; }
    }
  }
  // Auto-close when the slot target is reached + refund leftover escrow.
  const fresh = await one(env, 'SELECT * FROM tasks WHERE id=?', t.id);
  if (fresh.slots_done >= fresh.slots_total && fresh.status === 'open') {
    await run(env, "UPDATE tasks SET status='closed' WHERE id=?", t.id);
    await send(env, claim.worker_id, `🏁 اكتملت المهمة «${esc(t.title)}» وسكّرت تلقائياً.`);
    const adm = env.ADMIN_ID; if (adm) await send(env, adm, `🏁 اكتملت المهمة #${t.id} «${esc(t.title)}» (${fresh.slots_done}/${fresh.slots_total}) وسكّرت تلقائياً.`);
  }
}

async function rejectClaim(env, claim, byUid) {
  await run(env, "UPDATE claims SET status='rejected', reviewed_at=? WHERE id=?", now(), claim.id);
  const t = await one(env, 'SELECT * FROM tasks WHERE id=?', claim.task_id);
  await send(env, claim.worker_id, `❌ <b>انرفض تنفيذك</b> للمهمة «${esc(t?.title || '')}».\nإذا شايف في غلط، راجع الدعم 🆘`);
}

async function closeTaskRefund(env, t) {
  // Refund unfilled escrow to the funding client (admin-funded tasks have no escrow).
  if (t.client_id && t.status === 'open') {
    const left = (t.slots_total - t.slots_done) * t.price;
    if (left > 0) await addBalance(env, t.client_id, left, 'refund', `task:${t.id}`);
  }
  await run(env, "UPDATE tasks SET status='closed' WHERE id=?", t.id);
}

// ============================================================
//  ADMIN
// ============================================================
const adminKb = { inline_keyboard: [
  [{ text: '📋 المهام والتصنيفات', callback_data: 'adm:grp:work' }, { text: '💰 المالية', callback_data: 'adm:grp:money' }],
  [{ text: '👥 المستخدمين والدعم', callback_data: 'adm:grp:people' }, { text: '⚙️ النظام', callback_data: 'adm:grp:sys' }],
]};
const adminWorkKb = { inline_keyboard: [
  [{ text: '🗂 التصنيفات والمهام', callback_data: 'adm:cats' }],
  [{ text: '💰 إدارة الأسعار', callback_data: 'adm:prices' }, { text: '🧾 مشتريات العملاء', callback_data: 'adm:buys' }],
  [{ text: '🗂 المهام المفتوحة', callback_data: 'adm:tasks' }, { text: '✅ إثباتات بانتظاري', callback_data: 'adm:proofs' }],
  [{ text: '➕ إضافة تصنيف (قائمة الأسعار)', callback_data: 'adm:addofr' }],
  [{ text: '📥 طلبات خاصة', callback_data: 'adm:orders' }, { text: '📄 طلبات السيرة', callback_data: 'adm:cvs' }],
  [{ text: '⬅️ رجوع للوحة', callback_data: 'adm:home' }],
]};
const adminMoneyKb = { inline_keyboard: [
  [{ text: '💰 إيداعات معلقة', callback_data: 'adm:deps' }, { text: '💸 سحوبات معلقة', callback_data: 'adm:wds' }],
  [{ text: '🏦 وسائل الإيداع', callback_data: 'adm:depmet' }, { text: '💸 وسائل السحب', callback_data: 'adm:wdmet' }],
  [{ text: '⬅️ رجوع للوحة', callback_data: 'adm:home' }],
]};
const adminPeopleKb = { inline_keyboard: [
  [{ text: '👥 المستخدمين', callback_data: 'adm:users' }, { text: '🆘 تذاكر الدعم', callback_data: 'adm:tickets' }],
  [{ text: '📢 قنوات الاشتراك الإجباري', callback_data: 'adm:chans' }],
  [{ text: '⬅️ رجوع للوحة', callback_data: 'adm:home' }],
]};
const adminSysKb = { inline_keyboard: [
  [{ text: '⚙️ الإعدادات', callback_data: 'adm:settings' }, { text: '📊 إحصائيات', callback_data: 'adm:stats' }],
  [{ text: '⬅️ رجوع للوحة', callback_data: 'adm:home' }],
]};

async function adminHome(env, uid) { await send(env, uid, '👑 <b>لوحة الأدمن</b> — اختار قسم:', adminKb); }

async function adminCats(env, uid) {
  const cats = await all(env, 'SELECT * FROM categories WHERE parent_id IS NULL ORDER BY id');
  const kb = cats.map((c) => [{ text: `📁 ${c.name}`, callback_data: `adm:cat:${c.id}` }]);
  kb.push([{ text: '➕ تصنيف رئيسي', callback_data: 'adm:addcat:0' }]);
  kb.push([{ text: '⬅️ رجوع', callback_data: 'adm:grp:work' }]);
  const txt = cats.length ? '🗂 <b>التصنيفات الرئيسية</b>\nاضغط على أي تصنيف لتدخل عليه:' : '🗂 <b>التصنيفات</b>\nما في تصنيفات لسا — ضيف أول تصنيف رئيسي:';
  await send(env, uid, txt, { inline_keyboard: kb });
}

async function adminTasks(env, uid) {
  const rows = await all(env, `SELECT t.*, c.name cname FROM tasks t LEFT JOIN categories c ON c.id=t.category_id
    WHERE t.status='open' ORDER BY t.id DESC LIMIT 20`);
  if (!rows.length) return send(env, uid, '🗂 ما في مهام مفتوحة.', adminWorkKb);
  for (const t of rows) {
    await send(env, uid, `📌 <b>#${t.id} ${esc(t.title)}</b>\n🗂 ${esc(t.cname || '—')} — التقدم ${t.slots_done}/${t.slots_total}\n💰 سعر ${fmt(t.price)} / أجر ${fmt(t.pay)} ل.س\n${t.client_id ? `🧑‍💼 عميل ممول: ${t.client_id}` : '👑 ممولة من الإدارة'}`,
      { inline_keyboard: [[{ text: '🔒 إغلاق (واسترجاع الباقي للعميل)', callback_data: `adm:closetask:${t.id}` }]] });
  }
}

async function adminOrders(env, uid) {
  const rows = await all(env, "SELECT o.*, u.name FROM orders o JOIN users u ON u.tg_id=o.client_id WHERE o.status='new' ORDER BY o.id");
  if (!rows.length) return send(env, uid, '📥 ما في طلبات جديدة.', adminKb);
  for (const o of rows) {
    await send(env, uid, `📥 <b>طلب #${o.id}</b> من ${esc(o.name)}:\n${esc(o.text)}`,
      { inline_keyboard: [[
        { text: '🛠 حوّلو لمهمة', callback_data: `adm:convert:${o.id}` },
        { text: '❌ رفض', callback_data: `adm:rejorder:${o.id}` },
      ]] });
  }
}

async function reviewQueue(env, uid, reviewer) {
  const rows = await all(env, `SELECT c.*, t.title, t.reviewer, w.name wname FROM claims c
    JOIN tasks t ON t.id=c.task_id JOIN users w ON w.tg_id=c.worker_id
    WHERE c.status='submitted' AND t.reviewer=? ${reviewer === 'client' ? 'AND t.client_id=?' : ''} ORDER BY c.id`,
    ...(reviewer === 'client' ? [reviewer, uid] : [reviewer]));
  return rows;
}

async function showProofs(env, uid, rows, tag) {
  if (!rows.length) return send(env, uid, '✅ ما في إثباتات بانتظار المراجعة.', tag === 'adm' ? adminKb : backKb);
  for (const c of rows) {
    const kb = { inline_keyboard: [[
      { text: '✅ قبول', callback_data: `ok:${c.id}` },
      { text: '❌ رفض', callback_data: `no:${c.id}` },
    ]] };
    const head = `🧾 <b>إثبات #${c.id}</b> — ${esc(c.title)}\nالعامل: ${esc(c.wname)}\n`;
    if (c.proof_file) {
      await tg(env, 'sendPhoto', { chat_id: uid, photo: c.proof_file, caption: head + (c.proof_text ? esc(c.proof_text) : ''), parse_mode: 'HTML', reply_markup: kb });
    } else {
      await send(env, uid, head + (c.proof_text ? `الإثبات: ${esc(c.proof_text)}` : '(بدون نص)'), kb);
    }
  }
}

async function adminDepMethods(env, uid) {
  const methods = JSON.parse(await setting(env, 'deposit_methods', '[]'));
  let txt = '🏦 <b>وسائل الإيداع</b>\nهي الوسائل يلي بيشوفها المستخدم وقت يختار «➕ إيداع» من محفظتو:\n';
  if (!methods.length) txt += '\nما في وسائل بعد — ضيف أول وسيلة من الزر تحت 👇';
  const kb = [];
  methods.forEach((mm, i) => {
    txt += `\n• <b>${esc(mm.name)}</b>\n${esc(mm.details)}`;
    kb.push([{ text: `🗑 حذف «${mm.name}»`, callback_data: `adm:delmet:${i}` }]);
  });
  kb.push([{ text: '➕ وسيلة إيداع جديدة', callback_data: 'adm:addmet' }]);
  kb.push([{ text: '⬅️ رجوع', callback_data: 'adm:home' }]);
  return send(env, uid, txt, { inline_keyboard: kb });
}

async function saveDepMethods(env, methods) {
  await run(env, "INSERT INTO settings(key,value) VALUES('deposit_methods',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(methods));
}

async function adminWdMethods(env, uid) {
  const methods = JSON.parse(await setting(env, 'withdraw_methods', '[]'));
  let txt = '💸 <b>وسائل السحب</b>\nهي الوسائل يلي بيشوفها المستخدم وقت يختار «➖ سحب» من محفظتو:\n';
  if (!methods.length) txt += '\nما في وسائل بعد — ضيف أول وسيلة من الزر تحت 👇\n(إذا ما في وسائل، المستخدم بيكتب الوسيلة كتابة متل قبل.)';
  const kb = [];
  methods.forEach((mm, i) => {
    txt += `\n• <b>${esc(mm.name)}</b>${mm.details ? `\n${esc(mm.details)}` : ''}`;
    kb.push([{ text: `🗑 حذف «${mm.name}»`, callback_data: `adm:delwmet:${i}` }]);
  });
  kb.push([{ text: '➕ وسيلة سحب جديدة', callback_data: 'adm:addwmet' }]);
  kb.push([{ text: '⬅️ رجوع', callback_data: 'adm:home' }]);
  return send(env, uid, txt, { inline_keyboard: kb });
}

async function saveWdMethods(env, methods) {
  await run(env, "INSERT INTO settings(key,value) VALUES('withdraw_methods',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(methods));
}

async function adminDeps(env, uid) {
  const rows = await all(env, "SELECT d.*, u.name FROM deposits d JOIN users u ON u.tg_id=d.user_id WHERE d.status='pending' ORDER BY d.id");
  if (!rows.length) return send(env, uid, '💰 ما في إيداعات معلقة.', adminKb);
  for (const d of rows) {
    const btns = [];
    if (d.proof_file) btns.push([{ text: '📷 شوف السكرين شوت', callback_data: `adm:depshot:${d.id}` }]);
    btns.push([
      { text: d.amount > 0 ? `✅ اعتماد ${fmt(d.amount)} ل.س` : '✅ اعتماد بمبلغ…', callback_data: `adm:depok:${d.id}` },
      { text: '❌ رفض', callback_data: `adm:deprej:${d.id}` },
    ]);
    await send(env, uid, `💰 <b>إيداع #${d.id}</b>\nالمستخدم: ${esc(d.name)} (${d.user_id})\nالطريقة: ${esc(d.method)}\nالمبلغ: <b>${d.amount > 0 ? fmt(d.amount) + ' ل.س' : '—'}</b>${d.note ? `\nملاحظة: ${esc(d.note)}` : ''}`,
      { inline_keyboard: btns });
  }
}

async function adminWds(env, uid) {
  const rows = await all(env, "SELECT w.*, u.name FROM withdrawals w JOIN users u ON u.tg_id=w.user_id WHERE w.status='pending' ORDER BY w.id");
  if (!rows.length) return send(env, uid, '💸 ما في سحوبات معلقة.', adminKb);
  for (const w of rows) {
    await send(env, uid, `💸 <b>سحب #${w.id}</b>\nالمستخدم: ${esc(w.name)}\nالمبلغ: <b>${fmt(w.amount)} ل.س</b>\nالطريقة: ${esc(w.method)}\nالتفاصيل: ${esc(w.details)}`,
      { inline_keyboard: [[
        { text: '✅ تم الدفع', callback_data: `adm:wdok:${w.id}` },
        { text: '❌ رفض (يرجع الرصيد)', callback_data: `adm:wdrej:${w.id}` },
      ]] });
  }
}

async function adminChans(env, uid) {
  const rows = await all(env, 'SELECT * FROM forced_channels ORDER BY id');
  const txt = rows.length ? rows.map((c) => `• ${esc(c.title || c.chat_ref)} — ${esc(c.chat_ref)}`).join('\n') : 'ما في قنوات إجبارية.';
  const kb = { inline_keyboard: [
    [{ text: '➕ إضافة قناة', callback_data: 'adm:addchan' }],
    ...rows.map((c) => [{ text: `🗑 حذف ${c.title || c.chat_ref}`, callback_data: `adm:delchan:${c.id}` }]),
    [{ text: '⬅️ رجوع', callback_data: 'adm:home' }],
  ]};
  await send(env, uid, `📢 <b>قنوات الاشتراك الإجباري:</b>\n${txt}\n\n⚠️ البوت لازم يكون <b>أدمن</b> بكل قناة ليقدر يتحقق من الاشتراك.`, kb);
}

async function adminSettings(env, uid) {
  const keys = ['ref_worker_pct', 'ref_client_pct', 'min_withdraw', 'auto_approve_days', 'usd_rate', 'first_task_bonus', 'ref_milestone_every', 'ref_milestone_bonus', 'contest_prize'];
  const vals = {};
  for (const k of keys) vals[k] = await setting(env, k, '');
  const promo = await setting(env, 'promo_channel', '');
  const kb = { inline_keyboard: [
    ...keys.map((k) => [{ text: `✏️ ${k} = ${vals[k]}`, callback_data: `adm:set:${k}` }]),
    [{ text: `📢 قناة النشر: ${promo || 'غير محددة'}`, callback_data: 'adm:set:promo_channel' }],
    [{ text: '✏️ نص الترحيب', callback_data: 'adm:set:welcome_text' }],
    [{ text: '🏦 وسائل الإيداع', callback_data: 'adm:depmet' }],
    [{ text: '⬅️ رجوع', callback_data: 'adm:home' }],
  ]};
  await send(env, uid,
    `⚙️ <b>الإعدادات</b>\n• نسبة إحالة العامل: ${vals.ref_worker_pct}%\n• نسبة إحالة العميل: ${vals.ref_client_pct}%\n• حد السحب الأدنى: ${fmt(vals.min_withdraw)} ل.س\n• قبول تلقائي بعد صمت العميل: ${vals.auto_approve_days} يوم\n• سعر صرف الدولار (usd_rate): ${vals.usd_rate ? fmt(vals.usd_rate) + ' ل.س' : 'غير محدد — حددو كرمال حساب USDT'}\n• مكافأة أول مهمة (first_task_bonus): ${fmt(vals.first_task_bonus)} ل.س (٠ = مطفأة)\n• مرحلة الإحالة: كل ${vals.ref_milestone_every || '٠'} إحالة ← ${fmt(vals.ref_milestone_bonus)} ل.س (٠ = مطفأة)\n• جائزة مسابقة الأسبوع (contest_prize): ${fmt(vals.contest_prize)} ل.س (٠ = بلا جائزة)\n• قناة النشر الترويجي: ${promo || 'غير محددة'}`, kb);
}

const isUsdtMethod = (name) => /usdt|tether|تيثر|دولار/i.test(name || '');
async function usdtLine(env, totalSyp, methodName) {
  if (!isUsdtMethod(methodName)) return '';
  const rate = parseNum(await setting(env, 'usd_rate', '0'));
  if (!rate || rate <= 0) return '';
  const usd = Math.ceil((totalSyp / rate) * 100) / 100;
  return `\n💵 يعني <b>${usd} USDT</b> (بسعر صرف ${fmt(rate)} ل.س/$)`;
}

function cvRequestText(id, uid, d) {
  const L = (k, v) => (v ? `\n• ${k}: ${esc(v)}` : '');
  return `📄 <b>طلب إنشاء سيرة #${id}</b>\nالنظام: <b>${esc(d.system || '')}</b>\nمن: ${uid}${L('الاسم', d.name)}${L('المسمى', d.title)}${L('الهاتف', d.phone)}${L('الإيميل', d.email)}${L('المدينة', d.city)}${L('نبذة', d.summary)}${L('الخبرات', d.exp)}${L('التعليم', d.edu)}${L('المهارات', d.skills)}${L('اللغات', d.langs)}${L('روابط', d.links)}`;
}

async function adminCvs(env, uid) {
  if (!isAdmin(env, uid)) return send(env, uid, 'هاد القسم للأدمن بس.', backKb);
  const rows = await all(env, "SELECT * FROM cv_requests WHERE status='new' ORDER BY id DESC LIMIT 10");
  if (!rows.length) return send(env, uid, '📄 ما في طلبات سيرة جديدة.', { inline_keyboard: [[{ text: '⬅️ رجوع', callback_data: 'adm:grp:work' }]] });
  for (const r of rows) {
    let d = {}; try { d = JSON.parse(r.data || '{}'); } catch (e) {}
    await send(env, uid, cvRequestText(r.id, r.user_id, d), { inline_keyboard: [[{ text: '✔️ تم إنجازها', callback_data: `adm:cvdone:${r.id}` }]] });
  }
  return send(env, uid, '📄 طلبات السيرة الجديدة 👆', { inline_keyboard: [[{ text: '⬅️ رجوع', callback_data: 'adm:grp:work' }]] });
}

async function adminStats(env, uid) {
  const u = await one(env, 'SELECT COUNT(*) n FROM users');
  const t = await one(env, "SELECT COUNT(*) n FROM tasks WHERE status='open'");
  const done = await one(env, 'SELECT COALESCE(SUM(slots_done),0) s FROM tasks');
  const bal = await one(env, 'SELECT COALESCE(SUM(balance),0) s FROM users');
  await send(env, uid, `📊 <b>إحصائيات</b>\n👥 المستخدمين: ${u.n}\n📋 مهام مفتوحة: ${t.n}\n✅ تنفيذات مقبولة: ${done.s}\n💰 مجموع أرصدة المستخدمين: ${fmt(bal.s)} ل.س`, adminKb);
}

// ============================================================
//  MULTI-STEP FLOWS (state machine)
// ============================================================
async function notifyWorkers(env, t) {
  const users = await all(env, 'SELECT tg_id FROM users WHERE is_banned=0 LIMIT 500');
  for (const u of users) {
    try { await send(env, u.tg_id, `🆕 <b>مهمة جديدة!</b>\n📌 ${esc(t.title)}\n💰 الأجر: ${fmt(t.pay)} ل.س — شوف «المهام المتاحة» 📋`); } catch (e) {}
  }
  const link = await deepLink(env, `task_${t.id}`);
  await promoPost(env, `🆕 <b>مهمة جديدة على مصاري!</b>\n📌 ${esc(t.title)}\n💰 الأجر: <b>${fmt(t.pay)} ل.س</b>\n📋 الخانات: ${t.slots_total}\n\nنفّذها قبل ما تخلص 👇`, { inline_keyboard: [[{ text: '📋 نفّذها من هون', url: link }]] });
}

async function publishTask(env, uid, d) {
  // Escrow: client-funded tasks hold price*slots from the client balance first.
  if (d.client_id) {
    const c = await getUser(env, d.client_id);
    const need = d.price * d.slots;
    if (!c || c.balance < need) {
      await send(env, uid, `⚠️ رصيد العميل (${fmt(c?.balance || 0)}) ما بيكفي لحجز الضمان (${fmt(need)}). المهمة ما اننشرت — عدّل رصيد العميل أو خفّض العدد/السعر.`);
      return;
    }
    await addBalance(env, d.client_id, -need, 'escrow', 'order');
  }
  const r = await run(env, `INSERT INTO tasks(category_id,client_id,title,instructions,proof_type,price,pay,slots_total,reviewer,deadline,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`, d.category_id, d.client_id, d.title, d.instructions, d.proof_type, d.price, d.pay, d.slots, d.reviewer, d.deadline, now());
  const t = await one(env, 'SELECT * FROM tasks WHERE id=?', r.meta.last_row_id);
  if (d.order_id) await run(env, "UPDATE orders SET status='converted' WHERE id=?", d.order_id);
  await send(env, uid, `✅ <b>اننشرت المهمة #${t.id}</b> «${esc(t.title)}» — ${t.slots_total} خانة × ${fmt(t.pay)} ل.س`);
  await notifyWorkers(env, t);
}

async function wizardStep(env, uid, st, text) {
  const d = st.data;
  const steps = {
    tw_title:   async () => { d.title = text;
                    if (d.category_id) { await setState(env, uid, 'tw_inst', d); return send(env, uid, '📋 اكتب تعليمات التنفيذ للعامل (أو «-» إذا ما في):'); }
                    await setState(env, uid, 'tw_cat', d); return pickCategory(env, uid); },
    tw_inst:    async () => { d.instructions = text === '-' ? '' : text; await setState(env, uid, 'tw_proof', d);
                    return send(env, uid, '📄 نوع الإثبات المطلوب:', { inline_keyboard: [[
                      { text: '🖼 صورة', callback_data: 'twp:photo' }, { text: '✍️ نص', callback_data: 'twp:text' },
                      { text: '🔗 رابط', callback_data: 'twp:link' }, { text: 'أي شي', callback_data: 'twp:any' }]] }); },
    tw_price:   async () => { d.price = parseNum(text); await setState(env, uid, 'tw_pay', d); return send(env, uid, '💵 أجر العامل على التنفيذ الواحد؟ (ل.س)'); },
    tw_pay:     async () => { d.pay = parseNum(text); await setState(env, uid, 'tw_slots', d); return send(env, uid, '🎯 كم تنفيذ بدك بالمجموع؟ (عدد الخانات)'); },
    tw_slots:   async () => { d.slots = Math.max(1, parseNum(text)); await setState(env, uid, 'tw_rev', d);
                    return send(env, uid, '👁 مين بيراجع الإثباتات؟', { inline_keyboard: [[
                      { text: '👑 أنا (الأدمن)', callback_data: 'twr:admin' }, { text: '🧑‍💼 العميل صاحب الطلب', callback_data: 'twr:client' }]] }); },
    tw_dead:    async () => { d.deadline = text === '-' ? '' : text; await clearState(env, uid); return publishTask(env, uid, d); },
  };
  if (steps[st.state]) return steps[st.state]();
}

async function pickCategory(env, uid) {
  const cats = await all(env, 'SELECT * FROM categories WHERE is_active=1 ORDER BY parent_id, id');
  if (!cats.length) { await send(env, uid, '⚠️ ما في تصنيفات لسا — ضيف تصنيف أولاً من لوحة الأدمن.'); await clearState(env, uid); return; }
  const names = {}; cats.forEach((c) => (names[c.id] = c.name));
  const rows = cats.map((c) => [{ text: `${c.parent_id ? `↳ ${names[c.parent_id]} / ` : '🗂 '}${c.name}`, callback_data: `twc:${c.id}` }]);
  await send(env, uid, '🗂 بأي تصنيف هالمهمة؟', { inline_keyboard: rows });
}

async function handleStateText(env, uid, st, msg) {
  const text = (msg.text || '').trim();
  const d = st.data;
  switch (st.state) {
    case 'tw_title': case 'tw_inst': case 'tw_price': case 'tw_pay': case 'tw_slots': case 'tw_dead':
      return wizardStep(env, uid, st, text);

    case 'adm_svcprice': {
      const v = parseNum(text);
      if (!v || v <= 0) return send(env, uid, '⚠️ ابعت رقم صحيح أكبر من صفر:', cancelKb);
      const svc = await one(env, 'SELECT * FROM services WHERE id=?', st.data.svc);
      await clearState(env, uid);
      if (!svc) return send(env, uid, 'الخدمة ما عادت موجودة.', backKb);
      await run(env, 'UPDATE services SET price=? WHERE id=?', v, svc.id);
      await send(env, uid, `✅ صار سعر العميل لـ «${esc(svc.name)}»: <b>${fmt(v)} ل.س</b>`);
      return adminSvcView(env, uid, svc.id);
    }
    case 'adm_svcpay': {
      const v = parseNum(text);
      if (!v || v <= 0) return send(env, uid, '⚠️ ابعت رقم صحيح أكبر من صفر:', cancelKb);
      const svc = await one(env, 'SELECT * FROM services WHERE id=?', st.data.svc);
      await clearState(env, uid);
      if (!svc) return send(env, uid, 'الخدمة ما عادت موجودة.', backKb);
      await run(env, 'UPDATE services SET pay=? WHERE id=?', v, svc.id);
      await send(env, uid, `✅ صار أجر العامل لـ «${esc(svc.name)}»: <b>${fmt(v)} ل.س</b>`);
      return adminSvcView(env, uid, svc.id);
    }
    case 'client_request': {
      await run(env, 'INSERT INTO orders(client_id,text,created_at) VALUES(?,?,?)', uid, text, now());
      await clearState(env, uid);
      await send(env, uid, '✅ وصل طلبك للإدارة. منراجعو ومننشره كمهمة، وبيوصلك إشعار.', await mainKb(env, uid));
      if (env.ADMIN_ID) await send(env, env.ADMIN_ID, `📥 طلب خدمة جديد من ${uid}:\n${esc(text)}`);
      return;
    }
    case 'await_proof': {
      const claim = await one(env, 'SELECT * FROM claims WHERE id=?', d.claim_id);
      if (!claim) { await clearState(env, uid); return; }
      const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : '';
      if (!fileId && !text) { await send(env, uid, 'ابعت الإثبات صورة أو نص.'); return; }
      await run(env, "UPDATE claims SET status='submitted', proof_text=?, proof_file=?, submitted_at=? WHERE id=?",
        fileId ? '' : text, fileId, now(), claim.id);
      await clearState(env, uid);
      await send(env, uid, '📤 تسلّم إثباتك — صار بانتظار المراجعة. بيوصلك إشعار بالنتيجة 👌', await mainKb(env, uid));
      const t = await one(env, 'SELECT * FROM tasks WHERE id=?', claim.task_id);
      const reviewerId = t.reviewer === 'client' && t.client_id ? t.client_id : env.ADMIN_ID;
      if (reviewerId) await send(env, reviewerId, `🧾 إثبات جديد بانتظار مراجعتك للمهمة «${esc(t.title)}»`);
      return;
    }
    case 'dep_amount': {
      const amt = parseNum(text);
      if (!amt || amt <= 0) return send(env, uid, '⚠️ ابعت المبلغ رقم صحيح (ل.س):', cancelKb);
      d.amount = amt; await setState(env, uid, 'dep_shot', d);
      const methods = JSON.parse(await setting(env, 'deposit_methods', '[]'));
      const mm = methods.find((x) => x.name === d.method);
      return send(env, uid, `💳 حوّل <b>${fmt(amt)} ل.س</b> عبر «${esc(d.method)}» لهون:\n${esc(mm?.details || '')}\n\n📸 بعد ما تحوّل، ابعت <b>سكرين شوت</b> التحويل هون (أو رقم العملية كنص).`, cancelKb);
    }
    case 'dep_shot': {
      const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : '';
      if (!fileId && !text) return send(env, uid, '📸 ابعت سكرين شوت التحويل (أو رقم العملية كنص):', cancelKb);
      const r = await run(env, 'INSERT INTO deposits(user_id,method,note,amount,proof_file,created_at) VALUES(?,?,?,?,?,?)', uid, d.method, fileId ? '' : text, d.amount || 0, fileId, now());
      const depId = r.meta.last_row_id;
      await clearState(env, uid);
      await send(env, uid, '✅ وصل طلب الإيداع للإدارة. بس يتحققوا من التحويل بينضاف لرصيدك وبيوصلك إشعار.', await mainKb(env, uid));
      if (env.ADMIN_ID) {
        const cap = `💰 <b>إيداع جديد #${depId}</b>\nمن: ${uid}\nالطريقة: ${esc(d.method)}\nالمبلغ: <b>${fmt(d.amount)} ل.س</b>`;
        const kb = { inline_keyboard: [[
          { text: `✅ اعتماد ${fmt(d.amount)} ل.س`, callback_data: `adm:depok:${depId}` },
          { text: '❌ رفض', callback_data: `adm:deprej:${depId}` },
        ]] };
        if (fileId) await tg(env, 'sendPhoto', { chat_id: env.ADMIN_ID, photo: fileId, caption: cap, parse_mode: 'HTML', reply_markup: kb });
        else await send(env, env.ADMIN_ID, `${cap}\nرقم العملية: ${esc(text)}`, kb);
      }
      return;
    }
    case 'ofr_qty': {
      const qty = parseNum(text);
      if (!qty || qty < 1) return send(env, uid, '⚠️ اكتب عدد صحيح أكبر من صفر:', cancelKb);
      const o = await one(env, 'SELECT * FROM offers WHERE id=? AND is_active=1', d.offer_id);
      if (!o) { await clearState(env, uid); return send(env, uid, '⚠️ هالخدمة ما عادت متاحة.', backKb); }
      const total = o.price * qty;
      const r = await run(env, 'INSERT INTO purchases(user_id,offer_id,offer_name,qty,total,created_at) VALUES(?,?,?,?,?,?)', uid, o.id, o.name, qty, total, now());
      const p = await one(env, 'SELECT * FROM purchases WHERE id=?', r.meta.last_row_id);
      await clearState(env, uid);
      return offerPayScreen(env, uid, p);
    }
    case 'ofr_shot': {
      const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : '';
      if (!fileId && !text) return send(env, uid, '📸 ابعت سكرين شوت التحويل (أو رقم العملية كنص):', cancelKb);
      const p = await one(env, "SELECT * FROM purchases WHERE id=? AND user_id=? AND status='awaiting_payment'", d.purchase_id, uid);
      if (!p) { await clearState(env, uid); return send(env, uid, '⚠️ هالشراء انحسم أو انلغى.', backKb); }
      const r = await run(env, 'INSERT INTO deposits(user_id,method,note,amount,proof_file,ref,created_at) VALUES(?,?,?,?,?,?,?)', uid, d.method, `شراء: ${p.offer_name} × ${p.qty}`, p.total, fileId, `purchase:${p.id}`, now());
      const depId = r.meta.last_row_id;
      await run(env, 'UPDATE purchases SET deposit_id=? WHERE id=?', depId, p.id);
      await clearState(env, uid);
      await send(env, uid, '✅ وصل إثبات الدفع للإدارة. بس يعتمدوه بيتم شراؤك وبيوصلك إشعار.', await mainKb(env, uid));
      if (env.ADMIN_ID) {
        const cap = `💰 <b>إيداع لشراء #${depId}</b>\n🧾 الشراء: ${esc(p.offer_name)} × ${p.qty} = <b>${fmt(p.total)} ل.س</b>${await usdtLine(env, p.total, d.method)}\nمن: ${uid}\nالطريقة: ${esc(d.method)}\nباعتمادك هالإيداع بيتم الشراء لحالو (ما بينضاف للرصيد).`;
        const kb = { inline_keyboard: [[
          { text: `✅ اعتماد ${fmt(p.total)} ل.س`, callback_data: `adm:depok:${depId}` },
          { text: '❌ رفض', callback_data: `adm:deprej:${depId}` },
        ]] };
        if (fileId) await tg(env, 'sendPhoto', { chat_id: env.ADMIN_ID, photo: fileId, caption: cap, parse_mode: 'HTML', reply_markup: kb });
        else await send(env, env.ADMIN_ID, `${cap}\nرقم العملية: ${esc(text)}`, kb);
      }
      return;
    }
    case 'cv_name': d.name = text; await setState(env, uid, 'cv_title', d); return send(env, uid, '٢) المسمى الوظيفي (مثلا: محاسب / مبرمج / مهندس اتصالات):', cancelKb);
    case 'cv_title': d.title = text; await setState(env, uid, 'cv_phone', d); return send(env, uid, '٣) رقم الهاتف (مع رمز البلد إذا برا سوريا):', cancelKb);
    case 'cv_phone': d.phone = text; await setState(env, uid, 'cv_email', d); return send(env, uid, '٤) البريد الإلكتروني:', cancelKb);
    case 'cv_email': d.email = text; await setState(env, uid, 'cv_city', d); return send(env, uid, '٥) المدينة والبلد:', cancelKb);
    case 'cv_city': d.city = text; await setState(env, uid, 'cv_summary', d); return send(env, uid, '٦) نبذة قصيرة عنك (اختياري — «-» للتخطي):', cancelKb);
    case 'cv_summary': d.summary = text === '-' ? '' : text; await setState(env, uid, 'cv_exp', d); return send(env, uid, '٧) الخبرات العملية — كل خبرة بسطر: الجهة — المنصب — من سنة لسنة (اختياري):', cancelKb);
    case 'cv_exp': d.exp = text === '-' ? '' : text; await setState(env, uid, 'cv_edu', d); return send(env, uid, '٨) التعليم — الجامعة/المعهد — الاختصاص — سنة التخرج (اختياري):', cancelKb);
    case 'cv_edu': d.edu = text === '-' ? '' : text; await setState(env, uid, 'cv_skills', d); return send(env, uid, '٩) المهارات (افصل بيناتهن بفاصلة):', cancelKb);
    case 'cv_skills': d.skills = text; await setState(env, uid, 'cv_langs', d); return send(env, uid, '١٠) اللغات ومستواك فيهن — مثلا: عربي أم، إنكليزي جيد (اختياري):', cancelKb);
    case 'cv_langs': d.langs = text === '-' ? '' : text; await setState(env, uid, 'cv_links', d); return send(env, uid, '١١) روابط — LinkedIn أو أعمالك (اختياري):', cancelKb);
    case 'cv_links': {
      d.links = text === '-' ? '' : text;
      const r = await run(env, 'INSERT INTO cv_requests(user_id,system,data,created_at) VALUES(?,?,?,?)', uid, d.system || '', JSON.stringify(d), now());
      const id = r.meta.last_row_id;
      await clearState(env, uid);
      await send(env, uid, `✅ <b>وصل طلب السيرة #${id}!</b>\nالنظام: ${esc(d.system || '')}\nالإدارة استلمت معلوماتك وبتبلش بالشغل — بيوصلك إشعار بس تجهز 👌`, await mainKb(env, uid));
      if (env.ADMIN_ID) await send(env, env.ADMIN_ID, cvRequestText(id, uid, d), { inline_keyboard: [[{ text: '✔️ تم إنجازها', callback_data: `adm:cvdone:${id}` }]] });
      return;
    }
    case 'ofr_name': d.name = text; await setState(env, uid, 'ofr_details', d); return send(env, uid, '📝 ابعت شرح الخدمة (يلي بيشوفو العميل قبل الشراء) — أو «-» إذا ما في:', cancelKb);
    case 'ofr_details': d.details = text === '-' ? '' : text; await setState(env, uid, 'ofr_price', d); return send(env, uid, '💵 سعر الوحدة (ل.س):', cancelKb);
    case 'ofr_price': {
      const v = parseNum(text);
      if (!v || v <= 0) return send(env, uid, '⚠️ ابعت رقم صحيح أكبر من صفر:', cancelKb);
      await run(env, 'INSERT INTO offers(name,details,price) VALUES(?,?,?)', d.name, d.details || '', v);
      await clearState(env, uid);
      await send(env, uid, `✅ انضافت الخدمة الثابتة «${esc(d.name)}» لقائمة الأسعار.`);
      return adminOffers(env, uid);
    }
    case 'adm_ofr_price': {
      const v = parseNum(text);
      if (!v || v <= 0) return send(env, uid, '⚠️ ابعت رقم صحيح أكبر من صفر:', cancelKb);
      await run(env, 'UPDATE offers SET price=? WHERE id=?', v, d.offer_id);
      await clearState(env, uid);
      await send(env, uid, `✅ اتعدّل السعر لـ ${fmt(v)} ل.س.`);
      return adminOffers(env, uid);
    }
    case 'adm_ofr_details': {
      await run(env, 'UPDATE offers SET details=? WHERE id=?', text === '-' ? '' : text, d.offer_id);
      await clearState(env, uid);
      await send(env, uid, '✅ اتعدّل الشرح.');
      return adminOffers(env, uid);
    }
    case 'met_name': d.name = text; await setState(env, uid, 'met_details', d); return send(env, uid, '📍 ابعت تفاصيل التحويل لهالوسيلة (الرقم / العنوان / الرابط + أي تعليمات) — هي يلي بتظهر للمستخدم بعد ما يحدد المبلغ:', cancelKb);
    case 'met_details': {
      const methods = JSON.parse(await setting(env, 'deposit_methods', '[]'));
      methods.push({ name: d.name, details: text });
      await saveDepMethods(env, methods);
      await clearState(env, uid);
      await send(env, uid, `✅ انضافت وسيلة «${esc(d.name)}».`);
      return adminDepMethods(env, uid);
    }
    case 'wmet_name': d.name = text; await setState(env, uid, 'wmet_details', d); return send(env, uid, '📍 ابعت تعليمات هالوسيلة للمستخدم (مثلا: الرقم لازم يبدأ بـ 09) — أو «-» إذا ما في:', cancelKb);
    case 'wmet_details': {
      const methods = JSON.parse(await setting(env, 'withdraw_methods', '[]'));
      methods.push({ name: d.name, details: text === '-' ? '' : text });
      await saveWdMethods(env, methods);
      await clearState(env, uid);
      await send(env, uid, `✅ انضافت وسيلة سحب «${esc(d.name)}».`);
      return adminWdMethods(env, uid);
    }
    case 'wd_amount2': {
      const amt = parseNum(text);
      const u = await getUser(env, uid);
      const minW = parseNum(await setting(env, 'min_withdraw', '25000'));
      if (!amt || amt < minW) return send(env, uid, `⚠️ الحد الأدنى للسحب ${fmt(minW)} ل.س — ابعت مبلغ صحيح:`, cancelKb);
      if (amt > u.balance) return send(env, uid, `⚠️ المبلغ أكبر من رصيدك (${fmt(u.balance)} ل.س) — ابعت مبلغ أصغر:`, cancelKb);
      d.amount = amt; await setState(env, uid, 'wd_details2', d);
      const methods = JSON.parse(await setting(env, 'withdraw_methods', '[]'));
      const mm = methods.find((x) => x.name === d.method);
      return send(env, uid, `📍 ابعت الرقم/العنوان يلي بدك التحويل عليه:${mm?.details ? `\n${esc(mm.details)}` : ''}`, cancelKb);
    }
    case 'wd_details2': {
      const u = await getUser(env, uid);
      if (!d.amount || d.amount > u.balance) { await clearState(env, uid); return send(env, uid, '⚠️ رصيدك ما بيكفي لهالمبلغ.', await mainKb(env, uid)); }
      await addBalance(env, uid, -d.amount, 'withdraw', 'request');
      const r = await run(env, 'INSERT INTO withdrawals(user_id,method,details,amount,created_at) VALUES(?,?,?,?,?)', uid, d.method, text, d.amount, now());
      await clearState(env, uid);
      await send(env, uid, '✅ تسجّل طلب السحب وصار عند الإدارة. بيوصلك إشعار بس يتنفذ.', await mainKb(env, uid));
      if (env.ADMIN_ID) await send(env, env.ADMIN_ID, `💸 طلب سحب جديد #${r.meta.last_row_id}: ${fmt(d.amount)} ل.س عبر «${esc(d.method)}» من ${uid}\nالتفاصيل: ${esc(text)}`);
      return;
    }
    case 'wd_method': d.method = text; await setState(env, uid, 'wd_details', d); return send(env, uid, '📍 ابعت الرقم/العنوان يلي بدك التحويل عليه:');
    case 'wd_details': d.details = text; await setState(env, uid, 'wd_amount', d); return send(env, uid, '💸 كم المبلغ؟ (ل.س)');
    case 'wd_amount': {
      const amt = parseNum(text);
      const u = await getUser(env, uid);
      const minW = parseNum(await setting(env, 'min_withdraw', '25000'));
      if (amt < minW) { await send(env, uid, `⚠️ الحد الأدنى للسحب ${fmt(minW)} ل.س`); return; }
      if (amt > u.balance) { await send(env, uid, '⚠️ المبلغ أكبر من رصيدك.'); return; }
      await addBalance(env, uid, -amt, 'withdraw', 'request');
      await run(env, 'INSERT INTO withdrawals(user_id,method,details,amount,created_at) VALUES(?,?,?,?,?)', uid, d.method, d.details, amt, now());
      await clearState(env, uid);
      await send(env, uid, '✅ تسجّل طلب السحب وصار عند الإدارة. بيوصلك إشعار بس يتنفذ.', await mainKb(env, uid));
      if (env.ADMIN_ID) await send(env, env.ADMIN_ID, `💸 طلب سحب جديد: ${fmt(amt)} ل.س من ${uid}`);
      return;
    }
    case 'support_msg': {
      await run(env, 'INSERT INTO tickets(user_id,ref,message,created_at) VALUES(?,?,?,?)', uid, d.ref || '', text, now());
      await clearState(env, uid);
      await send(env, uid, '✅ وصلت رسالتك للدعم. منرد عليك هون بالبوت.', await mainKb(env, uid));
      if (env.ADMIN_ID) await send(env, env.ADMIN_ID, `🆘 تذكرة دعم جديدة من ${uid}:\n${esc(text)}`);
      return;
    }
    // ----- Service definition wizard (admin) -----
    case 'svc_name': d.name = text; await setState(env, uid, 'svc_price', d); return send(env, uid, '💰 سعر التنفيذ على العميل؟ (ل.س)');
    case 'svc_price': { const v = parseNum(text); if (!v || v <= 0) return send(env, uid, '⚠️ ابعت رقم صحيح أكبر من صفر:', cancelKb); d.price = v; await setState(env, uid, 'svc_pay', d); return send(env, uid, '💵 أجر العامل على التنفيذ الواحد؟ (ل.س)'); }
    case 'svc_pay': { const v = parseNum(text); if (v === null || v === undefined || isNaN(v) || v < 0) return send(env, uid, '⚠️ ابعت رقم صحيح (صفر أو أكتر):', cancelKb); d.pay = v; await setState(env, uid, 'svc_proof', d);
      return send(env, uid, '📄 نوع الإثبات المطلوب من العامل:', { inline_keyboard: [[
        { text: '🖼 صورة', callback_data: 'svp:photo' }, { text: '✍️ نص', callback_data: 'svp:text' },
        { text: '🔗 رابط', callback_data: 'svp:link' }, { text: 'أي شي', callback_data: 'svp:any' }]] });
    }
    case 'svc_inst': {
      await run(env, 'INSERT INTO services(category_id,name,price,pay,proof_type,reviewer,instructions) VALUES(?,?,?,?,?,?,?)',
        d.category_id, d.name, d.price, d.pay, d.proof_type, d.reviewer, text === '-' ? '' : text);
      const catId = d.category_id;
      await clearState(env, uid);
      await send(env, uid, `✅ انضافت الخدمة «${esc(d.name)}» — العميل بيقدر يطلبها لحالو هلأ.`);
      return svcParentView(env, uid, catId);
    }
    // ----- Client self-serve order -----
    case 'ord_desc': d.desc = text; await setState(env, uid, 'ord_qty', d); return send(env, uid, '🔢 كم شخص/تنفيذ بدك؟ (اكتب الرقم بس)');
    case 'ord_qty': {
      const qty = parseNum(text);
      if (qty < 1) return send(env, uid, '⚠️ اكتب عدد صحيح أكبر من صفر.');
      const svc = await one(env, 'SELECT * FROM services WHERE id=? AND is_active=1', d.service_id);
      if (!svc) { await clearState(env, uid); return send(env, uid, '⚠️ هالخدمة ما عادت متاحة.'); }
      d.qty = qty; d.total = svc.price * qty;
      await setState(env, uid, 'ord_confirm', d);
      const u = await getUser(env, uid);
      return send(env, uid,
        `🧾 <b>ملخص الطلب</b>\nالخدمة: ${esc(svc.name)}\nالسعر للتنفيذ: ${fmt(svc.price)} ل.س\nالعدد: ${qty}\n<b>المجموع: ${fmt(d.total)} ل.س</b>\nرصيدك الحالي: ${fmt(u.balance)} ل.س`,
        { inline_keyboard: [[
          { text: '✅ تأكيد وخصم من رصيدي', callback_data: 'ordok' },
          { text: '❌ إلغاء', callback_data: 'ordno' }]] });
    }
    case 'adm_catname': {
      const pid = d.parent_id || null;
      await run(env, 'INSERT INTO categories(parent_id,name) VALUES(?,?)', pid, text);
      await clearState(env, uid);
      await send(env, uid, `✅ انضاف التصنيف «${esc(text)}»`);
      return pid ? adminCatView(env, uid, pid) : adminCats(env, uid);
    }
    case 'adm_chan_ref': {
      const ref = normRef(text);
      const chat = await tg(env, 'getChat', { chat_id: ref });
      await clearState(env, uid);
      if (!chat.ok) return send(env, uid, `⚠️ ما قدرت أوصل لهالقناة (${esc(ref)}).\nتأكد من المعرّف، وإنو البوت @masari1bot مضاف أدمن فيها (ضروري للقنوات الخاصة)، وارجع جرّب.`, backKb);
      const title = chat.result.title || ref;
      const link = chat.result.username ? `https://t.me/${chat.result.username}` : '';
      await run(env, 'INSERT INTO forced_channels(chat_ref,title,link) VALUES(?,?,?)', ref, title, link);
      await send(env, uid, `✅ انضافت القناة «${esc(title)}» للاشتراك الإجباري.`);
      return adminChans(env, uid);
    }
    case 'adm_set': {
      const NUMKEYS = ['usd_rate', 'min_withdraw', 'ref_worker_pct', 'ref_client_pct', 'auto_approve_days', 'first_task_bonus', 'ref_milestone_every', 'ref_milestone_bonus', 'contest_prize'];
      await setSetting(env, d.key, NUMKEYS.includes(d.key) ? String(parseNum(text)) : text);
      await clearState(env, uid);
      await send(env, uid, `✅ اتحدّث «${d.key}»`);
      return adminSettings(env, uid);
    }
    case 'adm_dep_amount': {
      const dep = await one(env, 'SELECT * FROM deposits WHERE id=?', d.dep_id);
      if (dep && dep.status === 'pending') {
        const amt = parseNum(text);
        await run(env, "UPDATE deposits SET status='approved', credited=? WHERE id=?", amt, dep.id);
        await addBalance(env, dep.user_id, amt, 'deposit', `dep:${dep.id}`);
        await send(env, dep.user_id, `✅ انعتمد إيداعك وانضاف ${fmt(amt)} ل.س لرصيدك 💸`);
      }
      await clearState(env, uid);
      return adminDeps(env, uid);
    }
    case 'adm_reply': {
      const tk = await one(env, 'SELECT * FROM tickets WHERE id=?', d.ticket_id);
      if (tk) {
        await send(env, tk.user_id, `💬 <b>رد الدعم:</b>\n${esc(text)}`);
        await run(env, "UPDATE tickets SET status='answered' WHERE id=?", tk.id);
      }
      await clearState(env, uid);
      return send(env, uid, '✅ انبعت الرد.');
    }
    case 'adm_user_lookup': {
      const target = await getUser(env, parseNum(text));
      if (!target) { await send(env, uid, 'ما لقيت هالمستخدم.'); return; }
      await clearState(env, uid);
      return send(env, uid, `👤 ${esc(target.name)} (${target.tg_id})\nالرصيد: ${fmt(target.balance)} ل.س\n${target.is_banned ? '🚫 محظور' : '✅ فعال'}`,
        { inline_keyboard: [[
          { text: '✏️ تعديل الرصيد', callback_data: `adm:adj:${target.tg_id}` },
          { text: target.is_banned ? 'فك الحظر' : '🚫 حظر', callback_data: `adm:ban:${target.tg_id}` },
        ]] });
    }
    case 'adm_adj': {
      const amt = parseNum(text);
      await addBalance(env, d.target, amt, 'adjust', 'admin');
      await clearState(env, uid);
      return send(env, uid, `✅ اتعدّل رصيد ${d.target} بمقدار ${fmt(amt)} ل.س`);
    }
  }
}

// ============================================================
//  ROUTERS
// ============================================================
async function handleMessage(env, msg) {
  const uid = msg.from.id;
  const text = (msg.text || '').trim();

  // /start with optional referral: /start ref_<tg_id>
  if (text.startsWith('/start')) {
    const m = text.match(/ref_(\d+)/);
    await ensureUser(env, msg.from, m ? Number(m[1]) : null);
    await clearState(env, uid);
    if (await gate(env, uid)) {
      const me = await getUser(env, uid);
      if (!isAdmin(env, uid) && !me?.role) return rolePick(env, uid);
      const mo = text.match(/ofr_(\d+)/); if (mo) return offerView(env, uid, Number(mo[1]));
      const mt = text.match(/task_(\d+)/); if (mt) return taskCard(env, uid, Number(mt[1]));
      if (text.includes('leaders')) return leaderboard(env, uid);
      await showHome(env, uid);
    }
    return;
  }
  const u = await ensureUser(env, msg.from);
  if (u.is_banned) return send(env, uid, '🚫 حسابك محظور. راجع الدعم.');
  if (isAdmin(env, uid) && text.startsWith('/settoken ')) {
    const tok = text.slice(10).trim();
    if (tok.length > 20) {
      await run(env, "INSERT INTO settings(key,value) VALUES('bot_token',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", tok);
      _tok = tok;
      return send(env, uid, '✅ اتحفظ التوكن والبوت صار جاهز. جرّب الأزرار هلأ.');
    }
  }
  if (!(await gate(env, uid))) return;
  if (!isAdmin(env, uid) && !u.role && text !== '🔄 تبديل الدور') return rolePick(env, uid);

  // Active wizard state consumes text/photo first (except menu buttons).
  const st = await getState(env, uid);
  const isMenuBtn = ['📋 المهام المتاحة','🛠 مهامي','➕ اطلب خدمة','📦 طلباتي','👛 محفظتي','🎁 الإحالة','🆘 الدعم','👤 حسابي','👑 لوحة الأدمن','💰 قائمة الأسعار','📄 إنشاء CV','🔄 تبديل الدور','🏆 أوائل الأسبوع','/wallet','/balance','/tasks','/order'].includes(text);
  if (st.state && !isMenuBtn && (text || msg.photo)) return handleStateText(env, uid, st, msg);
  if (isMenuBtn) await clearState(env, uid);

  switch (text) {
    case '/wallet': return wallet(env, uid);
    case '/balance': {
      const me = await getUser(env, uid);
      return send(env, uid, `💰 رصيدك الحالي: <b>${fmt(me?.balance)} ل.س</b>`, await mainKb(env, uid));
    }
    case '🏆 أوائل الأسبوع': return leaderboard(env, uid);
    case '/tasks': return listCategories(env, uid);
    case '/order': return orderIntro(env, uid);
    case '📋 المهام المتاحة': return listCategories(env, uid);
    case '🛠 مهامي': return myTasks(env, uid);
    case '➕ اطلب خدمة': return orderIntro(env, uid);
    case '📦 طلباتي': {
      const rows = await all(env, 'SELECT * FROM orders WHERE client_id=? ORDER BY id DESC LIMIT 10', uid);
      const myT = await all(env, "SELECT * FROM tasks WHERE client_id=? ORDER BY id DESC LIMIT 10", uid);
      let txt = '📦 <b>طلباتك:</b>\n';
      txt += rows.length ? rows.map((o) => `• #${o.id} — ${{ new: '⏳ عند الإدارة', converted: '✅ اتحول لمهمة', rejected: '❌ مرفوض' }[o.status]}`).join('\n') : 'ما عندك طلبات.';
      if (myT.length) txt += '\n\n<b>مهامك المنشورة:</b>\n' + myT.map((t) => `• «${esc(t.title)}» — ${t.slots_done}/${t.slots_total} ${t.status === 'open' ? '(شغالة)' : '(مسكرة)'}`).join('\n');
      const myP = await all(env, 'SELECT * FROM purchases WHERE user_id=? ORDER BY id DESC LIMIT 10', uid);
      if (myP.length) txt += '\n\n<b>مشترياتك من قائمة الأسعار:</b>\n' + myP.map((p) => `• «${esc(p.offer_name)}» × ${p.qty} — ${fmt(p.total)} ل.س — ${{ awaiting_payment: '⏳ بانتظار الدفع', paid: '✅ مدفوع/قيد التنفيذ', delivered: '📦 تم التسليم', cancelled: '❌ ملغي' }[p.status]}`).join('\n');
      const pending = await one(env, `SELECT COUNT(*) n FROM claims c JOIN tasks t ON t.id=c.task_id
        WHERE c.status='submitted' AND t.reviewer='client' AND t.client_id=?`, uid);
      const kbRows = [];
      if (pending.n) kbRows.push([{ text: `🧾 إثباتات بانتظار مراجعتك (${pending.n})`, callback_data: 'myproofs' }]);
      kbRows.push([{ text: '💰 قائمة الأسعار', callback_data: 'prices' }]);
      kbRows.push([{ text: '⬅️ رجوع', callback_data: 'home' }]);
      return send(env, uid, txt, { inline_keyboard: kbRows });
    }
    case '💰 قائمة الأسعار': return priceList(env, uid);
    case '📄 إنشاء CV': return cvIntro(env, uid);
    case '🔄 تبديل الدور': return rolePick(env, uid);
    case '👛 محفظتي': return wallet(env, uid);
    case '🎁 الإحالة': return referral(env, uid);
    case '👤 حسابي': return account(env, uid);
    case '🆘 الدعم':
      await setState(env, uid, 'support_msg', {});
      return send(env, uid, '🆘 <b>الدعم</b>\nاكتب مشكلتك برسالة وحدة، وإذا بتخص مهمة معينة اكتب رقمها. الإدارة بترد عليك هون.');
    case '👑 لوحة الأدمن':
      if (isAdmin(env, uid)) return adminHome(env, uid);
      return;
    default:
      if (text) return send(env, uid, 'استخدم الأزرار تحت 👇', await mainKb(env, uid));
  }
}

async function handleCallback(env, cb) {
  const uid = cb.from.id;
  const data = cb.data || '';
  const mid = cb.message?.message_id;
  await answerCb(env, cb.id);
  const u = await ensureUser(env, cb.from);
  if (u.is_banned) return;
  if (data !== 'check_sub' && !(await gate(env, uid))) return;

  const [cmd, arg, arg2] = data.split(':');

  if (data === 'check_sub') {
    if (await gate(env, uid)) { await send(env, uid, '✅ تمام، اشتراكك مكتمل. أهلا فيك!'); return showHome(env, uid); }
    return;
  }
  if (data === 'role:client' || data === 'role:worker') {
    const role = data === 'role:client' ? 'client' : 'worker';
    await run(env, 'UPDATE users SET role=? WHERE tg_id=?', role, uid);
    await send(env, uid, role === 'client' ? '🧑‍💼 تمام — انت بصفة <b>عميل</b>.' : '👷 تمام — انت بصفة <b>عامل</b>.');
    return showHome(env, uid);
  }
  if (data === 'cv:ats' || data === 'cv:euro') {
    const sys = data === 'cv:ats' ? 'ATS' : 'Europass';
    await setState(env, uid, 'cv_name', { system: sys });
    return send(env, uid, `📄 <b>إنشاء سيرة ذاتية — نظام ${sys}</b>\nمناخد معلوماتك خطوة بخطوة (اكتب «-» لتخطي أي خانة اختيارية).\n\n١) الاسم الكامل:`, cancelKb);
  }
  if (data === 'home') return showHome(env, uid);
  if (data === 'cancel') { await clearState(env, uid); return send(env, uid, '❌ انلغت العملية.', await mainKb(env, uid)); }
  if (data === 'cats') return listCategories(env, uid);
  if (data === 'prices') return priceList(env, uid);
  if (cmd === 'ofr') return offerView(env, uid, Number(arg));
  if (cmd === 'ofrbuy') {
    const o = await one(env, 'SELECT * FROM offers WHERE id=? AND is_active=1', Number(arg));
    if (!o) return;
    await setState(env, uid, 'ofr_qty', { offer_id: o.id });
    return send(env, uid, `🔢 كم العدد المطلوب من «${esc(o.name)}»؟ (اكتب الرقم بس)`, cancelKb);
  }
  if (cmd === 'ofrpay') {
    const p = await one(env, "SELECT * FROM purchases WHERE id=? AND user_id=? AND status='awaiting_payment'", Number(arg), uid);
    if (!p) return send(env, uid, 'هالشراء انحسم أو انلغى.', backKb);
    const u = await getUser(env, uid);
    if (!u || u.balance < p.total) return send(env, uid, '⚠️ رصيدك ما بيكفي.', backKb);
    await addBalance(env, uid, -p.total, 'purchase', `purchase:${p.id}`);
    await run(env, "UPDATE purchases SET status='paid' WHERE id=?", p.id);
    await send(env, uid, `✅ <b>تم الشراء!</b>\n${esc(p.offer_name)} × ${p.qty} — انخصم ${fmt(p.total)} ل.س.\nطلبك صار عند الإدارة وبيتنفذ بأقرب وقت 👌`, await mainKb(env, uid));
    if (env.ADMIN_ID) await send(env, env.ADMIN_ID, `🧾 <b>شراء مدفوع #${p.id}</b>\n${esc(p.offer_name)} × ${p.qty} = ${fmt(p.total)} ل.س (من رصيد العميل ${uid})\nنفّذ الطلب وسلّمو من «مشتريات العملاء».`);
    return;
  }
  if (cmd === 'ofrdm') {
    const p = await one(env, "SELECT * FROM purchases WHERE id=? AND user_id=? AND status='awaiting_payment'", Number(arg), uid);
    if (!p) return send(env, uid, 'هالشراء انحسم أو انلغى.', backKb);
    const methods = JSON.parse(await setting(env, 'deposit_methods', '[]'));
    const mm = methods[Number(arg2)];
    if (!mm) return;
    await setState(env, uid, 'ofr_shot', { purchase_id: p.id, method: mm.name });
    return send(env, uid, `💳 حوّل <b>${fmt(p.total)} ل.س</b> عبر «${esc(mm.name)}» لهون:\n${esc(mm.details || '')}${await usdtLine(env, p.total, mm.name)}\n\n📸 بعد ما تحوّل، ابعت <b>سكرين شوت</b> التحويل هون (أو رقم العملية كنص).`, cancelKb);
  }
  if (cmd === 'ofrcancel') {
    await run(env, "UPDATE purchases SET status='cancelled' WHERE id=? AND user_id=? AND status='awaiting_payment'", Number(arg), uid);
    return send(env, uid, '❌ انلغى الشراء.', backKb);
  }
  if (cmd === 'cat') {
    const catId = Number(arg);
    const subs = await all(env, 'SELECT * FROM categories WHERE parent_id=? AND is_active=1 ORDER BY id', catId);
    if (subs.length) {
      const rows = subs.map((c) => [{ text: `🗂 ${c.name}`, callback_data: `cat:${c.id}` }]);
      if (isAdmin(env, uid)) rows.push([{ text: '➕ ضيف مهمة بهالتصنيف', callback_data: `adm:newtask:${catId}` }]);
      rows.push([{ text: '⬅️ رجوع للتصنيفات', callback_data: 'cats' }]);
      await send(env, uid, '🗂 <b>تصنيفات فرعية:</b>', { inline_keyboard: rows });
      const here = await all(env, "SELECT id FROM tasks WHERE category_id=? AND status='open' LIMIT 1", catId);
      if (here.length) return listTasks(env, uid, catId);
      return;
    }
    return listTasks(env, uid, catId);
  }

  if (cmd === 'take') {
    const t = await one(env, "SELECT * FROM tasks WHERE id=? AND status='open'", Number(arg));
    if (!t) return send(env, uid, '⚠️ هالمهمة سكّرت.');
    if (t.client_id === uid) return send(env, uid, '⚠️ هي مهمتك انت، ما فيك تنفذها.');
    const [ins] = await env.DB.batch([q(env, 'INSERT OR IGNORE INTO claims(task_id,worker_id,created_at) VALUES(?,?,?)', t.id, uid, now())]);
    const c = await one(env, 'SELECT * FROM claims WHERE task_id=? AND worker_id=?', t.id, uid);
    if (c.status !== 'claimed') return send(env, uid, 'أخدت هالمهمة من قبل.');
    return send(env, uid, `🛠 <b>أخدت المهمة:</b> ${esc(t.title)}\n\n📋 <b>التعليمات:</b>\n${esc(t.instructions || '—')}\n\nبس تخلص، روح «🛠 مهامي» وسلّم الإثبات.`);
  }
  if (cmd === 'mytask') return myTasks(env, uid);
  if (cmd === 'submit') {
    await setState(env, uid, 'await_proof', { claim_id: Number(arg) });
    return send(env, uid, '📤 ابعت الإثبات هلأ (صورة أو نص/رابط حسب المهمة):');
  }
  if (data === 'myproofs') {
    const rows = await reviewQueue(env, uid, 'client');
    return showProofs(env, uid, rows, 'client');
  }
  // ----- Client self-serve ordering -----
  if (data === 'ordcats') return orderCategories(env, uid);
  if (data === 'ordspecial') {
    await setState(env, uid, 'client_request', {});
    return send(env, uid, '✍️ <b>طلب خاص</b>\nاكتب شو بدك بالتفصيل برسالة وحدة. الإدارة بتراجع طلبك وبتحولو لمهمة.');
  }
  if (cmd === 'ordcat') {
    const subs = await all(env, 'SELECT * FROM categories WHERE parent_id=? AND is_active=1 ORDER BY id', Number(arg));
    if (subs.length) return orderCategories(env, uid, Number(arg));
    return orderServices(env, uid, Number(arg));
  }
  if (cmd === 'ordsel') {
    const svc = await one(env, 'SELECT * FROM services WHERE id=? AND is_active=1', Number(arg));
    if (!svc) return send(env, uid, '⚠️ هالخدمة ما عادت متاحة.');
    await setState(env, uid, 'ord_desc', { service_id: svc.id });
    return send(env, uid, `🛒 <b>${esc(svc.name)}</b> — ${fmt(svc.price)} ل.س للتنفيذ\n\n✍️ اشرح المطلوب وحط الرابط برسالة وحدة:`);
  }
  if (data === 'ordno') { await clearState(env, uid); return send(env, uid, '❌ انلغى الطلب.', await mainKb(env, uid)); }
  if (data === 'ordok') {
    const st = await getState(env, uid);
    if (st.state !== 'ord_confirm') return send(env, uid, '⚠️ انتهت هالجلسة. بلّش الطلب من جديد.');
    const d = st.data;
    await clearState(env, uid); // consume the confirmation at once — a double-tap cannot deduct twice
    const svc = await one(env, 'SELECT * FROM services WHERE id=? AND is_active=1', d.service_id);
    if (!svc) { await clearState(env, uid); return send(env, uid, '⚠️ هالخدمة ما عادت متاحة.'); }
    const total = svc.price * d.qty;
    const u = await getUser(env, uid);
    if (u.balance < total) {
      await clearState(env, uid);
      return send(env, uid, `⚠️ <b>رصيدك ما بيكفي</b>\nالمطلوب: ${fmt(total)} ل.س — رصيدك: ${fmt(u.balance)} ل.س\nاشحن محفظتك وارجع اطلب.`, { inline_keyboard: [[{ text: '➕ إيداع', callback_data: 'dep' }], [{ text: '⬅️ رجوع', callback_data: 'home' }]] });
    }
    await addBalance(env, uid, -total, 'escrow', 'order');
    const instructions = [svc.instructions, d.desc ? `— تفاصيل العميل:\n${d.desc}` : ''].filter(Boolean).join('\n');
    const r = await run(env, `INSERT INTO tasks(category_id,client_id,title,instructions,proof_type,price,pay,slots_total,reviewer,deadline,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, svc.category_id, uid, svc.name, instructions, svc.proof_type, svc.price, svc.pay, d.qty, svc.reviewer, '', now());
    const t = await one(env, 'SELECT * FROM tasks WHERE id=?', r.meta.last_row_id);
    await clearState(env, uid);
    const fresh = await getUser(env, uid);
    await send(env, uid, `✅ <b>تم طلبك ونزلت المهمة #${t.id} للعمال فوراً</b>\n📌 ${esc(svc.name)} × ${d.qty}\nانخصم ${fmt(total)} ل.س — رصيدك هلأ ${fmt(fresh.balance)} ل.س\nبتوصلك إشعارات مع كل تنفيذ بينقبل 👌`, await mainKb(env, uid));
    await notifyWorkers(env, t);
    if (env.ADMIN_ID && String(env.ADMIN_ID) !== String(uid)) await send(env, env.ADMIN_ID, `🛒 طلب ذاتي جديد: «${esc(svc.name)}» × ${d.qty} من ${uid} (${fmt(total)} ل.س)`);
    return;
  }
  if (cmd === 'ok' || cmd === 'no') {
    const claim = await one(env, 'SELECT * FROM claims WHERE id=?', Number(arg));
    if (!claim || claim.status !== 'submitted') return send(env, uid, 'هالإثبات انحسم من قبل.');
    const t = await one(env, 'SELECT * FROM tasks WHERE id=?', claim.task_id);
    const allowed = isAdmin(env, uid) || (t.reviewer === 'client' && t.client_id === uid);
    if (!allowed) return send(env, uid, '⚠️ ما إلك صلاحية تراجع هالإثبات.');
    if (cmd === 'ok') { await approveClaim(env, claim); return send(env, uid, `✅ قبلت الإثبات #${claim.id}`); }
    await rejectClaim(env, claim, uid); return send(env, uid, `❌ رفضت الإثبات #${claim.id}`);
  }

  // Wallet callbacks
  if (data === 'history') return history(env, uid);
  if (data === 'dep') {
    const methods = JSON.parse(await setting(env, 'deposit_methods', '[]'));
    if (!methods.length) return send(env, uid, '💳 وسائل الإيداع بتنضاف قريباً. راجع الدعم 🆘', backKb);
    const rows = methods.map((mm, i) => [{ text: `💳 ${mm.name}`, callback_data: `depm:${i}` }]);
    return send(env, uid, '➕ <b>إيداع</b> — اختار الوسيلة:', { inline_keyboard: rows });
  }
  if (cmd === 'depm') {
    const methods = JSON.parse(await setting(env, 'deposit_methods', '[]'));
    const mm = methods[Number(arg)];
    if (!mm) return;
    await setState(env, uid, 'dep_amount', { method: mm.name });
    return send(env, uid, `💳 <b>${esc(mm.name)}</b>\n💰 كم المبلغ يلي بدك تودعو؟ (ل.س)`, cancelKb);
  }
  if (data === 'wd') {
    const methods = JSON.parse(await setting(env, 'withdraw_methods', '[]'));
    if (!methods.length) {
      await setState(env, uid, 'wd_method', {});
      return send(env, uid, '➖ <b>سحب</b>\nاكتب وسيلة السحب (مثلا: سيريتل كاش / USDT TRC20):');
    }
    const rows = methods.map((mm, i) => [{ text: `💸 ${mm.name}`, callback_data: `wdm:${i}` }]);
    rows.push([{ text: '❌ إلغاء', callback_data: 'cancel' }]);
    return send(env, uid, '➖ <b>سحب</b> — اختار الوسيلة:', { inline_keyboard: rows });
  }
  if (cmd === 'wdm') {
    const methods = JSON.parse(await setting(env, 'withdraw_methods', '[]'));
    const mm = methods[Number(arg)];
    if (!mm) return;
    await setState(env, uid, 'wd_amount2', { method: mm.name });
    const minW = parseNum(await setting(env, 'min_withdraw', '25000'));
    return send(env, uid, `💸 <b>${esc(mm.name)}</b>\n💰 كم المبلغ يلي بدك تسحبو؟ (ل.س) — الحد الأدنى ${fmt(minW)} ل.س`, cancelKb);
  }

  // ---------- Admin ----------
  if (!data.startsWith('adm') && !['twc', 'twp', 'twr', 'twf', 'svp', 'svr'].includes(cmd)) return;
  if (cmd === 'twc' || cmd === 'twp' || cmd === 'twr' || cmd === 'twf' || cmd === 'svp' || cmd === 'svr') {
    if (!isAdmin(env, uid)) return;
    const st = await getState(env, uid); const d = st.data;
    if (cmd === 'twc') { d.category_id = Number(arg); await setState(env, uid, 'tw_inst', d); return send(env, uid, '📋 اكتب تعليمات التنفيذ للعامل (أو «-» إذا ما في):'); }
    if (cmd === 'twp') { d.proof_type = arg; await setState(env, uid, 'tw_price', d); return send(env, uid, '💰 سعر التنفيذ على العميل؟ (ل.س)'); }
    if (cmd === 'twr') { d.reviewer = arg === 'client' && d.client_id ? 'client' : 'admin'; await setState(env, uid, 'tw_dead', d); return send(env, uid, '⏰ المهلة؟ (اكتبها نصاً، أو «-» لتخطيها)', { inline_keyboard: [[{ text: '⏭ نشر فوراً بدون مهلة', callback_data: 'twf:skip' }]] }); }
    if (cmd === 'twf') { d.deadline = ''; await clearState(env, uid); return publishTask(env, uid, d); }
    if (cmd === 'svp') { d.proof_type = arg; await setState(env, uid, 'svc_rev', d);
      return send(env, uid, '👁 مين بيراجع إثباتات هالخدمة عادة؟', { inline_keyboard: [[
        { text: '👑 أنا (الأدمن)', callback_data: 'svr:admin' }, { text: '🧑‍💼 العميل الطالب', callback_data: 'svr:client' }]] }); }
    if (cmd === 'svr') { d.reviewer = arg; await setState(env, uid, 'svc_inst', d); return send(env, uid, '📋 تعليمات ثابتة بتنحط مع كل طلب لهالخدمة (أو «-» إذا ما في):'); }
    return;
  }
  if (!isAdmin(env, uid)) return;

  if (data.startsWith('prcp:')) {
    if (!isAdmin(env, uid)) return send(env, uid, 'هاد القسم للأدمن بس.', backKb);
    await setState(env, uid, 'adm_svcprice', { svc: Number(data.slice(5)) });
    return send(env, uid, '✏️ ابعت <b>سعر العميل</b> الجديد للتنفيذ الواحد (رقم بالليرة):', cancelKb);
  }
  if (data.startsWith('prcy:')) {
    if (!isAdmin(env, uid)) return send(env, uid, 'هاد القسم للأدمن بس.', backKb);
    await setState(env, uid, 'adm_svcpay', { svc: Number(data.slice(5)) });
    return send(env, uid, '✏️ ابعت <b>أجر العامل</b> الجديد للتنفيذ الواحد (رقم بالليرة):', cancelKb);
  }
  if (data === 'adm:home') return adminHome(env, uid);
  if (cmd === 'adm' && arg === 'grp') {
    if (arg2 === 'work') return send(env, uid, '📋 <b>المهام والتصنيفات</b>', adminWorkKb);
    if (arg2 === 'money') return send(env, uid, '💰 <b>المالية</b>', adminMoneyKb);
    if (arg2 === 'people') return send(env, uid, '👥 <b>المستخدمين والدعم</b>', adminPeopleKb);
    if (arg2 === 'sys') return send(env, uid, '⚙️ <b>النظام</b>', adminSysKb);
    return;
  }
  if (cmd === 'adm' && arg === 'newtask' && arg2) {
    await setState(env, uid, 'tw_title', { client_id: null, category_id: Number(arg2) });
    return send(env, uid, '➕ <b>مهمة جديدة</b> (التصنيف محدد جاهز)\nعنوان المهمة:');
  }
  if (data === 'adm:prices') return adminOffers(env, uid);
  if (data === 'adm:buys') return adminBuys(env, uid);
  if (data === 'adm:cvs') return adminCvs(env, uid);
  if (cmd === 'adm' && arg === 'cvdone') {
    const r = await one(env, "SELECT * FROM cv_requests WHERE id=? AND status='new'", Number(arg2));
    if (r) { await run(env, "UPDATE cv_requests SET status='done' WHERE id=?", r.id); await send(env, r.user_id, `📄 <b>سيرتك الذاتية جاهزة!</b>\nاكتمل طلب السيرة #${r.id} ✅ — تواصل مع الدعم لاستلامها.`); return send(env, uid, '✔️ تسجل كمُنجز.'); }
    return send(env, uid, 'هالطلب انحسم من قبل.');
  }
  if (data === 'adm:addofr') { await setState(env, uid, 'ofr_name', {}); return send(env, uid, '🛒 اسم الخدمة الثابتة (متل ما بيشوفها العميل بقائمة الأسعار):', cancelKb); }
  if (cmd === 'adm' && arg === 'ofrprice') { await setState(env, uid, 'adm_ofr_price', { offer_id: Number(arg2) }); return send(env, uid, '✏️ ابعت السعر الجديد للوحدة (ل.س):', cancelKb); }
  if (cmd === 'adm' && arg === 'ofrdet') { await setState(env, uid, 'adm_ofr_details', { offer_id: Number(arg2) }); return send(env, uid, '✏️ ابعت الشرح الجديد (أو «-» لمسحو):', cancelKb); }
  if (cmd === 'adm' && arg === 'delofr') { await run(env, 'DELETE FROM offers WHERE id=?', Number(arg2)); await send(env, uid, '🗑 انحذفت الخدمة الثابتة.'); return adminOffers(env, uid); }
  if (cmd === 'adm' && arg === 'buydone') {
    const p = await one(env, "SELECT * FROM purchases WHERE id=? AND status='paid'", Number(arg2));
    if (p) { await run(env, "UPDATE purchases SET status='delivered' WHERE id=?", p.id); await send(env, p.user_id, `📦 <b>تم تسليم طلبك!</b>\n${esc(p.offer_name)} × ${p.qty} — اكتمل الشراء #${p.id} ✅`); return send(env, uid, '📦 تسجل كمُسلَّم.'); }
    return send(env, uid, 'هالشراء انحسم من قبل.');
  }
  if (data === 'adm:cats') return adminCats(env, uid);
  if (cmd === 'adm' && arg === 'cat') return adminCatView(env, uid, Number(arg2));
  if (cmd === 'adm' && arg === 'sub') return adminSubView(env, uid, Number(arg2));
  if (cmd === 'adm' && arg === 'svc') return adminSvcView(env, uid, Number(arg2));
  if (cmd === 'adm' && arg === 'delpick') return adminDelPick(env, uid, Number(arg2));
  if (cmd === 'adm' && arg === 'back2cat') return svcParentView(env, uid, Number(arg2));
  if (cmd === 'adm' && arg === 'delsvc2') {
    const s = await one(env, 'SELECT * FROM services WHERE id=?', Number(arg2));
    if (s) { await run(env, 'DELETE FROM services WHERE id=?', s.id); await send(env, uid, '🗑 انحذفت المهمة.'); return svcParentView(env, uid, s.category_id); }
    return adminCats(env, uid);
  }
  if (cmd === 'adm' && arg === 'addsvc') { await setState(env, uid, 'svc_name', { category_id: Number(arg2) }); return send(env, uid, '🛠 <b>مهمة جديدة</b> — بتنحط تحت هالخانة لحالها.\nاسم المهمة (متل ما بيشوفها العميل):'); }
  if (data === 'adm:tasks') return adminTasks(env, uid);
  if (cmd === 'adm' && arg === 'closetask') {
    const t = await one(env, "SELECT * FROM tasks WHERE id=? AND status='open'", Number(arg2));
    if (!t) return send(env, uid, 'هالمهمة مسكرة من قبل.');
    const clientId = t.client_id;
    await closeTaskRefund(env, t);
    if (clientId) await send(env, clientId, `🔒 سكّرت الإدارة المهمة «${esc(t.title)}» ورجعلك رصيد الخانات يلي ما تنفذت.`);
    return send(env, uid, `🔒 انسكّرت المهمة #${t.id}.`);
  }
  if (cmd === 'adm' && arg === 'addcat') { await setState(env, uid, 'adm_catname', { parent_id: Number(arg2) || null }); return send(env, uid, 'اسم التصنيف:'); }
  if (cmd === 'adm' && arg === 'delcat') {
    const id = Number(arg2);
    const subs = await all(env, 'SELECT id FROM categories WHERE parent_id=?', id);
    for (const cid of [id, ...subs.map((s) => s.id)]) await run(env, 'DELETE FROM services WHERE category_id=?', cid);
    await run(env, 'DELETE FROM categories WHERE id=? OR parent_id=?', id, id);
    await send(env, uid, '🗑 انحذف.');
    return adminCats(env, uid);
  }
  if (data === 'adm:newtask') { await setState(env, uid, 'tw_title', { client_id: null }); return send(env, uid, '➕ <b>مهمة جديدة</b>\nعنوان المهمة:'); }
  if (data === 'adm:orders') return adminOrders(env, uid);
  if (cmd === 'adm' && arg === 'convert') {
    const o = await one(env, "SELECT * FROM orders WHERE id=? AND status='new'", Number(arg2));
    if (!o) return send(env, uid, 'هالطلب انحسم.');
    await setState(env, uid, 'tw_title', { client_id: o.client_id, order_id: o.id });
    return send(env, uid, `🛠 تحويل الطلب #${o.id} لمهمة.\nنص الطلب: ${esc(o.text)}\n\nعنوان المهمة:`);
  }
  if (cmd === 'adm' && arg === 'rejorder') {
    await run(env, "UPDATE orders SET status='rejected' WHERE id=?", Number(arg2));
    const o = await one(env, 'SELECT * FROM orders WHERE id=?', Number(arg2));
    if (o) await send(env, o.client_id, `❌ انرفض طلب الخدمة #${o.id}. راجع الدعم للتفاصيل.`);
    return send(env, uid, '❌ انرفض الطلب.');
  }
  if (data === 'adm:proofs') { const rows = await reviewQueue(env, uid, 'admin'); return showProofs(env, uid, rows, 'adm'); }
  if (data === 'adm:deps') return adminDeps(env, uid);
  if (data === 'adm:wdmet') return adminWdMethods(env, uid);
  if (data === 'adm:addwmet') { await setState(env, uid, 'wmet_name', {}); return send(env, uid, '💸 اسم وسيلة السحب (مثلا: سيريتل كاش / USDT TRC20):', cancelKb); }
  if (cmd === 'adm' && arg === 'delwmet') {
    const methods = JSON.parse(await setting(env, 'withdraw_methods', '[]'));
    methods.splice(Number(arg2), 1);
    await saveWdMethods(env, methods);
    return adminWdMethods(env, uid);
  }
  if (data === 'adm:depmet') return adminDepMethods(env, uid);
  if (data === 'adm:addmet') { await setState(env, uid, 'met_name', {}); return send(env, uid, '🏦 اسم وسيلة الإيداع (مثلا: سيريتل كاش / USDT TRC20):', cancelKb); }
  if (cmd === 'adm' && arg === 'delmet') {
    const methods = JSON.parse(await setting(env, 'deposit_methods', '[]'));
    methods.splice(Number(arg2), 1);
    await saveDepMethods(env, methods);
    return adminDepMethods(env, uid);
  }
  if (cmd === 'adm' && arg === 'depshot') {
    const dep = await one(env, 'SELECT * FROM deposits WHERE id=?', Number(arg2));
    if (dep?.proof_file) await tg(env, 'sendPhoto', { chat_id: uid, photo: dep.proof_file, caption: `📷 سكرين شوت إيداع #${dep.id} — ${fmt(dep.amount)} ل.س` });
    return;
  }
  if (cmd === 'adm' && arg === 'depok') {
    const dep = await one(env, 'SELECT * FROM deposits WHERE id=?', Number(arg2));
    if (!dep || dep.status !== 'pending') return send(env, uid, 'هالإيداع انحسم من قبل.');
    if (dep.ref && dep.ref.startsWith('purchase:')) {
      const pid = Number(dep.ref.slice(9));
      const p = await one(env, "SELECT * FROM purchases WHERE id=? AND status='awaiting_payment'", pid);
      await run(env, "UPDATE deposits SET status='approved', credited=? WHERE id=?", dep.amount, dep.id);
      if (p) {
        await run(env, "UPDATE purchases SET status='paid' WHERE id=?", p.id);
        await send(env, dep.user_id, `✅ <b>تم الشراء!</b>\nانقبل دفعك وصار طلبك «${esc(p.offer_name)} × ${p.qty}» قيد التنفيذ عند الإدارة 👌`);
        return send(env, uid, `✅ اعتمد إيداع الشراء — الشراء #${p.id} صار مدفوع وبانتظار تسليمك.`);
      }
      return send(env, uid, '✅ اعتمد الإيداع (الشراء ما عاد بانتظار الدفع).');
    }
    if (dep.amount > 0) {
      await run(env, "UPDATE deposits SET status='approved', credited=? WHERE id=?", dep.amount, dep.id);
      await addBalance(env, dep.user_id, dep.amount, 'deposit', `dep:${dep.id}`);
      await send(env, dep.user_id, `✅ <b>انضاف إيداعك!</b>\nانضاف ${fmt(dep.amount)} ل.س لرصيدك 💸`);
      return send(env, uid, `✅ اعتمد الإيداع #${dep.id} وانضاف ${fmt(dep.amount)} ل.س للمستخدم.`);
    }
    await setState(env, uid, 'adm_dep_amount', { dep_id: dep.id });
    return send(env, uid, '💰 كم المبلغ يلي بينضاف لرصيد المستخدم؟ (ل.س)');
  }
  if (cmd === 'adm' && arg === 'deprej') {
    const dep = await one(env, 'SELECT * FROM deposits WHERE id=?', Number(arg2));
    if (dep?.status === 'pending') {
      await run(env, "UPDATE deposits SET status='rejected' WHERE id=?", dep.id);
      if (dep.ref && dep.ref.startsWith('purchase:')) {
        const pid = Number(dep.ref.slice(9));
        await run(env, "UPDATE purchases SET status='cancelled' WHERE id=? AND status='awaiting_payment'", pid);
        await send(env, dep.user_id, '❌ انرفض إثبات دفع الشراء وانلغى الطلب. راجع الدعم.');
      } else {
        await send(env, dep.user_id, '❌ انرفض طلب الإيداع تبعك. راجع الدعم.');
      }
    }
    return send(env, uid, '❌ انرفض الإيداع.');
  }
  if (data === 'adm:wds') return adminWds(env, uid);
  if (cmd === 'adm' && arg === 'wdok') {
    const w = await one(env, 'SELECT * FROM withdrawals WHERE id=?', Number(arg2));
    if (w?.status === 'pending') {
      await run(env, "UPDATE withdrawals SET status='approved' WHERE id=?", w.id);
      await send(env, w.user_id, `✅ تنفذ سحبك: ${fmt(w.amount)} ل.س 💸`);
      await promoPost(env, `✅ <b>إثبات سحب جديد من مصاري</b>\nعامل سحب اليوم <b>${fmt(w.amount)} ل.س</b> 💸\nنفّذ مهام واجمع مصاريك متلو 👇`, { inline_keyboard: [[{ text: '🤖 افتح بوت مصاري', url: await deepLink(env, '') }]] });
    }
    return send(env, uid, '✅ تسجل كمُدفوع.');
  }
  if (cmd === 'adm' && arg === 'wdrej') {
    const w = await one(env, 'SELECT * FROM withdrawals WHERE id=?', Number(arg2));
    if (w?.status === 'pending') {
      await run(env, "UPDATE withdrawals SET status='rejected' WHERE id=?", w.id);
      await addBalance(env, w.user_id, w.amount, 'refund', `wd:${w.id}`);
      await send(env, w.user_id, '❌ انرفض طلب السحب ورجع المبلغ لرصيدك.');
    }
    return send(env, uid, '❌ انرفض السحب ورجع الرصيد.');
  }
  if (data === 'adm:chans') return adminChans(env, uid);
  if (data === 'adm:addchan') { await setState(env, uid, 'adm_chan_ref', {}); return send(env, uid, '📢 ابعت <b>معرّف القناة بس</b> (@username أو الرقم أو الرابط) — وأنا بسحب اسمها وبحطو لحالي:'); }
  if (cmd === 'adm' && arg === 'delchan') { await run(env, 'DELETE FROM forced_channels WHERE id=?', Number(arg2)); return adminChans(env, uid); }
  if (data === 'adm:tickets') {
    const rows = await all(env, "SELECT * FROM tickets WHERE status='open' ORDER BY id DESC LIMIT 10");
    if (!rows.length) return send(env, uid, '🆘 ما في تذاكر مفتوحة.', adminKb);
    for (const tk of rows) {
      await send(env, uid, `🆘 <b>تذكرة #${tk.id}</b> من ${tk.user_id}:\n${esc(tk.message)}`,
        { inline_keyboard: [[{ text: '💬 رد', callback_data: `adm:reply:${tk.id}` }]] });
    }
    return;
  }
  if (cmd === 'adm' && arg === 'reply') { await setState(env, uid, 'adm_reply', { ticket_id: Number(arg2) }); return send(env, uid, 'اكتب الرد:'); }
  if (data === 'adm:users') { await setState(env, uid, 'adm_user_lookup', {}); return send(env, uid, '👥 ابعت الآيدي الرقمي للمستخدم:'); }
  if (cmd === 'adm' && arg === 'adj') { await setState(env, uid, 'adm_adj', { target: Number(arg2) }); return send(env, uid, 'المبلغ؟ (موجب للإضافة، سالب للخصم)'); }
  if (cmd === 'adm' && arg === 'ban') {
    const target = await getUser(env, Number(arg2));
    await run(env, 'UPDATE users SET is_banned=? WHERE tg_id=?', target.is_banned ? 0 : 1, target.tg_id);
    return send(env, uid, target.is_banned ? '✅ انفك الحظر.' : '🚫 انحظر المستخدم.');
  }
  if (data === 'adm:settings') return adminSettings(env, uid);
  if (cmd === 'adm' && arg === 'set') { await setState(env, uid, 'adm_set', { key: arg2 }); return send(env, uid, `القيمة الجديدة لـ ${arg2}:`); }
  if (data === 'adm:stats') return adminStats(env, uid);
}

// ---------- Scheduled: auto-approve stale client-reviewed proofs ----------
async function scheduled(env) {
  const days = parseNum(await setting(env, 'auto_approve_days', '3'));
  const cutoff = now() - days * 86400;
  const stale = await all(env, `SELECT c.* FROM claims c JOIN tasks t ON t.id=c.task_id
    WHERE c.status='submitted' AND t.reviewer='client' AND c.submitted_at>0 AND c.submitted_at<?`, cutoff);
  for (const c of stale) await approveClaim(env, c);
  // Weekly contest: Friday evening (Damascus) — post the leaderboard to the promo channel and pay the winner.
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Damascus', weekday: 'short', hour: '2-digit', hour12: false }).formatToParts(new Date());
    const wd = parts.find((p) => p.type === 'weekday')?.value;
    const hr = Number(parts.find((p) => p.type === 'hour')?.value || 0);
    if (wd === 'Fri' && hr >= 18) {
      const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Damascus', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const guardKey = `contest_week_${dayKey}`;
      if (!(await setting(env, guardKey, ''))) {
        const rows = await topWorkers(env);
        if (rows.length) {
          const prize = parseNum(await setting(env, 'contest_prize', '0'));
          const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
          const lines = [];
          for (let i = 0; i < rows.length; i++) { const w = await getUser(env, rows[i].worker_id); lines.push(`${medals[i]} ${esc(w?.name || 'عامل')} — ${rows[i].n} تنفيذ (${fmt(rows[i].earned)} ل.س)`); }
          if (prize > 0) {
            const winner = await getUser(env, rows[0].worker_id);
            await addBalance(env, rows[0].worker_id, prize, 'earn', 'contest');
            await send(env, rows[0].worker_id, `🏆 <b>مبروك! انت الأول هالأسبوع</b> — انضافت جائزتك ${fmt(prize)} ل.س لرصيدك 🎉`);
            lines.push(`\n🎁 جائزة الأول (${fmt(prize)} ل.س) راحت لـ ${esc(winner?.name || 'الأول')} ✅`);
          }
          await promoPost(env, `🏆 <b>أوائل الأسبوع على مصاري</b>\n\n${lines.join('\n')}\n\nنفّذ مهام هالأسبوع وكون انت الأول الجاية 👇`, { inline_keyboard: [[{ text: '🏆 شوف الأوائل', url: await deepLink(env, 'leaders') }]] });
        }
        await setSetting(env, guardKey, '1');
      }
    }
  } catch (e) {}
}

// ---------- One-time schema setup (mirrors schema.sql) ----------
// Runs through the Worker's own D1 binding: GET /__setup?key=<WEBHOOK_SECRET>
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (tg_id INTEGER PRIMARY KEY, name TEXT DEFAULT '', username TEXT DEFAULT '', balance INTEGER NOT NULL DEFAULT 0, referrer_id INTEGER, is_banned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER, name TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS services (id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER, name TEXT NOT NULL, price INTEGER NOT NULL DEFAULT 0, pay INTEGER NOT NULL DEFAULT 0, proof_type TEXT NOT NULL DEFAULT 'any', reviewer TEXT NOT NULL DEFAULT 'admin', instructions TEXT DEFAULT '', is_active INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER, client_id INTEGER, title TEXT NOT NULL, instructions TEXT DEFAULT '', proof_type TEXT NOT NULL DEFAULT 'any', price INTEGER NOT NULL DEFAULT 0, pay INTEGER NOT NULL DEFAULT 0, slots_total INTEGER NOT NULL DEFAULT 1, slots_done INTEGER NOT NULL DEFAULT 0, reviewer TEXT NOT NULL DEFAULT 'admin', status TEXT NOT NULL DEFAULT 'open', deadline TEXT DEFAULT '', created_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS claims (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, worker_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'claimed', proof_text TEXT DEFAULT '', proof_file TEXT DEFAULT '', created_at INTEGER NOT NULL DEFAULT 0, submitted_at INTEGER DEFAULT 0, reviewed_at INTEGER DEFAULT 0, UNIQUE(task_id, worker_id))`,
  `CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', created_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS deposits (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, method TEXT NOT NULL, note TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', credited INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS withdrawals (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, method TEXT NOT NULL, details TEXT DEFAULT '', amount INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS txns (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL DEFAULT 0, ref TEXT DEFAULT '', created_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS forced_channels (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_ref TEXT NOT NULL, title TEXT DEFAULT '', link TEXT DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, ref TEXT DEFAULT '', message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS ustate (user_id INTEGER PRIMARY KEY, state TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}')`,
  `CREATE TABLE IF NOT EXISTS offers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, details TEXT DEFAULT '', price INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS purchases (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, offer_id INTEGER, offer_name TEXT DEFAULT '', qty INTEGER NOT NULL DEFAULT 1, total INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'awaiting_payment', deposit_id INTEGER, created_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS cv_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, system TEXT DEFAULT '', data TEXT DEFAULT '{}', status TEXT NOT NULL DEFAULT 'new', created_at INTEGER NOT NULL DEFAULT 0)`,
  `INSERT OR IGNORE INTO settings(key, value) VALUES ('ref_worker_pct', '5'), ('ref_client_pct', '10'), ('min_withdraw', '25000'), ('auto_approve_days', '3'), ('welcome_text', 'أهلا فيك بـ مصاري 💸\nنفّذ مهام واجمع مصاريك، أو اطلب خدمة وخلي التنفيذ علينا.'), ('deposit_methods', '[]'), ('promo_channel', ''), ('first_task_bonus', '0'), ('ref_milestone_every', '0'), ('ref_milestone_bonus', '0'), ('contest_prize', '0')`,
];

const MIGRATIONS = [
  `ALTER TABLE deposits ADD COLUMN amount INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE deposits ADD COLUMN proof_file TEXT DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN role TEXT DEFAULT ''`,
  `ALTER TABLE deposits ADD COLUMN ref TEXT DEFAULT ''`,
];

// ---------- Entry ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/__setup') {
      if (!env.WEBHOOK_SECRET || url.searchParams.get('key') !== env.WEBHOOK_SECRET)
        return new Response('forbidden', { status: 403 });
      if (!env.DB) return new Response('DB binding missing', { status: 500 });
      await env.DB.batch(SCHEMA_STATEMENTS.map((s) => env.DB.prepare(s)));
      for (const m of MIGRATIONS) { try { await env.DB.prepare(m).run(); } catch (e) {} }
      return new Response('setup ok');
    }
    if (url.pathname === '/__chans') {
      if (!env.WEBHOOK_SECRET || url.searchParams.get('key') !== env.WEBHOOK_SECRET)
        return new Response('forbidden', { status: 403 });
      const me = await tg(env, 'getMe');
      const chans = await all(env, 'SELECT * FROM forced_channels ORDER BY id');
      const out = [];
      for (const c of chans) {
        const r = await tg(env, 'getChatMember', { chat_id: normRef(c.chat_ref), user_id: me?.result?.id });
        out.push({ id: c.id, ref: c.chat_ref, title: c.title, link: c.link, bot_check_ok: !!r.ok, bot_status: r?.result?.status || null, err: r.description || null });
      }
      return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/__cats') {
      if (!env.WEBHOOK_SECRET || url.searchParams.get('key') !== env.WEBHOOK_SECRET)
        return new Response('forbidden', { status: 403 });
      const cats = await all(env, 'SELECT id,parent_id,name FROM categories ORDER BY id');
      const svcs = await all(env, 'SELECT id,category_id,name,price,pay FROM services ORDER BY id');
      return new Response(JSON.stringify({ cats, svcs }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/__dbg') {
      if (!env.WEBHOOK_SECRET || url.searchParams.get('key') !== env.WEBHOOK_SECRET)
        return new Response('forbidden', { status: 403 });
      const dm = await env.DB.prepare("SELECT value FROM settings WHERE key='deposit_methods'").first();
      const dbg = await env.DB.prepare("SELECT value FROM settings WHERE key='dbg_state'").first();
      const states = await all(env, 'SELECT * FROM ustate');
      const offers = await all(env, 'SELECT * FROM offers');
      return new Response(JSON.stringify({ deposit_methods: dm?.value ?? null, dbg_state: dbg?.value ?? null, states, offers }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/__buys') {
      if (!env.WEBHOOK_SECRET || url.searchParams.get('key') !== env.WEBHOOK_SECRET)
        return new Response('forbidden', { status: 403 });
      const offers = await all(env, 'SELECT id,name,price FROM offers ORDER BY id');
      const purchases = await all(env, 'SELECT id,user_id,offer_name,qty,total,status,deposit_id FROM purchases ORDER BY id');
      const deposits = await all(env, 'SELECT id,user_id,amount,status,ref FROM deposits ORDER BY id');
      const cvs = await all(env, 'SELECT id,user_id,system,status FROM cv_requests ORDER BY id');
      const rate = await env.DB.prepare("SELECT value FROM settings WHERE key='usd_rate'").first();
      return new Response(JSON.stringify({ offers, purchases, deposits, cvs, usd_rate: rate?.value ?? null }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/__whoami') {
      if (!env.WEBHOOK_SECRET || url.searchParams.get('key') !== env.WEBHOOK_SECRET)
        return new Response('forbidden', { status: 403 });
      const me = await tg(env, 'getMe');
      return new Response(JSON.stringify({ ok: me.ok, id: me?.result?.id || null, username: me?.result?.username || null, description: me.description || null }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (request.method === 'POST' && url.pathname === `/webhook/${env.WEBHOOK_SECRET}`) {
      const upd = await request.json().catch(() => null);
      try {
        if (upd?.message) await handleMessage(env, upd.message);
        else if (upd?.callback_query) await handleCallback(env, upd.callback_query);
      } catch (e) {
        return new Response(`ERR: ${e?.message || e}\n${(e?.stack || '').split('\n').slice(0, 4).join('\n')}`, { status: 500 });
      }
      return new Response('ok');
    }
    if (url.pathname === '/') return new Response('Masari bot is running.');
    return new Response('not found', { status: 404 });
  },
  async scheduled(event, env) { await scheduled(env); },
};
