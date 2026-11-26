import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
});
const rank: Record<string, number> = {
  member: 0, moderator: 1, admin: 2, head_admin: 3, owner: 4,
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) return json({ error: 'Server secrets are not configured' }, 500);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401);
  const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
  const adminClient = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await userClient.auth.getUser();
  if (authError || !authData.user) return json({ error: 'Invalid or expired session' }, 401);
  const actorId = authData.user.id;
  const { action, target_user_id } = await req.json().catch(() => ({}));
  const { data: actor, error: actorError } = await adminClient.from('profiles').select('id,role').eq('id', actorId).maybeSingle();
  if (actorError || !actor) return json({ error: 'Caller profile not found' }, 403);

  if (action === 'delete_user') {
    if (typeof target_user_id !== 'string') return json({ error: 'Target user is required' }, 400);
    const selfDelete = target_user_id === actorId;
    if (selfDelete) {
      if (actor.role === 'owner') return json({ error: 'The owner account cannot be deleted here' }, 403);
    } else {
      const { data: target, error: targetError } = await adminClient.from('profiles').select('id,role').eq('id', target_user_id).maybeSingle();
      if (targetError || !target) return json({ error: 'Target profile not found' }, 404);
      if ((rank[actor.role] ?? -1) < 3 || (rank[target.role] ?? 99) >= (rank[actor.role] ?? -1)) {
        return json({ error: 'Insufficient permission to delete this account' }, 403);
      }
    }
    const { error: deleteError } = await adminClient.auth.admin.deleteUser(target_user_id);
    if (deleteError) return json({ error: `Account deletion failed: ${deleteError.message}` }, 500);
    return json({ ok: true, deleted_user_id: target_user_id });
  }

  if (action === 'reset_password') {
    if (typeof target_user_id !== 'string' || (rank[actor.role] ?? -1) < 3) {
      return json({ error: 'Insufficient permission' }, 403);
    }
    const { data: target, error: targetError } = await adminClient.from('profiles').select('id,role').eq('id', target_user_id).maybeSingle();
    if (targetError || !target) return json({ error: 'Target profile not found' }, 404);
    if ((rank[target.role] ?? 99) >= (rank[actor.role] ?? -1)) return json({ error: 'You cannot reset this account password' }, 403);
    const { data: authTarget, error: authTargetError } = await adminClient.auth.admin.getUserById(target_user_id);
    if (authTargetError || !authTarget.user?.email) return json({ error: 'Target email not found' }, 404);
    const redirectTo = Deno.env.get('APPLEBOOK_REDIRECT_URL') || 'https://vampirecr.github.io/applefzzy/';
    const { data: linkData, error: linkError } = await adminClient.auth.admin.generateLink({
      type: 'recovery', email: authTarget.user.email, options: { redirectTo },
    });
    if (linkError || !linkData.properties?.action_link) return json({ error: linkError?.message || 'Could not create recovery link' }, 500);
    return json({ ok: true, action_link: linkData.properties.action_link });
  }

  return json({ error: 'Unknown action' }, 400);
});
