import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const $ = (id) => document.getElementById(id);
const configured = !SUPABASE_URL.includes('YOUR') && !SUPABASE_ANON_KEY.includes('YOUR');
const sb = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// 앱 상태
const S = {
  code: null,
  me: null, // { role: 'host', secret } | { role: 'player', playerId, secret }
  room: null,
  players: [],
  rounds: [],
  answers: [],
  sig: '',
  composerRound: null,
  channel: null,
  poll: null,
};

// ───────── 유틸 ─────────
const store = {
  key: (code) => `sogaeting:${code}`,
  get(code) { try { return JSON.parse(localStorage.getItem(this.key(code))); } catch { return null; } },
  set(code, v) { try { localStorage.setItem(this.key(code), JSON.stringify(v)); } catch {} },
  del(code) { try { localStorage.removeItem(this.key(code)); } catch {} },
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

let toastTimer;
function toast(msg, ms = 2400) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

async function rpc(fn, args) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

function show(view) {
  for (const v of ['home', 'game', 'result']) $(`view-${v}`).hidden = v !== view;
}

const isHost = () => S.me?.role === 'host';
const shareUrl = () => `${location.origin}${location.pathname}?room=${S.code}`;
const openRound = () => S.rounds.find((r) => r.status === 'open');
const playerName = (id) => S.players.find((p) => p.id === id)?.name ?? '(나간 참가자)';

// ───────── 데이터 동기화 ─────────
async function fetchAll() {
  const [room, players, rounds, answers] = await Promise.all([
    sb.from('rooms').select('*').eq('code', S.code).maybeSingle(),
    sb.from('players').select('*').eq('room_code', S.code).order('joined_at'),
    sb.from('rounds').select('*').eq('room_code', S.code).order('id'),
    sb.from('answers').select('*').eq('room_code', S.code).order('id'),
  ]);
  const err = room.error || players.error || rounds.error || answers.error;
  if (err) throw err;
  S.room = room.data;
  S.players = players.data;
  S.rounds = rounds.data;
  S.answers = answers.data;
}

let syncTimer;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, 120);
}

async function sync() {
  try {
    await fetchAll();
    render();
  } catch (e) {
    console.error(e);
  }
}

function subscribe() {
  const f = `room_code=eq.${S.code}`;
  const on = (table, filter) => ['postgres_changes', { event: '*', schema: 'public', table, filter }, scheduleSync];
  S.channel = sb.channel(`room:${S.code}`)
    .on(...on('rooms', `code=eq.${S.code}`))
    .on(...on('players', f))
    .on(...on('rounds', f))
    .on(...on('answers', f))
    .subscribe();
  // 실시간 연결이 끊겨도 따라잡도록 보조 폴링
  S.poll = setInterval(scheduleSync, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleSync(); });
}

function unsubscribe() {
  clearInterval(S.poll);
  if (S.channel) sb.removeChannel(S.channel);
  S.channel = null;
}

// ───────── 입장 ─────────
async function enterRoom(code, me) {
  S.code = code;
  S.me = me;
  history.replaceState(null, '', `?room=${code}`);
  try {
    await fetchAll();
  } catch (e) {
    toast('서버에 연결하지 못했어요');
    console.error(e);
    return;
  }
  if (!S.room) {
    store.del(code);
    toast('방을 찾을 수 없어요');
    showJoin(null);
    return;
  }
  if (me.role === 'player' && !S.players.some((p) => p.id === me.playerId)) {
    store.del(code);
    showJoin(code);
    return;
  }
  subscribe();
  render();
}

function showJoin(code) {
  $('join-code').value = code ?? '';
  $('card-create').hidden = !!code;
  show('home');
  (code ? $('join-name') : $('join-code')).focus();
}

$('form-join').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const res = await rpc('join_room', { p_code: $('join-code').value, p_name: $('join-name').value });
    const me = { role: 'player', playerId: res.player_id, secret: res.secret };
    store.set(res.code, me);
    await enterRoom(res.code, me);
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

$('form-create').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const res = await rpc('create_room', { p_host_name: $('create-name').value });
    const me = { role: 'host', secret: res.secret };
    store.set(res.code, me);
    await enterRoom(res.code, me);
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

