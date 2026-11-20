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
async function tg(env, method, body = {}) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
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
async function missingChannels(env, uid) {
  const chans = await all(env, 'SELECT * FROM forced_channels ORDER BY id');
  const missing = [];
  for (const c of chans) {
    const r = await tg(env, 'getChatMember', { chat_id: c.chat_ref, user_id: uid });
    const st = r?.result?.status;
    if (!r.ok || ['left', 'kicked'].includes(st)) missing.push(c);
  }
  return missing;
}
async function gate(env, uid) {
  // returns true if the user may use the bot; otherwise sends the join prompt
  if (isAdmin(env, uid)) return true;
  const missing = await missingChannels(env, uid);
  if (!missing.length) return true;
  const rows = missing.map((c) => [{ text: `📢 اشترك بـ ${c.title || c.chat_ref}`, url: c.link || `https://t.me/${String(c.chat_ref).replace('@', '')}` }]);
  rows.push([{ text: '✅ تحققت — أنا اشتركت', callback_data: 'check_sub' }]);
  await send(env, uid, '⛔ <b>لازم تشترك بالقنوات التالية أولاً لتقدر تستخدم البوت:</b>', { inline_keyboard: rows });
  return false;
}

// ---------- Keyboards ----------
const mainKb = (env, uid) => {
  const rows = [
    [{ text: '📋 المهام المتاحة' }, { text: '🛠 مهامي' }],
    [{ text: '➕ اطلب خدمة' }, { text: '📦 طلباتي' }],
    [{ text: '👛 محفظتي' }, { text: '🎁 الإحالة' }],
    [{ text: '🆘 الدعم' }, { text: '👤 حسابي' }],
  ];
  if (isAdmin(env, uid)) rows.push([{ text: '👑 لوحة الأدمن' }]);
  return { keyboard: rows, resize_keyboard: true };
};
const backKb = { inline_keyboard: [[{ text: '⬅️ رجوع', callback_data: 'home' }]] };

