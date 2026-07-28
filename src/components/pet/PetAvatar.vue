<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useAvatarStore } from "../../stores/avatar";
import { createRenderer } from "../../pet/avatar/types";
import type { AvatarRenderer } from "../../pet/avatar/types";

const props = defineProps<{
  visible: boolean;
}>();

const avatarStore = useAvatarStore();
const canvasRef = ref<HTMLCanvasElement | null>(null);
let renderer: AvatarRenderer | null = null;

// 挂载（或重载）渲染器：先卸载旧的，再按当前配置创建、加载、挂载。
async function mountRenderer() {
  renderer?.destroy();
  renderer = null;

  const cfg = avatarStore.current;
  // live2d 占位无 src：渲染器会绘制"即将推出"提示，无需加载。
  if (!cfg.src) {
    const placeholder = createRenderer(cfg.type);
    if (placeholder) {
      renderer = placeholder;
      renderer.mount(canvasRef.value as HTMLCanvasElement);
    }
    return;
  }

  const next = createRenderer(cfg.type);
  if (!next) return;
  renderer = next;

  try {
    await renderer.load(cfg);
    // 加载成功后把各状态动画时长回填到 store，供调度器精确衔接。
    avatarStore.setDurations(renderer.getStateDurations());
  } catch (e) {
    console.error("[avatar] 形象加载失败:", e);
    return;
  }
  if (canvasRef.value) renderer.mount(canvasRef.value);
  renderer.setState(avatarStore.currentState);
}

onMounted(async () => {
  await mountRenderer();
});

onBeforeUnmount(() => {
  renderer?.destroy();
  renderer = null;
});

// 切换形象（设置面板更改后，avatar:changed 广播或 store 变更都会触发）
watch(
  () => avatarStore.current,
  async () => {
    await mountRenderer();
  },
);

// 切换播放状态（来自业务逻辑：收到消息 -> speak 等）
watch(
  () => avatarStore.currentState,
  (s) => {
    renderer?.setState(s);
  },
);
</script>

<template>
  <canvas
    ref="canvasRef"
    class="pet-canvas"
    :class="{ 'is-hidden': !visible }"
    aria-label="桌宠形象"
  ></canvas>
</template>

<style scoped>
.pet-canvas {
  display: block;
  width: 220px;
  height: 293px; /* 220 * 4 / 3，保持竖图比例，不畸变 */
  max-width: 86vw;
  max-height: 64vh;
  object-fit: contain;
  pointer-events: none;
}
.pet-canvas.is-hidden {
  opacity: 0;
}
</style>
