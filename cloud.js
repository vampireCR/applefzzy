/* Apple Book cloud persistence layer.
   Supabase is the source of truth for profiles, public content, user state,
   site settings, friendships and messages. localStorage remains only a cache. */
(function () {
  'use strict';
  const URL = 'https://tzkxujrjrhyqxgzytaex.supabase.co';
  const KEY = 'sb_publishable_BrNnF8XCshRm1NmEYvQphg_hcNIJhQV';
  const db = window.supabase.createClient(URL, KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  window.appleBookSupabase = db;
  let authUser = null, channel = null, hydrating = false, ready = false;
  let persistTimer = null, persistChain = Promise.resolve(), lastPersistError = '';
  const $ = (s) => document.querySelector(s);
  const say = (s) => { if (typeof toast === 'function') toast(s); };
  const cleanUsername = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
  const safeAppFields = [
    'displayName','school','year','home','rel','bday','site','music','movies','quote',
    'color','cov','pic','avatarEmoji','interest','status','bio'
  ];
  function profileToUser(p) {
    const d = p.app_data && typeof p.app_data === 'object' ? p.app_data : {};
    return {
      id: p.id, name: d.displayName || p.username || p.handle || 'Member',
      username: p.username || '', handle: p.handle || '', bio: p.bio || d.bio || '',
      pic: d.pic || p.avatar_url || '', color: Number(d.color ?? 210), cov: Number(d.cov ?? 210),
      role: ({ moderator: 'mod', admin: 'admin', head_admin: 'head', owner: 'owner' })[p.role] || 'user',
      state: d.accountState || 'ok', verified: Number(d.verified || 0), friends: [], reqs: [],
      blocked: [], views: Number(d.views || 0), joined: p.created_at ? new Date(p.created_at).getTime() : Date.now(),
      school: d.school || '', year: d.year || '', home: d.home || '', rel: d.rel || '', bday: d.bday || '',
      site: d.site || '', music: d.music || '', movies: d.movies || '', quote: d.quote || '',
      status: p.status || d.status || '', interests: p.interest || d.interest || '', vis: 'all', seenv: 'all', email: ''
    };
  }
  const messageToLocal = (m) => ({
    id: m.id, from: m.sender_id, to: m.receiver_id, txt: m.deleted_at ? '' : (m.content || ''),
    t: new Date(m.created_at).getTime(), read: !!m.read_at, del: !!m.deleted_at,
    ed: !!m.edited_at, rp: m.reply_to_id || undefined, image_path: m.image_path || null
  });
  function mergeInteractions(posts, groups, events, rows) {
    (rows || []).forEach(row => {
      const d = row.data || {};
      if (row.kind === 'like') {
        const p = posts.find(x => x.id === row.object_id);
        if (p && !p.likes.includes(row.actor_id)) p.likes.push(row.actor_id);
      } else if (row.kind === 'comment') {
        const p = posts.find(x => x.id === row.object_id);
        if (p && !p.cm.some(c => c.id === d.id)) p.cm.push(d);
      } else if (row.kind === 'group_member') {
        const g = groups.find(x => x.id === row.object_id);
        if (g && !g.members.includes(row.actor_id)) g.members.push(row.actor_id);
      } else if (row.kind === 'event_going') {
        const e = events.find(x => x.id === row.object_id);
        if (e && !e.going.includes(row.actor_id)) e.going.push(row.actor_id);
      }
    });
  }
  async function hydrate() {
    if (!authUser || hydrating) return;
    hydrating = true; ready = false;
    try {
      const id = authUser.id;
      const [pr, fr, mr, stateRes, contentRes, settingsRes, interactionsRes, reactionsRes] = await Promise.all([
        db.from('profiles').select('id,username,username_normalized,handle,bio,status,role,created_at,avatar_url,avatar_emoji,interest,app_data').order('username').limit(2000),
        db.from('friendships').select('id,requester_id,recipient_id,status,created_at').or('requester_id.eq.' + id + ',recipient_id.eq.' + id),
        db.from('messages').select('id,sender_id,receiver_id,content,created_at,read_at,image_path,edited_at,deleted_at,reply_to_id,forwarded_from_id,pinned_at').or('sender_id.eq.' + id + ',receiver_id.eq.' + id).order('created_at', { ascending: true }).limit(1000),
        db.from('applebook_user_state').select('data').eq('user_id', id).maybeSingle(),
        db.from('applebook_content').select('id,kind,owner_id,data,updated_at').in('kind', ['post','group','event']).order('updated_at', { ascending: false }).limit(3000),
        db.from('applebook_site_settings').select('data').eq('id', 1).maybeSingle(),
        db.from('applebook_interactions').select('id,kind,object_id,actor_id,data').limit(10000),
        db.from('applebook_message_reactions').select('message_id,user_id,reaction').limit(5000)
      ]);
      for (const r of [pr, fr, mr, stateRes, contentRes, settingsRes, interactionsRes, reactionsRes]) if (r.error) throw r.error;
      S.users = (pr.data || []).map(profileToUser);
      const meProfile = S.users.find(u => u.id === id);
      if (!meProfile) throw new Error('Профиль не найден. Проверь SQL и наличие строки profiles для текущего Auth-пользователя.');
      meProfile.email = authUser.email || '';
      me = id;
      const state = stateRes.data?.data || {};
      const privateUser = state.profile || {};
      ['blocked','mute','vis','seenv'].forEach(k => { if (privateUser[k] !== undefined) meProfile[k] = privateUser[k]; });
      meProfile.blocked = meProfile.blocked || [];
      (fr.data || []).forEach(f => {
        const a = S.users.find(u => u.id === f.requester_id), b = S.users.find(u => u.id === f.recipient_id);
        if (f.status === 'accepted') {
          if (a && !a.friends.includes(f.recipient_id)) a.friends.push(f.recipient_id);
          if (b && !b.friends.includes(f.requester_id)) b.friends.push(f.requester_id);
        } else if (f.status === 'pending' && f.recipient_id === id && !meProfile.reqs.includes(f.requester_id)) meProfile.reqs.push(f.requester_id);
      });
      meProfile.friends = (meProfile.friends || []).filter(friendId => !(meProfile.blocked || []).includes(friendId));
      const records = contentRes.data || [];
      const byKind = kind => records.filter(x => x.kind === kind).map(x => ({ ...x.data, id: x.id, by: x.owner_id }));
      S.posts = byKind('post').map(p => ({ ...p, likes: [], cm: [] }));
      S.groups = byKind('group').map(g => ({ ...g, members: [g.by] }));
      S.events = byKind('event').map(e => ({ ...e, going: [e.by] }));
      mergeInteractions(S.posts, S.groups, S.events, interactionsRes.data || []);
      S.notes = Array.isArray(state.notes) ? state.notes : [];
      S.reports = Array.isArray(state.reports) ? state.reports : [];
      S.log = Array.isArray(state.log) && meProfile.role === 'owner' ? state.log : [];
      if (settingsRes.data?.data) S.cfg = { ...S.cfg, ...settingsRes.data.data };
      S.msgs = (mr.data || []).map(messageToLocal);
      const hidden = new Set(state.hiddenMessageIds || []);
      S.msgs.forEach(m => { if (hidden.has(String(m.id))) { m.dfm = [id]; } });
      (reactionsRes.data || []).forEach(x => { const m = S.msgs.find(z => String(z.id) === String(x.message_id)); if (m) { m.rx = m.rx || {}; m.rx[x.user_id] = x.reaction || '❤️'; } });
      localStorage.setItem('ab2me', id);
      ready = true;
      if (typeof render === 'function') render();
    } catch (e) {
      console.error('Apple Book cloud hydrate:', e);
      say('Ошибка загрузки из Supabase: ' + (e.message || 'неизвестная ошибка'));
    } finally { hydrating = false; }
  }
  function profilePayload(u) {
    const app_data = {};
    safeAppFields.forEach(k => { if (u[k] !== undefined) app_data[k] = u[k]; });
    app_data.displayName = String(u.name || u.username || 'Member').slice(0, 50);
    app_data.verified = Number(u.verified || 0);
    app_data.accountState = u.state || 'ok';
    return {
      bio: String(u.bio || '').slice(0, 400), status: String(u.status || '').slice(0, 100),
      interest: String(u.interests || '').slice(0, 300), app_data
    };
  }
  function contentData(item, kind) {
    const d = { ...item };
    delete d.id; delete d.by;
    if (kind === 'post') { delete d.likes; delete d.cm; }
    if (kind === 'group') delete d.members;
    if (kind === 'event') delete d.going;
    return d;
  }
  async function replaceOwnedContent(kind, items, ownerId) {
    const clean = (items || []).filter(x => x && (kind === 'group' ? (x.owner || x.by) : x.by) === ownerId);
    if (clean.length) {
      const rows = clean.map(x => ({ id: String(x.id), kind, owner_id: ownerId, data: contentData(x, kind), updated_at: new Date().toISOString() }));
      const { error } = await db.from('applebook_content').upsert(rows, { onConflict: 'kind,id' });
      if (error) throw error;
    }
    const { data: existing, error: readErr } = await db.from('applebook_content').select('id').eq('owner_id', ownerId).eq('kind', kind);
    if (readErr) throw readErr;
    const keep = new Set(clean.map(x => String(x.id)));
    const stale = (existing || []).filter(x => !keep.has(String(x.id))).map(x => x.id);
    if (stale.length) {
      const { error } = await db.from('applebook_content').delete().eq('owner_id', ownerId).eq('kind', kind).in('id', stale);
      if (error) throw error;
    }
  }
  async function persistNow() {
    if (!authUser || !ready || hydrating || !me) return;
    const id = authUser.id, u = (S.users || []).find(x => x.id === id);
    if (!u) return;
    const profile = profilePayload(u);
    const { error: profileError } = await db.from('profiles').update(profile).eq('id', id);
    if (profileError) throw profileError;
    await Promise.all([
      replaceOwnedContent('post', S.posts, id),
      replaceOwnedContent('group', S.groups, id),
      replaceOwnedContent('event', S.events, id)
    ]);
    const interactions = [];
    (S.posts || []).forEach(p => {
      (p.likes || []).filter(x => x === id).forEach(actor => interactions.push({ id: 'like:' + p.id + ':' + actor, kind: 'like', object_id: String(p.id), actor_id: actor, data: {} }));
      (p.cm || []).filter(c => c.by === id).forEach(c => {
        if (!c.id) c.id = 'c' + Math.random().toString(36).slice(2, 10);
        interactions.push({ id: 'comment:' + p.id + ':' + c.id, kind: 'comment', object_id: String(p.id), actor_id: id, data: c });
      });
    });
    (S.groups || []).forEach(g => { if (g.by !== id && (g.members || []).includes(id)) interactions.push({ id: 'group_member:' + g.id + ':' + id, kind: 'group_member', object_id: String(g.id), actor_id: id, data: {} }); });
    (S.events || []).forEach(e => { if (e.by !== id && (e.going || []).includes(id)) interactions.push({ id: 'event_going:' + e.id + ':' + id, kind: 'event_going', object_id: String(e.id), actor_id: id, data: {} }); });
    const { error: delErr } = await db.from('applebook_interactions').delete().eq('actor_id', id);
    if (delErr) throw delErr;
    if (interactions.length) {
      const { error } = await db.from('applebook_interactions').insert(interactions);
      if (error) throw error;
    }
    const state = {
      profile: { blocked: u.blocked || [], mute: u.mute || {}, vis: u.vis || 'all', seenv: u.seenv || 'all' },
      notes: (S.notes || []).filter(n => n.to === id),
      hiddenMessageIds: (S.msgs || []).filter(m => (m.dfm || []).includes(id)).map(m => String(m.id)),
      reports: (S.reports || []).filter(r => r.by === id),
      log: u.role === 'owner' ? (S.log || []).slice(0, 200) : []
    };
    const { error: stateError } = await db.from('applebook_user_state').upsert({ user_id: id, data: state, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (stateError) throw stateError;
    if (u.role === 'owner') {
      const { error: settingsError } = await db.from('applebook_site_settings').upsert({ id: 1, data: S.cfg || {} }, { onConflict: 'id' });
      if (settingsError) throw settingsError;
    }
    lastPersistError = '';
  }
  function persistSoon() {
    if (!authUser || !ready || hydrating) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistChain = persistChain.then(persistNow).catch(e => {
        lastPersistError = e.message || String(e);
        console.error('Apple Book cloud save:', e);
        say('Не удалось сохранить в облако: ' + lastPersistError);
      });
    }, 450);
  }
  window.appleBookCloudPersist = persistSoon;
  window.appleBookCloudFlush = async function () {
    clearTimeout(persistTimer);
    persistChain = persistChain.then(persistNow);
    await persistChain;
    if (lastPersistError) throw new Error(lastPersistError);
  };
  async function markRead(otherId) {
    if (!authUser || !otherId) return;
    const { error } = await db.from('messages').update({ read_at: new Date().toISOString() })
      .eq('receiver_id', authUser.id).eq('sender_id', otherId).is('read_at', null);
    if (error) console.warn('mark read:', error.message); else await hydrate();
  }
  function listen() {
    if (channel) db.removeChannel(channel);
    channel = db.channel('applebook-user-' + authUser.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, async payload => {
        const row = payload.new || payload.old;
        if (row && (row.sender_id === authUser.id || row.receiver_id === authUser.id)) {
          await hydrate();
          if (row.receiver_id === authUser.id && row.sender_id !== authUser.id) say('Новое сообщение');
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, hydrate)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'applebook_content' }, hydrate)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'applebook_interactions' }, hydrate)
      .subscribe();
  }
  async function cloudLogin() {
    const email = ($('#e')?.value || '').trim().toLowerCase(), password = $('#p')?.value || '', msg = $('#m');
    if (!email || !password) { if (msg) msg.textContent = 'Введите email и пароль.'; return; }
    const { data, error } = await db.auth.signInWithPassword({ email, password });
    if (error) { if (msg) msg.textContent = error.message; return; }
    authUser = data.user; await hydrate(); listen();
    if (typeof touch === 'function') touch(); R = { p: 'home' }; if (typeof render === 'function') render();
  }
  async function cloudRegister() {
    const name = ($('#n')?.value || '').trim(), email = ($('#e')?.value || '').trim().toLowerCase(), password = $('#p')?.value || '', msg = $('#m');
    const username = cleanUsername(name);
    if (name.length < 3 || username.length < 3 || !email.includes('@')) { if (msg) msg.textContent = 'Имя должно содержать минимум 3 латинские буквы/цифры или _. '; return; }
    if (password.length < 8) { if (msg) msg.textContent = 'Пароль должен содержать минимум 8 символов.'; return; }
    if (!$('#rl')?.checked) { if (msg) msg.textContent = 'Подтвердите правила.'; return; }
    const { data, error } = await db.auth.signUp({ email, password, options: { data: { username, display_name: name }, emailRedirectTo: location.href.split('#')[0] } });
    if (error) { if (msg) msg.textContent = error.message; return; }
    if (!data.session) { if (msg) msg.textContent = 'Проверьте почту и подтвердите регистрацию. Затем войдите.'; return; }
    authUser = data.user; await hydrate(); listen(); R = { p: 'home' }; if (typeof render === 'function') render();
  }
  async function sendMessage(toId) {
    const input = $('#mt'), content = (input?.value || '').trim().slice(0, 4000);
    if (!content) return;
    if (typeof ED !== 'undefined' && ED) {
      const { error: editError } = await db.rpc('applebook_edit_message', { target_message_id: ED, new_content: content });
      if (editError) { say('Не удалось изменить сообщение: ' + editError.message); return; }
      ED = null; RP = null; await hydrate(); R = { p: 'msgs', a: toId }; if (typeof render === 'function') render(); return;
    }
    const payload = { sender_id: authUser.id, receiver_id: toId, content };
    if (typeof RP !== 'undefined' && RP) payload.reply_to_id = RP;
    const { error } = await db.from('messages').insert(payload);
    if (error) { say(error.message.includes('row-level security') ? 'Чтобы писать, сначала добавьте пользователя в друзья и дождитесь принятия заявки.' : error.message); return; }
    if (typeof RP !== 'undefined') RP = null;
    await hydrate(); R = { p: 'msgs', a: toId }; if (typeof render === 'function') render();
  }
  async function setRankCloud(targetId) {
    const select = $('#rk' + targetId), requested = select ? select.value : '';
    const roleMap = { user: 'member', mod: 'moderator', admin: 'admin', head: 'head_admin' }, dbRole = roleMap[requested];
    if (!authUser || !dbRole) { say('Не удалось определить пользователя или новый ранг.'); return; }
    const { error } = await db.rpc('applebook_set_profile_role', { target_user_id: targetId, requested_role: dbRole });
    if (error) { console.error('Rank update failed:', error); say('Не удалось изменить ранг: ' + error.message); return; }
    await hydrate(); say('Ранг сохранён в Supabase.'); if (typeof ad === 'function') ad(); else render();
  }
  async function setRankDirect(targetId, dbRole) {
    const { error } = await db.rpc('applebook_set_profile_role', { target_user_id: targetId, requested_role: dbRole });
    if (error) { say('Не удалось изменить ранг: ' + error.message); return; }
    await hydrate(); if (typeof ad === 'function') ad(); else render();
  }
  async function changePassword() {
    const password = ($('#np')?.value || '');
    if (typeof pwOk === 'function' && pwOk(password)) { say(pwOk(password)); return; }
    const { error } = await db.auth.updateUser({ password });
    if (error) { say('Не удалось изменить пароль: ' + error.message); return; }
    $('#np').value = ''; say('Пароль обновлён в Supabase Auth.');
  }
  async function unfriend(id) {
    const { error } = await db.from('friendships').delete()
      .or('and(requester_id.eq.' + authUser.id + ',recipient_id.eq.' + id + '),and(requester_id.eq.' + id + ',recipient_id.eq.' + authUser.id + ')');
    if (error) { say('Не удалось удалить дружбу: ' + error.message); return; }
    await hydrate();
  }
  async function staffState(targetId, state) {
    const { error } = await db.rpc('applebook_staff_set_account_state', { target_user_id: targetId, requested_state: state });
    if (error) { say('Не удалось изменить состояние аккаунта: ' + error.message); return; }
    await hydrate(); if (typeof ad === 'function') ad(); else render();
  }
  async function staffVerified(targetId, value) {
    const { error } = await db.rpc('applebook_staff_set_verified', { target_user_id: targetId, requested_value: !!value });
    if (error) { say('Не удалось изменить отметку: ' + error.message); return; }
    await hydrate(); if (typeof ad === 'function') ad(); else render();
  }
  async function callAdminFunction(action, targetId) {
    const { data: sessionData, error: sessionError } = await db.auth.getSession();
    if (sessionError || !sessionData.session) { say('Сессия истекла. Войдите снова.'); return null; }
    const { data, error } = await db.functions.invoke('applebook-admin', {
      body: { action, target_user_id: targetId || null }
    });
    if (error) { say('Серверная операция не выполнена: ' + error.message + '. Проверьте, что функция applebook-admin развёрнута.'); return null; }
    if (data && data.error) { say(data.error); return null; }
    return data;
  }
  async function deleteAccount(targetId, isSelf) {
    const result = await callAdminFunction('delete_user', targetId);
    if (!result) return;
    say(isSelf ? 'Аккаунт удалён.' : 'Аккаунт пользователя удалён.');
    if (isSelf) {
      await db.auth.signOut(); authUser = null; ready = false;
      if (channel) db.removeChannel(channel); channel = null; me = null;
      S.users = []; S.msgs = []; R = { p: 'login' }; render();
    } else {
      await hydrate(); if (typeof ad === 'function') ad(); else render();
    }
  }
  async function resetUserPassword(targetId) {
    const result = await callAdminFunction('reset_password', targetId);
    if (!result || !result.action_link) return;
    try { await navigator.clipboard.writeText(result.action_link); } catch (_) {}
    window.prompt('Ссылка восстановления пароля (скопируйте и передайте пользователю):', result.action_link);
  }
  async function moderateContent(targetId, kind, action) {
    const { error } = await db.rpc('applebook_moderate_content', {
      target_content_id: String(targetId), target_kind: kind, requested_action: action
    });
    if (error) { say('Модерация не выполнена: ' + error.message); return; }
    await hydrate(); if (typeof ad === 'function') ad(); else render();
  }
  async function broadcastAnnouncement() {
    const body = ($('#bc')?.value || '').trim();
    if (!body) { say('Введите текст объявления.'); return; }
    const { error } = await db.rpc('applebook_broadcast', { announcement_body: body });
    if (error) { say('Объявление не отправлено: ' + error.message); return; }
    $('#bc').value = ''; say('Объявление отправлено.');
  }
  async function deleteMessage(messageId) {
    const { error } = await db.rpc('applebook_delete_message', { target_message_id: messageId });
    if (error) { say('Не удалось удалить сообщение: ' + error.message); return; }
    await hydrate(); if (typeof render === 'function') render();
  }
  async function toggleMessageReaction(messageId) {
    const { data, error } = await db.from('applebook_message_reactions').select('message_id').eq('message_id', messageId).eq('user_id', authUser.id).maybeSingle();
    if (error) { say(error.message); return; }
    const result = data
      ? await db.from('applebook_message_reactions').delete().eq('message_id', messageId).eq('user_id', authUser.id)
      : await db.from('applebook_message_reactions').insert({ message_id: messageId, user_id: authUser.id, reaction: '❤️' });
    if (result.error) { say(result.error.message); return; }
    await hydrate(); if (typeof render === 'function') render();
  }
  async function addFriend(id) {
    const { error } = await db.from('friendships').insert({ requester_id: authUser.id, recipient_id: id, status: 'pending' });
    if (error) { say(error.code === '23505' ? 'Заявка уже существует.' : error.message); return; }
    say('Заявка отправлена.'); await hydrate();
  }
  async function answerFriend(id, status) {
    const { error } = await db.from('friendships').update({ status }).eq('requester_id', id).eq('recipient_id', authUser.id).eq('status', 'pending');
    if (error) { say(error.message); return; } await hydrate();
  }
  const originalA = window.A;
  window.A = function (action, x, y) {
    if (!authUser && action !== 'go' && action !== 'login' && action !== 'reg') return;
    if (action === 'login') return cloudLogin();
    if (action === 'reg') return cloudRegister();
    if (action === 'out') { db.auth.signOut().finally(() => { authUser = null; ready = false; if (channel) db.removeChannel(channel); channel = null; me = null; S.users = []; S.msgs = []; R = { p: 'login' }; render(); }); return; }
    if (action === 'send') return sendMessage(x);
    if (action === 'mdelall') return deleteMessage(x);
    if (action === 'mrx') return toggleMessageReaction(x);
    if (action === 'delp') {
      const p = (S.posts || []).find(z => z.id === x);
      if (p && p.by !== authUser.id) return moderateContent(x, 'post', 'delete');
    }
    if (action === 'appr') return moderateContent(x, 'post', 'approve');
    if (action === 'delg') return moderateContent(x, 'group', 'delete');
    if (action === 'dele') return moderateContent(x, 'event', 'delete');
    if (action === 'bcast') return broadcastAnnouncement();
    if (action === 'setrank') return setRankCloud(x);
    if (action === 'modr') { const target = S.users.find(z => z.id === x); return setRankDirect(x, target && target.role === 'mod' ? 'member' : 'moderator'); }
    if (action === 'pw') return changePassword();
    if (action === 'unf') return unfriend(x);
    if (action === 'block') {
      const wasBlocked = !!(cu() && (cu().blocked || []).includes(x));
      const result = originalA.apply(this, arguments);
      if (!wasBlocked) {
        db.from('friendships').delete().or('and(requester_id.eq.' + authUser.id + ',recipient_id.eq.' + x + '),and(requester_id.eq.' + x + ',recipient_id.eq.' + authUser.id + ')')
          .then(({ error }) => { if (error) say('Пользователь заблокирован локально, но дружбу удалить не удалось: ' + error.message); return hydrate(); });
      }
      return result;
    }
    if (action === 'delme') {
      if (CF !== 'del') return originalA.apply(this, arguments);
      if (S.users.find(z => z.id === authUser.id)?.role === 'owner') { say('Владелец не может удалить этот аккаунт из интерфейса.'); return; }
      CF = null; return deleteAccount(authUser.id, true);
    }
    if (action === 'deluser') {
      if (CF !== 'd' + x) return originalA.apply(this, arguments);
      CF = null; return deleteAccount(x, false);
    }
    if (action === 'rpw') return resetUserPassword(x);
    if (action === 'wipe') { say('Полное удаление данных отключено, чтобы случайно не стереть облачную базу.'); return; }
    if (action === 'ban') return staffState(x, 'banned');
    if (action === 'susp') return staffState(x, 'suspended');
    if (action === 'unban') return staffState(x, 'ok');
    if (action === 'ver') { const u = S.users.find(z => z.id === x); return staffVerified(x, !(u && u.verified)); }
    if (action === 'addf') return addFriend(x);
    if (action === 'acc') return answerFriend(x, 'accepted');
    if (action === 'dec') return answerFriend(x, 'rejected');
    const result = originalA.apply(this, arguments);
    if (action === 'go' && x === 'msgs' && y) markRead(y);
    return result;
  };
  window.doLogin = cloudLogin; window.doReg = cloudRegister;
  db.auth.getSession().then(async ({ data, error }) => {
    if (error) console.warn(error);
    authUser = data.session?.user || null;
    if (authUser) { await hydrate(); listen(); }
    else { me = null; ready = false; S.users = []; S.msgs = []; R = { p: 'login' }; render(); }
  });
  db.auth.onAuthStateChange((_event, session) => {
    authUser = session?.user || null;
    if (authUser) setTimeout(async () => { await hydrate(); listen(); }, 0);
    else ready = false;
  });
})();