// ───────── 렌더링 ─────────
function render() {
  const sig = JSON.stringify([S.room, S.players, S.rounds, S.answers]);
  if (sig === S.sig) return;
  S.sig = sig;

  if (S.room.status === 'ended') {
    unsubscribe();
    renderResult();
    return;
  }
  show('game');
  $('host-name').textContent = S.room.host_name;
  $('room-code').textContent = S.code;
  $('role-label').textContent = isHost() ? '호스트' : `${playerName(S.me.playerId)} 님`;
  $('btn-end').hidden = !isHost();
  renderScores();
  renderLog();
  renderComposer();
}

function renderScores() {
  $('scores').innerHTML = S.players.length
    ? S.players.map((p) => `
        <span class="chip${p.id === S.me.playerId ? ' me' : ''}">
          ${esc(p.name)} <b>❤ ${p.score}</b>
        </span>`).join('')
    : '<span class="chip muted">아직 참가자가 없어요</span>';
}

function renderLog() {
  const log = $('log');
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;

  if (!S.rounds.length) {
    log.innerHTML = isHost()
      ? `<div class="empty">
           <p>참가자 <b>${S.players.length}</b>명 입장</p>
           <p>아래 링크를 공유하고, 첫 이야기를 건네보세요.</p>
           <code class="link">${esc(shareUrl())}</code>
         </div>`
      : `<div class="empty"><p>${esc(S.room.host_name)}님이 곧 이야기를 시작할 거예요…</p></div>`;
    return;
  }

  log.innerHTML = S.rounds.map(roundHtml).join('');
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

function roundHtml(r) {
  const ans = S.answers.filter((a) => a.round_id === r.id);
  let html = `
    <div class="msg">
      <div class="who">${esc(S.room.host_name)}</div>
      <div class="bubble">${esc(r.question)}</div>
    </div>`;

  if (r.status === 'open') {
    const meta = `답변 ${ans.length}/${S.players.length}명`;
    if (isHost()) {
      // 블라인드 선택: 이름은 고른 뒤 공개
      html += `<div class="answers">
        <div class="meta">${meta} · 누가 썼는지는 선택 후 공개돼요</div>
        ${ans.map((a, i) => `
          <div class="answer">
            <span class="tag">${String.fromCharCode(65 + i)}</span>
            <p>${esc(a.body)}</p>
            <button class="btn small heart" type="button" data-pick="${a.id}">❤ 선택</button>
          </div>`).join('')}
      </div>`;
    } else {
      const mine = ans.find((a) => a.player_id === S.me.playerId);
      html += `<div class="answers">
        <div class="meta">${meta}${mine ? ' · 내 답변 제출 완료' : ''}</div>
        ${mine ? `<div class="answer mine"><span class="tag">나</span><p>${esc(mine.body)}</p></div>` : ''}
      </div>`;
    }
    return html;
  }

  // 마감된 질문: 전체 공개, 선택된 답변 맨 위
  const sorted = [...ans].sort((a, b) => (b.id === r.winner_answer_id) - (a.id === r.winner_answer_id));
  html += `<div class="answers">
    ${r.winner_answer_id ? '' : '<div class="meta">선택된 답변 없이 넘어갔어요</div>'}
    ${sorted.map((a) => {
      const win = a.id === r.winner_answer_id;
      const mine = a.player_id === S.me.playerId;
      return `
        <div class="answer${win ? ' win' : ''}${mine ? ' mine' : ''}">
          <span class="tag">${esc(playerName(a.player_id))}</span>
          <p>${esc(a.body)}</p>
          ${win ? '<span class="badge">💘 선택</span>' : ''}
        </div>`;
    }).join('')}
  </div>`;
  return html;
}

function renderComposer() {
  const form = $('form-send');
  const text = $('send-text');
  const hint = $('composer-hint');
  const btn = $('send-btn');
  const open = openRound();

  if (isHost()) {
    form.hidden = false;
    text.placeholder = `${S.room.host_name}의 이야기를 입력하세요`;
    btn.textContent = '보내기';
    hint.textContent = open
      ? '마음에 드는 답변을 고르거나, 새 이야기를 보내면 지금 질문은 선택 없이 넘어가요'
      : S.rounds.length ? '다음 이야기를 건네보세요' : '첫 마디를 건네보세요';
    return;
  }

  if (!open) {
    form.hidden = true;
    hint.textContent = S.rounds.length
      ? `${S.room.host_name}님이 다음 이야기를 고민 중이에요…`
      : '';
    return;
  }

  if (S.composerRound !== open.id) {
    S.composerRound = open.id;
    text.value = '';
  }
  const mine = S.answers.some((a) => a.round_id === open.id && a.player_id === S.me.playerId);
  form.hidden = false;
  text.placeholder = '나의 대답을 입력하세요';
  btn.textContent = mine ? '수정' : '답하기';
  hint.textContent = mine ? '선택되기 전까지는 답변을 고칠 수 있어요' : `${S.room.host_name}님의 이야기에 답해보세요`;
}

function renderResult() {
  show('result');
  const players = [...S.players].sort((a, b) => b.score - a.score || a.joined_at.localeCompare(b.joined_at));

  // 동점자는 같은 순위 (1, 1, 3 …)
  let rank = 0;
  const ranked = players.map((p, i) => {
    if (i === 0 || p.score !== players[i - 1].score) rank = i + 1;
    return { ...p, rank };
  });

  const wins = {};
  for (const r of S.rounds) {
    const a = S.answers.find((x) => x.id === r.winner_answer_id);
    if (a) (wins[a.player_id] ??= []).push({ q: r.question, a: a.body });
  }

  const top = ranked.filter((p) => p.rank === 1 && p.score > 0);
  $('result-title').textContent = `${S.room.host_name}님의 선택`;
  $('result-sub').textContent = top.length === 1
    ? `${top[0].name}님이 애프터 신청을 받았어요!`
    : top.length > 1 ? `${top.map((p) => p.name).join(', ')}님 공동 1위! 그녀의 마음은 아직 고민 중…`
    : '이번엔 아무도 그녀의 마음을 얻지 못했어요';

  const medal = (n) => ['🥇', '🥈', '🥉'][n - 1] ?? `${n}위`;
  $('ranking').innerHTML = ranked.map((p) => `
    <li class="rank-item${p.rank === 1 && p.score > 0 ? ' first' : ''}${p.id === S.me?.playerId ? ' me' : ''}">
      <div class="rank-head">
        <span class="medal">${medal(p.rank)}</span>
        <span class="name">${esc(p.name)}</span>
        <span class="score">❤ ${p.score}</span>
      </div>
      ${(wins[p.id] ?? []).map((w) => `
        <div class="win-line"><span class="q">${esc(w.q)}</span><span class="a">${esc(w.a)}</span></div>`).join('')}
    </li>`).join('') || '<li class="rank-item">참가자가 없었어요</li>';
}

// ───────── 액션 ─────────
$('log').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-pick]');
  if (!btn || !confirm('이 답변을 선택할까요?')) return;
  btn.disabled = true;
  try {
    await rpc('pick_winner', { p_code: S.code, p_secret: S.me.secret, p_answer_id: Number(btn.dataset.pick) });
    await sync();
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
  }
});

