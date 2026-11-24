<script setup>
/**
 * 语音：音色库下载与管理（核心版）。与桌宠端 VoiceSettings 对等。
 * 只有装了语音扩展包（service: speech.tts）才在导航显示，见 SettingsNav。
 * 后端端点：/api/extensions/voices（GET 列表 / POST 下载 / DELETE 删除 / GET progress）。
 */
import { ref, onMounted, onUnmounted } from 'vue';
import { api } from '../../api.js';

const emit = defineEmits(['saved']);
const libs = ref([]);
const loading = ref(true);
const busyId = ref('');
const errorMsg = ref('');
const progress = ref({});
let timer = null;

async function refresh() {
  loading.value = true; errorMsg.value = '';
  try { const r = await api('/api/extensions/voices'); if (r?.ok) libs.value = r.libs || []; else errorMsg.value = r?.message || '读取失败'; }
  catch (e) { errorMsg.value = e?.message || String(e); }
  finally { loading.value = false; }
}
function startPoll(id) {
  busyId.value = id; progress.value[id] = '准备下载…';
  if (timer) clearInterval(timer);
  timer = setInterval(async () => { try { const r = await api('/api/extensions/voices/progress'); if (r?.progress) progress.value[id] = r.progress; } catch {} }, 600);
}
function stopPoll() { if (timer) clearInterval(timer); timer = null; busyId.value = ''; }
async function download(lib) {
  errorMsg.value = ''; startPoll(lib.id);
  try { const r = await api('/api/extensions/voices/' + encodeURIComponent(lib.id) + '/download', { method: 'POST' }); if (r?.ok) emit('saved', '「' + lib.name + '」下载完成'); else errorMsg.value = r?.error || r?.message || '下载失败'; }
  catch (e) { errorMsg.value = e?.message || String(e); }
  finally { stopPoll(); await refresh(); }
}
async function remove(lib) {
  if (!window.confirm('删掉音色库「' + lib.name + '」？删了可以重新下载。')) return;
  errorMsg.value = '';
  try { const r = await api('/api/extensions/voices/' + encodeURIComponent(lib.id), { method: 'DELETE' }); if (r?.ok) emit('saved', '音色库已删除'); else errorMsg.value = r?.error || r?.message || '删除失败'; }
  catch (e) { errorMsg.value = e?.message || String(e); }
  finally { await refresh(); }
}
function fmt(bytes) { return bytes ? (bytes / 1048576).toFixed(1) + ' MB' : ''; }
onMounted(refresh); onUnmounted(stopPoll);
</script>

<template>
  <section class="card">
    <h2>语音 · 音色库</h2>
    <p class="card-desc">给 Kirari 配中文音色，完全离线合成。音色库放在扩展包目录里，下载后自动识别。桌面端和这里共用同一份音色库。</p>
    <p v-if="errorMsg" class="error">{{ errorMsg }}</p>
    <p v-if="loading" class="dim">读取中…</p>
    <div v-else class="voice-libs">
      <div v-for="lib in libs" :key="lib.id" class="voice-lib">
        <div class="voice-lib-main">
          <strong>{{ lib.name }}</strong>
          <span class="dim">{{ lib.description }} · {{ fmt(lib.installedBytes || lib.sizeBytes) }} · {{ lib.license }}</span>
          <span v-if="busyId === lib.id" class="dim">{{ progress[lib.id] }}</span>
        </div>
        <div class="voice-lib-ops">
          <button v-if="!lib.installed" class="mini primary" :disabled="!!busyId" @click="download(lib)">下载</button>
          <template v-else>
            <span class="pill ok">已装</span>
            <button class="mini danger" :disabled="!!busyId" @click="remove(lib)">删除</button>
          </template>
        </div>
      </div>
    </div>
  </section>
</template>
