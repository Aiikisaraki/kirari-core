<script setup>
import { ref, onMounted } from 'vue';

// B站互动开关：与命令共用 settings_kv 单键，命令改完这里刷新即可见（双向同步）。
const emit = defineEmits(['saved']);
const state = ref({ comment: false, dynamic: false, dm: false, like: false, coin: false, favorite: false });
const loading = ref(true);
const saving = ref(false);
const error = ref('');

const CH = [
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
    const r = await fetch('/api/bili/interaction');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    state.value = { ...state.value, ...(await r.json()) };
  } catch (e) { error.value = '读取失败：' + e.message; }
  finally { loading.value = false; }
}
async function toggle(key) {
  saving.value = true; error.value = '';
  try {
    const next = { ...state.value, [key]: !state.value[key] };
    const r = await fetch('/api/bili/interaction', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [key]: next[key] }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    state.value = await r.json();
    emit('saved', 'B站互动开关已更新');
  } catch (e) { error.value = '保存失败：' + e.message; }
  finally { saving.value = false; }
}
onMounted(load);
defineExpose({ reload: load }); // 供外部命令修改后刷新
</script>

<template>
  <section class="card">
    <h2>B站互动</h2>
    <p class="card-desc">
      她去 B 站是公开环境，默认把互动对象当作可能是恶意第三人：评论和动态只谈当前话题、只表达看法态度，
      不透露过去看过什么、不引用记忆、不给来源线索。三个开关与命令双向同步。
    </p>
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
