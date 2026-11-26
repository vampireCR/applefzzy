/* Apple Book cloud bridge: Supabase Auth + profiles + friendships + messages.
   Existing local-only features (posts/groups/events/settings) are not migrated by this bridge. */
(function () {
  'use strict';
  const URL = 'https://tzkxujrjrhyqxgzytaex.supabase.co';
  const KEY = 'sb_publishable_BrNnF8XCshRm1NmEYvQphg_hcNIJhQV';
  const db = window.supabase.createClient(URL, KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  window.appleBookSupabase = db;
  let authUser = null;
  let channel = null;
  let syncing = false;

  const $ = (s) => document.querySelector(s);
  const say = (s) => { if (typeof toast === 'function') toast(s); };
  const cleanUsername = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
  const profileToUser = (p) => ({
    id: p.id, name: p.username || p.handle || 'Member', username: p.username || '',
    handle: p.handle || '', bio: p.bio || '', pic: p.avatar_url || '',
    color: 210, cov: 210, role: ({ moderator: 'mod', admin: 'admin', head_admin: 'head', owner: 'owner' })[p.role] || 'user',
    state: 'ok', verified: 0, friends: [], reqs: [], blocked: [], views: 0,
    joined: p.created_at ? new Date(p.created_at).getTime() : Date.now(), school: '', year: '',
    status: p.status || '', interests: p.interest || '', vis: 'all', email: ''
  });
  const messageToLocal = (m) => ({
    id: m.id, from: m.sender_id, to: m.receiver_id, txt: m.deleted_at ? '' : (m.content || ''),
    t: new Date(m.created_at).getTime(), read: !!m.read_at, del: !!m.deleted_at,
    ed: !!m.edited_at, rp: m.reply_to_id || undefined, image_path: m.image_path || null
  });

  async function hydrate() {
    if (!authUser || syncing) return;
    syncing = true;
    try {
      const [pr, fr, mr] = await Promise.all([
        db.from('profiles').select('id,username,username_normalized,handle,bio,status,role,created_at,avatar_url,avatar_emoji,interest').order('username').limit(1000),
        db.from('friendships').select('id,requester_id,recipient_id,status,created_at').or('requester_id.eq.' + authUser.id + ',recipient_id.eq.' + authUser.id),
        db.from('messages').select('id,sender_id,receiver_id,content,created_at,read_at,image_path,edited_at,deleted_at,reply_to_id,forwarded_from_id,pinned_at').order('created_at', { ascending: false }).limit(500)
      ]);
      if (pr.error) throw pr.error;
      if (fr.error) throw fr.error;
      if (mr.error) throw mr.error;
      S.users = (pr.data || []).map(profileToUser);
      let meProfile = S.users.find(u => u.id === authUser.id);
      if (!meProfile) throw new Error('Профиль не создан. Выполни SQL из supabase-setup.sql.');
      meProfile.email = authUser.email || '';
      me = authUser.id;
      (fr.data || []).forEach(f => {
        const a = S.users.find(u => u.id === f.requester_id);
        const b = S.users.find(u => u.id === f.recipient_id);
        if (f.status === 'accepted') {
          if (a && !a.friends.includes(f.recipient_id)) a.friends.push(f.recipient_id);
          if (b && !b.friends.includes(f.requester_id)) b.friends.push(f.requester_id);
        } else if (f.status === 'pending' && f.recipient_id === me && meProfile && !meProfile.reqs.includes(f.requester_id)) {
          meProfile.reqs.push(f.requester_id);
        }
      });
      S.msgs = (mr.data || []).reverse().map(messageToLocal);
      localStorage.setItem('ab2me', me);
      if (typeof render === 'function') render();
    } catch (e) {
      console.error('Apple Book cloud sync:', e);
      say('Ошибка загрузки данных: ' + (e.message || 'Supabase'));
    } finally { syncing = false; }
  }

  async function markRead(otherId) {
    if (!authUser || !otherId) return;
    const { error } = await db.from('messages').update({ read_at: new Date().toISOString() })
      .eq('receiver_id', authUser.id).eq('sender_id', otherId).is('read_at', null);
    if (error) console.warn('mark read:', error.message);
    else await hydrate();
  }

  function listen() {
    if (channel) db.removeChannel(channel);
    channel = db.channel('applebook-user-' + authUser.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, async (payload) => {
        const row = payload.new || payload.old;
        if (row && (row.sender_id === authUser.id || row.receiver_id === authUser.id)) {
          await hydrate();
          if (row.receiver_id === authUser.id && row.sender_id !== authUser.id) say('Новое сообщение');
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, hydrate)
      .subscribe();
  }

  async function cloudLogin() {
    const email = ($('#e')?.value || '').trim().toLowerCase();
    const password = $('#p')?.value || '';
    const msg = $('#m');
    if (!email || !password) { if (msg) msg.textContent = 'Введите email и пароль.'; return; }
    const { data, error } = await db.auth.signInWithPassword({ email, password });
    if (error) { if (msg) msg.textContent = error.message; return; }
    authUser = data.user;
    await hydrate(); listen();
    if (typeof touch === 'function') touch();
    R = { p: 'home' };
    if (typeof render === 'function') render();
  }

  async function cloudRegister() {
    const name = ($('#n')?.value || '').trim();
    const email = ($('#e')?.value || '').trim().toLowerCase();
    const password = $('#p')?.value || '';
    const msg = $('#m');
    const username = cleanUsername(name);
    if (name.length < 3 || username.length < 3 || !email.includes('@')) {
      if (msg) msg.textContent = 'Имя должно содержать минимум 3 латинские буквы/цифры или _. '; return;
    }
    if (password.length < 8) { if (msg) msg.textContent = 'Пароль должен содержать минимум 8 символов.'; return; }
    if (!$('#rl')?.checked) { if (msg) msg.textContent = 'Подтвердите правила.'; return; }
    const { data, error } = await db.auth.signUp({
      email, password, options: { data: { username }, emailRedirectTo: location.origin }
    });
    if (error) { if (msg) msg.textContent = error.message; return; }
    if (!data.session) {
      if (msg) msg.textContent = 'Проверьте почту и подтвердите регистрацию. Затем войдите.';
      return;
    }
    authUser = data.user;
    await hydrate(); listen();
    R = { p: 'home' };
    if (typeof render === 'function') render();
  }

  async function sendMessage(toId) {
    const input = $('#mt');
    const content = (input?.value || '').trim().slice(0, 4000);
    if (!content) return;
    if (typeof ED !== 'undefined' && ED) { say('Редактирование облачных сообщений пока не включено.'); return; }
    const payload = { sender_id: authUser.id, receiver_id: toId, content };
    if (typeof RP !== 'undefined' && RP) payload.reply_to_id = RP;
    const { error } = await db.from('messages').insert(payload);
    if (error) { say(error.message.includes('row-level security') ? 'Чтобы писать, сначала добавьте пользователя в друзья и дождитесь принятия заявки.' : error.message); return; }
    if (typeof RP !== 'undefined') RP = null;
    await hydrate();
    R = { p: 'msgs', a: toId };
    if (typeof render === 'function') render();
  }

  async function addFriend(id) {
    const { error } = await db.from('friendships').insert({ requester_id: authUser.id, recipient_id: id, status: 'pending' });
    if (error) { say(error.code === '23505' ? 'Заявка уже существует.' : error.message); return; }
    say('Заявка отправлена.'); await hydrate();
  }
  async function answerFriend(id, status) {
    const { error } = await db.from('friendships').update({ status })
      .eq('requester_id', id).eq('recipient_id', authUser.id).eq('status', 'pending');
    if (error) { say(error.message); return; }
    await hydrate();
  }

  const originalA = window.A;
  window.A = function (action, x, y) {
    if (!authUser && action !== 'go' && action !== 'login' && action !== 'reg') return;
    if (action === 'login') return cloudLogin();
    if (action === 'reg') return cloudRegister();
    if (action === 'out') {
      db.auth.signOut().finally(() => { authUser = null; if (channel) db.removeChannel(channel); channel = null; me = null; S.users = []; S.msgs = []; R = { p: 'login' }; render(); });
      return;
    }
    if (action === 'send') return sendMessage(x);
    if (action === 'addf') return addFriend(x);
    if (action === 'acc') return answerFriend(x, 'accepted');
    if (action === 'dec') return answerFriend(x, 'rejected');
    const result = originalA.apply(this, arguments);
    if (action === 'go' && x === 'msgs' && y) markRead(y);
    return result;
  };
  window.doLogin = cloudLogin;
  window.doReg = cloudRegister;

  // Include handle in the existing people search.
  if (window.P && P.search) {
    P.search = function () {
      const q = (R.a || '').replace(/^@/, '').toLowerCase();
      const people = S.users.filter(a => q && a.state === 'ok' &&
        ((a.name || '') + ' ' + (a.username || '') + ' ' + (a.handle || '')).toLowerCase().includes(q));
      const groups = (S.groups || []).filter(g => q && (g.name || '').toLowerCase().includes(q));
      return '<div class="c"><h2>Search: ' + esc(R.a || '') + '</h2><h3>People</h3>' + persons(people) +
        '<h3>Groups</h3>' + (groups.length ? groups.map(g => '<div>' + esc(g.name) + '</div>').join('') : '<p class="mu">None.</p>') + '</div>';
    };
  }

  db.auth.getSession().then(async ({ data, error }) => {
    if (error) console.warn(error);
    authUser = data.session?.user || null;
    if (authUser) { await hydrate(); listen(); }
    else { me = null; S.users = []; S.msgs = []; R = { p: 'login' }; render(); }
  });
  db.auth.onAuthStateChange((_event, session) => {
    authUser = session?.user || null;
    if (authUser) setTimeout(async () => { await hydrate(); listen(); }, 0);
  });
})();