async function showHome(env, uid) {
  const u = await getUser(env, uid);
  const welcome = await setting(env, 'welcome_text', 'أهلا فيك بـ مصاري 💸');
  await send(env, uid, `${esc(welcome)}\n\n👛 رصيدك: <b>${fmt(u?.balance)} ل.س</b>`, mainKb(env, uid));
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
  const kb = { inline_keyboard: [
    [{ text: '➕ إيداع', callback_data: 'dep' }, { text: '➖ سحب', callback_data: 'wd' }],
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
    `👥 إحالاتك: ${count.n} شخص\n💰 مجموع أرباحك من الإحالة: ${fmt(earned.s)} ل.س\n\n🔗 رابطك:\n${link}`, backKb);
}

// ---------- Client price list (services, client-facing prices only) ----------
async function priceList(env, uid) {
  const svcs = await all(env, `SELECT s.*, c.name cname, p.name pname FROM services s
    LEFT JOIN categories c ON c.id=s.category_id LEFT JOIN categories p ON p.id=c.parent_id
    WHERE s.is_active=1 ORDER BY c.parent_id, c.id, s.id`);
  if (!svcs.length) return send(env, uid, '💰 ما في خدمات منشورة حالياً. تابعنا 👌', backKb);
  let txt = '💰 <b>قائمة الأسعار للعملاء</b>\nالسعر عن كل تنفيذ واحد:\n';
  let lastCat = '';
  for (const s of svcs) {
    const cat = `${s.pname ? esc(s.pname) + ' / ' : ''}${esc(s.cname || 'بدون تصنيف')}`;
    if (cat !== lastCat) { txt += `\n🗂 <b>${cat}</b>\n`; lastCat = cat; }
    txt += `• ${esc(s.name)} — <b>${fmt(s.price)} ل.س</b>\n`;
  }
  txt += '\nللطلب روح «➕ اطلب خدمة» واختار من القائمة 👌';
  await send(env, uid, txt, backKb);
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

  // Referrals — paid out of the platform commission (price - pay), capped by it.
  let commission = Math.max(0, t.price - t.pay);
  const worker = await getUser(env, claim.worker_id);
  if (worker?.referrer_id) {
    const pct = Number(await setting(env, 'ref_worker_pct', '5'));
    const amt = Math.min(commission, Math.floor((t.pay * pct) / 100));
    if (amt > 0) { await addBalance(env, worker.referrer_id, amt, 'referral', `task:${t.id}`); commission -= amt; }
  }
  if (t.client_id) {
    const client = await getUser(env, t.client_id);
    if (client?.referrer_id) {
      const pct = Number(await setting(env, 'ref_client_pct', '10'));
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
  [{ text: '➕ مهمة جديدة', callback_data: 'adm:newtask' }, { text: '🗂 التصنيفات', callback_data: 'adm:cats' }],
  [{ text: '🗂 المهام المفتوحة', callback_data: 'adm:tasks' }, { text: '✅ إثباتات بانتظاري', callback_data: 'adm:proofs' }],
  [{ text: '📥 طلبات خاصة', callback_data: 'adm:orders' }],
  [{ text: '⬅️ رجوع للوحة', callback_data: 'adm:home' }],
]};
const adminMoneyKb = { inline_keyboard: [
  [{ text: '💰 إيداعات معلقة', callback_data: 'adm:deps' }, { text: '💸 سحوبات معلقة', callback_data: 'adm:wds' }],
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
  const cats = await all(env, 'SELECT c.*, p.name pname FROM categories c LEFT JOIN categories p ON p.id=c.parent_id ORDER BY c.id');
  const txt = cats.length ? cats.map((c) => `• ${c.parent_id ? `↳ ${esc(c.pname)} / ` : ''}<b>${esc(c.name)}</b> (#${c.id})`).join('\n') : 'ما في تصنيفات لسا.';
  const kb = { inline_keyboard: [
    [{ text: '➕ تصنيف رئيسي', callback_data: 'adm:addcat:0' }, { text: '➕ مهمة جديدة', callback_data: 'adm:newtask' }],
    ...cats.flatMap((c) => [
      [{ text: `🛠 خدمات «${c.name}»`, callback_data: `adm:svcs:${c.id}` }, { text: `➕ مهمة بـ «${c.name}»`, callback_data: `adm:newtask:${c.id}` }],
      [{ text: `↳ فرعي تحت «${c.name}»`, callback_data: `adm:addcat:${c.id}` }, { text: `🗑 حذف «${c.name}»`, callback_data: `adm:delcat:${c.id}` }],
    ]),
    [{ text: '⬅️ رجوع', callback_data: 'adm:grp:work' }],
  ]};
  await send(env, uid, `🗂 <b>التصنيفات:</b>\n${txt}`, kb);
}

async function adminSvcs(env, uid, catId) {
  const cat = await one(env, 'SELECT * FROM categories WHERE id=?', catId);
  const svcs = await all(env, 'SELECT * FROM services WHERE category_id=? ORDER BY id', catId);
  const txt = svcs.length
    ? svcs.map((s) => `• <b>${esc(s.name)}</b> — عميل ${fmt(s.price)} / عامل ${fmt(s.pay)} ل.س`).join('\n')
    : 'ما في خدمات بهالتصنيف لسا.';
  const kb = { inline_keyboard: [
    [{ text: '➕ خدمة جديدة هون', callback_data: `adm:addsvc:${catId}` }],
    ...svcs.map((s) => [{ text: `🗑 حذف «${s.name}»`, callback_data: `adm:delsvc:${s.id}:${catId}` }]),
    [{ text: '⬅️ رجوع للتصنيفات', callback_data: 'adm:cats' }],
  ]};
  await send(env, uid, `🛠 <b>خدمات «${esc(cat?.name || '')}»:</b>\n${txt}`, kb);
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

async function adminDeps(env, uid) {
  const rows = await all(env, "SELECT d.*, u.name FROM deposits d JOIN users u ON u.tg_id=d.user_id WHERE d.status='pending' ORDER BY d.id");
  if (!rows.length) return send(env, uid, '💰 ما في إيداعات معلقة.', adminKb);
  for (const d of rows) {
    await send(env, uid, `💰 <b>إيداع #${d.id}</b>\nالمستخدم: ${esc(d.name)} (${d.user_id})\nالطريقة: ${esc(d.method)}\nملاحظة: ${esc(d.note)}`,
      { inline_keyboard: [[
        { text: '✅ اعتماد بمبلغ…', callback_data: `adm:depok:${d.id}` },
        { text: '❌ رفض', callback_data: `adm:deprej:${d.id}` },
      ]] });
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
  const keys = ['ref_worker_pct', 'ref_client_pct', 'min_withdraw', 'auto_approve_days'];
  const vals = {};
  for (const k of keys) vals[k] = await setting(env, k, '');
  const kb = { inline_keyboard: [
    ...keys.map((k) => [{ text: `✏️ ${k} = ${vals[k]}`, callback_data: `adm:set:${k}` }]),
    [{ text: '✏️ نص الترحيب', callback_data: 'adm:set:welcome_text' }],
    [{ text: '✏️ وسائل الإيداع (JSON)', callback_data: 'adm:set:deposit_methods' }],
    [{ text: '⬅️ رجوع', callback_data: 'adm:home' }],
  ]};
  await send(env, uid,
    `⚙️ <b>الإعدادات</b>\n• نسبة إحالة العامل: ${vals.ref_worker_pct}%\n• نسبة إحالة العميل: ${vals.ref_client_pct}%\n• حد السحب الأدنى: ${fmt(vals.min_withdraw)} ل.س\n• قبول تلقائي بعد صمت العميل: ${vals.auto_approve_days} يوم`, kb);
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

    case 'client_request': {
      await run(env, 'INSERT INTO orders(client_id,text,created_at) VALUES(?,?,?)', uid, text, now());
      await clearState(env, uid);
      await send(env, uid, '✅ وصل طلبك للإدارة. منراجعو ومننشره كمهمة، وبيوصلك إشعار.', mainKb(env, uid));
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
      await send(env, uid, '📤 تسلّم إثباتك — صار بانتظار المراجعة. بيوصلك إشعار بالنتيجة 👌', mainKb(env, uid));
      const t = await one(env, 'SELECT * FROM tasks WHERE id=?', claim.task_id);
      const reviewerId = t.reviewer === 'client' && t.client_id ? t.client_id : env.ADMIN_ID;
      if (reviewerId) await send(env, reviewerId, `🧾 إثبات جديد بانتظار مراجعتك للمهمة «${esc(t.title)}»`);
      return;
    }
    case 'dep_note': {
      await run(env, 'INSERT INTO deposits(user_id,method,note,created_at) VALUES(?,?,?,?)', uid, d.method, text, now());
      await clearState(env, uid);
      await send(env, uid, '✅ وصل طلب الإيداع للإدارة. بس يتحقق الدفع بينضاف لرصيدك وبيوصلك إشعار.', mainKb(env, uid));
      if (env.ADMIN_ID) await send(env, env.ADMIN_ID, `💰 طلب إيداع جديد (${esc(d.method)}) من ${uid}: ${esc(text)}`);
      return;
    }
    case 'wd_method': d.method = text; await setState(env, uid, 'wd_details', d); return send(env, uid, '📍 ابعت الرقم/العنوان يلي بدك التحويل عليه:');
    case 'wd_details': d.details = text; await setState(env, uid, 'wd_amount', d); return send(env, uid, '💸 كم المبلغ؟ (ل.س)');
    case 'wd_amount': {
      const amt = parseNum(text);
      const u = await getUser(env, uid);
      const minW = Number(await setting(env, 'min_withdraw', '25000'));
      if (amt < minW) { await send(env, uid, `⚠️ الحد الأدنى للسحب ${fmt(minW)} ل.س`); return; }
      if (amt > u.balance) { await send(env, uid, '⚠️ المبلغ أكبر من رصيدك.'); return; }
      await addBalance(env, uid, -amt, 'withdraw', 'request');
      await run(env, 'INSERT INTO withdrawals(user_id,method,details,amount,created_at) VALUES(?,?,?,?,?)', uid, d.method, d.details, amt, now());
      await clearState(env, uid);
      await send(env, uid, '✅ تسجّل طلب السحب وصار عند الإدارة. بيوصلك إشعار بس يتنفذ.', mainKb(env, uid));
      if (env.ADMIN_ID) await send(env, env.ADMIN_ID, `💸 طلب سحب جديد: ${fmt(amt)} ل.س من ${uid}`);
      return;
    }
    case 'support_msg': {
      await run(env, 'INSERT INTO tickets(user_id,ref,message,created_at) VALUES(?,?,?,?)', uid, d.ref || '', text, now());
      await clearState(env, uid);
      await send(env, uid, '✅ وصلت رسالتك للدعم. منرد عليك هون بالبوت.', mainKb(env, uid));
      if (env.ADMIN_ID) await send(env, env.ADMIN_ID, `🆘 تذكرة دعم جديدة من ${uid}:\n${esc(text)}`);
      return;
    }
    // ----- Service definition wizard (admin) -----
    case 'svc_name': d.name = text; await setState(env, uid, 'svc_price', d); return send(env, uid, '💰 سعر التنفيذ على العميل؟ (ل.س)');
    case 'svc_price': d.price = parseNum(text); await setState(env, uid, 'svc_pay', d); return send(env, uid, '💵 أجر العامل على التنفيذ الواحد؟ (ل.س)');
    case 'svc_pay': d.pay = parseNum(text); await setState(env, uid, 'svc_proof', d);
      return send(env, uid, '📄 نوع الإثبات المطلوب من العامل:', { inline_keyboard: [[
        { text: '🖼 صورة', callback_data: 'svp:photo' }, { text: '✍️ نص', callback_data: 'svp:text' },
        { text: '🔗 رابط', callback_data: 'svp:link' }, { text: 'أي شي', callback_data: 'svp:any' }]] });
    case 'svc_inst': {
      await run(env, 'INSERT INTO services(category_id,name,price,pay,proof_type,reviewer,instructions) VALUES(?,?,?,?,?,?,?)',
        d.category_id, d.name, d.price, d.pay, d.proof_type, d.reviewer, text === '-' ? '' : text);
      const catId = d.category_id;
      await clearState(env, uid);
      await send(env, uid, `✅ انضافت الخدمة «${esc(d.name)}» — العميل بيقدر يطلبها لحالو هلأ.`);
      return adminSvcs(env, uid, catId);
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
      await run(env, 'INSERT INTO categories(parent_id,name) VALUES(?,?)', d.parent_id || null, text);
      await clearState(env, uid);
      await send(env, uid, `✅ انضاف التصنيف «${esc(text)}»`);
      return adminCats(env, uid);
    }
    case 'adm_chan_ref': d.chat_ref = text; await setState(env, uid, 'adm_chan_title', d); return send(env, uid, 'اسم القناة (يلي بيظهر للمستخدم):');
    case 'adm_chan_title': d.title = text; await setState(env, uid, 'adm_chan_link', d); return send(env, uid, 'رابط القناة (https://t.me/...):');
    case 'adm_chan_link': {
      await run(env, 'INSERT INTO forced_channels(chat_ref,title,link) VALUES(?,?,?)', d.chat_ref, d.title, text);
      await clearState(env, uid);
      await send(env, uid, '✅ انضافت القناة. تذكير: البوت لازم يكون أدمن فيها.');
      return adminChans(env, uid);
    }
    case 'adm_set': {
      await setSetting(env, d.key, text);
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
    if (await gate(env, uid)) await showHome(env, uid);
    return;
  }
  const u = await ensureUser(env, msg.from);
  if (u.is_banned) return send(env, uid, '🚫 حسابك محظور. راجع الدعم.');
  if (!(await gate(env, uid))) return;

  // Active wizard state consumes text/photo first (except menu buttons).
  const st = await getState(env, uid);
  const isMenuBtn = ['📋 المهام المتاحة','🛠 مهامي','➕ اطلب خدمة','📦 طلباتي','👛 محفظتي','🎁 الإحالة','🆘 الدعم','👤 حسابي','👑 لوحة الأدمن','/wallet','/balance','/tasks','/order'].includes(text);
  if (st.state && !isMenuBtn && (text || msg.photo)) return handleStateText(env, uid, st, msg);
  if (isMenuBtn) await clearState(env, uid);

  switch (text) {
    case '/wallet': return wallet(env, uid);
    case '/balance': {
      const me = await getUser(env, uid);
      return send(env, uid, `💰 رصيدك الحالي: <b>${fmt(me?.balance)} ل.س</b>`, mainKb(env, uid));
    }
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
      const pending = await one(env, `SELECT COUNT(*) n FROM claims c JOIN tasks t ON t.id=c.task_id
        WHERE c.status='submitted' AND t.reviewer='client' AND t.client_id=?`, uid);
      const kbRows = [];
      if (pending.n) kbRows.push([{ text: `🧾 إثباتات بانتظار مراجعتك (${pending.n})`, callback_data: 'myproofs' }]);
      kbRows.push([{ text: '💰 قائمة الأسعار', callback_data: 'prices' }]);
      kbRows.push([{ text: '⬅️ رجوع', callback_data: 'home' }]);
      return send(env, uid, txt, { inline_keyboard: kbRows });
    }
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
      if (text) return send(env, uid, 'استخدم الأزرار تحت 👇', mainKb(env, uid));
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
  if (data === 'home') return showHome(env, uid);
  if (data === 'cats') return listCategories(env, uid);
  if (data === 'prices') return priceList(env, uid);
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
  if (data === 'ordno') { await clearState(env, uid); return send(env, uid, '❌ انلغى الطلب.', mainKb(env, uid)); }
  if (data === 'ordok') {
    const st = await getState(env, uid);
    if (st.state !== 'ord_confirm') return send(env, uid, '⚠️ انتهت هالجلسة. بلّش الطلب من جديد.');
    const d = st.data;
    const svc = await one(env, 'SELECT * FROM services WHERE id=? AND is_active=1', d.service_id);
    if (!svc) { await clearState(env, uid); return send(env, uid, '⚠️ هالخدمة ما عادت متاحة.'); }
    const total = svc.price * d.qty;
    const u = await getUser(env, uid);
    if (u.balance < total) {
      await clearState(env, uid);
      return send(env, uid, `⚠️ <b>رصيدك ما بيكفي</b>\nالمطلوب: ${fmt(total)} ل.س — رصيدك: ${fmt(u.balance)} ل.س\nاشحن محفظتك من «👛 محفظتي ← إيداع» وارجع اطلب.`, mainKb(env, uid));
    }
    await addBalance(env, uid, -total, 'escrow', 'order');
    const instructions = [svc.instructions, d.desc ? `— تفاصيل العميل:\n${d.desc}` : ''].filter(Boolean).join('\n');
    const r = await run(env, `INSERT INTO tasks(category_id,client_id,title,instructions,proof_type,price,pay,slots_total,reviewer,deadline,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, svc.category_id, uid, svc.name, instructions, svc.proof_type, svc.price, svc.pay, d.qty, svc.reviewer, '', now());
    const t = await one(env, 'SELECT * FROM tasks WHERE id=?', r.meta.last_row_id);
    await clearState(env, uid);
    const fresh = await getUser(env, uid);
    await send(env, uid, `✅ <b>تم طلبك ونزلت المهمة #${t.id} للعمال فوراً</b>\n📌 ${esc(svc.name)} × ${d.qty}\nانخصم ${fmt(total)} ل.س — رصيدك هلأ ${fmt(fresh.balance)} ل.س\nبتوصلك إشعارات مع كل تنفيذ بينقبل 👌`, mainKb(env, uid));
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
    await setState(env, uid, 'dep_note', { method: mm.name });
    return send(env, uid, `💳 <b>${esc(mm.name)}</b>\n${esc(mm.details)}\n\nبعد ما تحوّل، ابعت هون رقم العملية / رقم المرسل للتأكيد:`);
  }
  if (data === 'wd') {
    await setState(env, uid, 'wd_method', {});
    return send(env, uid, '➖ <b>سحب</b>\nاكتب وسيلة السحب (مثلا: سيريتل كاش / USDT TRC20):');
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
  if (data === 'adm:cats') return adminCats(env, uid);
  if (cmd === 'adm' && arg === 'svcs') return adminSvcs(env, uid, Number(arg2));
  if (cmd === 'adm' && arg === 'addsvc') { await setState(env, uid, 'svc_name', { category_id: Number(arg2) }); return send(env, uid, '🛠 <b>خدمة جديدة</b>\nاسم الخدمة (متل ما بيشوفها العميل):'); }
  if (cmd === 'adm' && arg === 'delsvc') {
    await run(env, 'DELETE FROM services WHERE id=?', Number(arg2));
    const back = Number(data.split(':')[3]) || 0;
    await send(env, uid, '🗑 انحذفت الخدمة.');
    return adminSvcs(env, uid, back);
  }
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
    await run(env, 'DELETE FROM categories WHERE id=? OR parent_id=?', Number(arg2), Number(arg2));
    await send(env, uid, '🗑 انحذف التصنيف (وفروعه).'); return adminCats(env, uid);
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
  if (cmd === 'adm' && arg === 'depok') { await setState(env, uid, 'adm_dep_amount', { dep_id: Number(arg2) }); return send(env, uid, '💰 كم المبلغ يلي بينضاف لرصيد المستخدم؟ (ل.س)'); }
  if (cmd === 'adm' && arg === 'deprej') {
    const dep = await one(env, 'SELECT * FROM deposits WHERE id=?', Number(arg2));
    if (dep?.status === 'pending') { await run(env, "UPDATE deposits SET status='rejected' WHERE id=?", dep.id); await send(env, dep.user_id, '❌ انرفض طلب الإيداع تبعك. راجع الدعم.'); }
    return send(env, uid, '❌ انرفض الإيداع.');
  }
  if (data === 'adm:wds') return adminWds(env, uid);
  if (cmd === 'adm' && arg === 'wdok') {
    const w = await one(env, 'SELECT * FROM withdrawals WHERE id=?', Number(arg2));
    if (w?.status === 'pending') { await run(env, "UPDATE withdrawals SET status='approved' WHERE id=?", w.id); await send(env, w.user_id, `✅ تنفذ سحبك: ${fmt(w.amount)} ل.س 💸`); }
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
  if (data === 'adm:addchan') { await setState(env, uid, 'adm_chan_ref', {}); return send(env, uid, 'معرّف القناة (@username أو الرقم):'); }
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
  const days = Number(await setting(env, 'auto_approve_days', '3'));
  const cutoff = now() - days * 86400;
  const stale = await all(env, `SELECT c.* FROM claims c JOIN tasks t ON t.id=c.task_id
    WHERE c.status='submitted' AND t.reviewer='client' AND c.submitted_at>0 AND c.submitted_at<?`, cutoff);
  for (const c of stale) await approveClaim(env, c);
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
  `INSERT OR IGNORE INTO settings(key, value) VALUES ('ref_worker_pct', '5'), ('ref_client_pct', '10'), ('min_withdraw', '25000'), ('auto_approve_days', '3'), ('welcome_text', 'أهلا فيك بـ مصاري 💸\nنفّذ مهام واجمع مصاريك، أو اطلب خدمة وخلي التنفيذ علينا.'), ('deposit_methods', '[]')`,
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
      return new Response('setup ok');
    }
    if (request.method === 'POST' && url.pathname === `/webhook/${env.WEBHOOK_SECRET}`) {
      const upd = await request.json().catch(() => null);
      if (upd?.message) await handleMessage(env, upd.message);
      else if (upd?.callback_query) await handleCallback(env, upd.callback_query);
      return new Response('ok');
    }
    if (url.pathname === '/') return new Response('Masari bot is running.');
    return new Response('not found', { status: 404 });
  },
  async scheduled(event, env) { await scheduled(env); },
};
