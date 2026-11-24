<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { request } from '../../api.js';

// B站互动开关：与命令共用 settings_kv 单键，命令改完这里刷新即可见（双向同步）。
const emit = defineEmits(['saved']);
const state = ref({ enabled: false, autoBrowse: false, comment: false, dynamic: false, dm: false, like: false, coin: false, favorite: false });
const login = ref({ loggedIn: false, anonymousOnly: true });
const pending = ref([]); // 待审核评论
const qr = ref('');          // 二维码扫码链接
const qrMsg = ref('');       // 轮询提示
// 用公开 QR 服务把扫码链接渲染成图片；外网不通时下面的降级链接仍可用
const qrImageUrl = computed(() => qr.value ? 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(qr.value) : '');
let pollTimer = null;
const loading = ref(true);
const saving = ref(false);
const error = ref('');

const CH = [
  { key: 'enabled', name: 'B站总开关', desc: '关掉后我完全不去B站，所有B站动作都会被拒绝。' },
  { key: 'autoBrowse', name: '自主闲逛', desc: '允许我在空闲时自己去看有趣的内容（低优先级，随时可中断）。关掉后只有你明确叫我去我才去。' },
  { key: 'comment', name: '评论', desc: '视频与专栏下只就当前话题表达看法态度；不引用记忆、不引流。' },
  { key: 'dynamic', name: '动态', desc: '需要时会发一条动态；不带任何浏览历史或他人的信息。' },
  { key: 'dm', name: '私信', desc: '默认永久关闭。即使手动开启，也不会主动私信任何人。' },
  { key: 'like', name: '点赞', desc: '视频与专栏文章的点赞。' },
  { key: 'coin', name: '投币', desc: '视频与专栏文章的投币。' },
  { key: 'favorite', name: '收藏', desc: '视频与专栏文章的收藏。' },
];

async function load() {
  loading.value = true; error.value = '';
  try {
    // request() 直接返回解析后的 JSON（不是 Response），端点返回裸开关对象
    const data = await request('/api/bili/interaction');
    state.value = { ...state.value, ...data };
  } catch (e) { error.value = '读取失败：' + e.message; }
  finally { loading.value = false; }
}
async function toggle(key) {
  saving.value = true; error.value = '';
  try {
    const next = { ...state.value, [key]: !state.value[key] };
    const data = await request('/api/bili/interaction', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [key]: next[key] }),
    });
    state.value = data;
    emit('saved', 'B站互动开关已更新');
  } catch (e) { error.value = '保存失败：' + e.message; }
  finally { saving.value = false; }
}
async function loadLogin() {
  try { const d = await request('/api/bili/login/status'); login.value = d || { loggedIn: false }; } catch {}
}
async function startQr() {
  qrMsg.value = '正在生成二维码…'; qr.value = '';
  try {
    const d = await request('/api/bili/login/qr', { method: 'POST' });
    if (d?.url) { qr.value = d.url; qrMsg.value = '请用手机 B站 App 扫码，扫码后自动登录。'; pollQr(); }
    else qrMsg.value = d?.message || '生成失败';
  } catch (e) { qrMsg.value = '生成失败：' + (e.message || e); }
}
function pollQr() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const d = await request('/api/bili/login/poll');
      if (d?.status === 'success') { clearInterval(pollTimer); pollTimer = null; qr.value = ''; qrMsg.value = '登录成功'; await loadLogin(); emit('saved', 'B站登录成功'); }
      else if (d?.status === 'expired') { clearInterval(pollTimer); pollTimer = null; qrMsg.value = '二维码已过期，请重新生成'; }
      else if (d?.message) qrMsg.value = d.message;
    } catch {}
  }, 2000);
}
async function doLogout() {
  try { await request('/api/bili/login/logout', { method: 'POST' }); qr.value = ''; await loadLogin(); emit('saved', '已退出B站登录'); } catch {}
}
async function loadPending() {
  try { const d = await request('/api/bili/review/pending'); pending.value = d?.pending || []; } catch {}
}
async function decide(id, approve) {
  try { await request('/api/bili/review/decide', { method:'POST', body: JSON.stringify({ id, approve }) }); await loadPending(); emit('saved', approve ? '已批准评论' : '已拒绝评论'); } catch {}
}
onUnmounted(() => { if (pollTimer) clearInterval(pollTimer); });
onMounted(() => { load(); loadLogin(); loadPending(); });
defineExpose({ reload: load }); // 供外部命令修改后刷新
</script>

<template>
  <section class="card">
    <h2>B站互动</h2>
    <p class="card-desc">
      她去 B 站是公开环境，默认把互动对象当作可能是恶意第三人：评论和动态只谈当前话题、只表达看法态度，
      不透露过去看过什么、不引用记忆、不给来源线索。三个开关与命令双向同步。
    </p>
    <!-- B站登录：扫码二维码（凭证只存本机，不进记忆） -->
    <div class="bili-login">
      <div class="row">
        <div class="row-text">
          <h3>B站账号</h3>
          <p class="dim">{{ login.loggedIn ? '已登录（可以用推荐流发现内容、互动）' : '未登录：只能看公开热门，互动与个性化发现需要扫码登录。凭证只存本机，绝不进记忆。' }}</p>
        </div>
        <button v-if="login.loggedIn" class="mini" @click="doLogout">退出登录</button>
        <button v-else class="mini primary" @click="startQr">扫码登录</button>
      </div>
      <p v-if="qrMsg" class="dim">{{ qrMsg }}</p>
      <div v-if="qr" class="qr-box">
        <p class="dim">手机 B站 App → 我的 → 扫一扫：</p>
        <img :src="qrImageUrl" alt="B站登录二维码" class="qr-img" />
        <p class="dim"><a :href="qr" target="_blank" rel="noopener">打不开二维码？点这里用手机浏览器打开链接</a></p>
      </div>
    </div>
    <!-- 发送前审核：评论先到队列，批准后才真发 -->
    <div class="review-box">
      <h3>待审核评论<span v-if="pending.length">（{{ pending.length }}）</span></h3>
      <p class="dim">她想发的评论会先到这里，你批准后才会真正发出去。需要先开启上面的「评论」开关，她才会产生待审评论。</p>
      <p v-if="!pending.length" class="dim" style="opacity:.7">暂无待审核评论。</p>
      <div v-for="p in pending" :key="p.id" class="review-item">
        <span class="dim">{{ p.kind }} · {{ new Date(p.createdAt).toLocaleString() }}</span>
        <p>{{ p.text }}</p>
        <div class="review-ops">
          <button class="mini primary" @click="decide(p.id, true)">批准</button>
          <button class="mini" @click="decide(p.id, false)">拒绝</button>
        </div>
      </div>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="loading" class="dim">读取中…</p>
    <div v-else class="rows">
      <div v-for="ch in CH" :key="ch.key" class="row">
        <div class="row-text">
          <h3>{{ ch.name }}</h3>
          <p class="dim">{{ ch.desc }}</p>
        </div>
        <button class="mini" :class="state[ch.key] ? 'primary' : ''" :disabled="saving"
          :aria-label="(state[ch.key] ? '关闭' : '开启') + ch.name" @click="toggle(ch.key)">
          {{ state[ch.key] ? '已开启' : '已关闭' }}
        </button>
      </div>
    </div>
  </section>
</template>