$('form-send').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('send-text');
  const body = text.value.trim();
  if (!body) return;
  const btn = $('send-btn');
  btn.disabled = true;
  try {
    if (isHost()) {
      const open = openRound();
      const pending = open && S.answers.some((a) => a.round_id === open.id);
      if (pending && !confirm('아직 고르지 않은 답변이 있어요. 선택 없이 다음 이야기로 넘어갈까요?')) return;
      await rpc('post_message', { p_code: S.code, p_secret: S.me.secret, p_text: body });
    } else {
      const open = openRound();
      if (!open) throw new Error('이미 마감된 질문이에요');
      await rpc('submit_answer', {
        p_player_id: S.me.playerId, p_secret: S.me.secret, p_round_id: open.id, p_body: body,
      });
    }
    text.value = '';
    await sync();
    $('log').scrollTop = $('log').scrollHeight;
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

// Enter로 전송, Shift+Enter로 줄바꿈 (한글 조합 중에는 무시)
$('send-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('form-send').requestSubmit();
  }
});

$('btn-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(shareUrl());
    toast('초대 링크를 복사했어요');
  } catch {
    prompt('이 링크를 복사해 공유하세요', shareUrl());
  }
});

$('btn-end').addEventListener('click', async () => {
  if (!confirm('소개팅을 종료하고 순위를 발표할까요?')) return;
  try {
    await rpc('end_room', { p_code: S.code, p_secret: S.me.secret });
    await sync();
  } catch (err) {
    toast(err.message);
  }
});

$('btn-home').addEventListener('click', () => { location.href = location.pathname; });

// ───────── 시작 ─────────
function init() {
  if (!configured) {
    show('home');
    toast('config.js에 Supabase 주소와 키를 넣어주세요', 0);
    return;
  }
  const code = new URLSearchParams(location.search).get('room')?.trim().toUpperCase();
  if (!code) return show('home');
  const me = store.get(code);
  if (me) enterRoom(code, me);
  else showJoin(code);
}

init();
