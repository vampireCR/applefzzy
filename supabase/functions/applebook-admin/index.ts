import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
};

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

const rank: Record<string, number> = {
  member: 0, moderator: 1, admin: 2, deputy_ceo: 3, ceo: 4, owner: 5,
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return json({ error: 'На сервере не заданы SUPABASE_URL или SUPABASE_SERVICE_ROLE_KEY.' }, 500);
  }

  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return json({ error: 'Требуется авторизация. Войдите снова.' }, 401);

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) return json({ error: 'Сессия недействительна. Войдите снова.' }, 401);

  let body: { action?: string; target_user_id?: string | null };
  try { body = await req.json(); } catch { return json({ error: 'Некорректный JSON-запрос.' }, 400); }
  const action = String(body.action || '');
  const callerId = authData.user.id;
  const targetId = String(body.target_user_id || callerId);
  if (!['delete_user', 'reset_password'].includes(action)) return json({ error: 'Неизвестная операция.' }, 400);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetId)) {
    return json({ error: 'Некорректный идентификатор аккаунта.' }, 400);
  }

  const [{ data: caller, error: callerError }, { data: target, error: targetError }] = await Promise.all([
    admin.from('profiles').select('id,role,username').eq('id', callerId).maybeSingle(),
    admin.from('profiles').select('id,role,username').eq('id', targetId).maybeSingle(),
  ]);
  if (callerError || !caller) return json({ error: 'Не удалось проверить права администратора.' }, 403);
  if (targetError || !target) return json({ error: 'Профиль пользователя не найден.' }, 404);

  const callerRank = rank[caller.role] ?? 0;
  const targetRank = rank[target.role] ?? 0;
  const isSelf = callerId === targetId;

  if (action === 'delete_user') {
    if (target.role === 'owner') return json({ error: 'Аккаунт владельца защищён от удаления.' }, 403);
    if (!isSelf && (callerRank < 3 || targetRank >= callerRank)) {
      return json({ error: 'Недостаточно прав для удаления этого аккаунта.' }, 403);
    }
    if (isSelf && callerRank >= 5) return json({ error: 'Аккаунт владельца защищён от удаления.' }, 403);
    const { error } = await admin.auth.admin.deleteUser(targetId);
    if (error) return json({ error: `Не удалось удалить аккаунт: ${error.message}` }, 400);
    return json({ ok: true, deleted_user_id: targetId });
  }

  // Reset link generation is restricted to staff and strictly lower-ranked targets.
  if (callerRank < 3 || isSelf || targetRank >= callerRank) {
    return json({ error: 'Недостаточно прав для сброса пароля этого пользователя.' }, 403);
  }
  const { data: targetAuth, error: targetAuthError } = await admin.auth.admin.getUserById(targetId);
  const targetEmail = targetAuth.user?.email;
  if (targetAuthError || !targetEmail) return json({ error: 'У аккаунта не найден адрес электронной почты.' }, 400);
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: 'recovery',
    email: targetEmail,
  });
  if (linkError || !linkData?.properties?.action_link) {
    return json({ error: `Не удалось создать ссылку восстановления: ${linkError?.message || 'ссылка не получена'}` }, 400);
  }
  return json({ ok: true, action_link: linkData.properties.action_link });
});
