// src/services/scheduledJobsService.js
// 阶段 C 定时任务调度器（core 侧 IO，不进共享包）。
//
// 职责：周期扫描 scheduled_jobs 里到点的任务（isDue 来自共享包），
// 通过 WS 主动推送提醒给对应 uid，再用 fireJob 落库（once 置 fired / daily 顺延）。
// 调度状态不落库在别处——「哪些没跑」直接以 job 的 status+dueAt 为准，重启后扫表即恢复。

const { isDue, fireJob } = require('kirari-agent');
const { jobStore } = require('../session/jobStore');

let timer = null;
let scanning = false;
const SCAN_INTERVAL_MS = 15 * 1000;

/** 扫一次到点任务并逐个触发。供定时器与手动调用（测试/启动补跑）共用。 */
async function scanOnce() {
  if (scanning) return 0;
  scanning = true;
  let fired = 0;
  try {
    const now = Date.now();
    const due = jobStore.due(now, 100);
    for (const job of due) {
      if (!isDue(job, now)) continue; // 双保险：sql 已过滤，这里再按共享包语义核对
      try {
        let delivered = 0;
        if (job.kind === 'reminder') {
          // 惰性 require 避开 socketServer ↔ 其他模块的顶层循环。
          const { pushProactiveMessage } = require('../websocket/socketServer');
          delivered = pushProactiveMessage(job.uid, {
            speech: job.payload,
            sessionId: job.sessionId,
            emotion: 'happy',
          });
          console.log(`[sched] 提醒 job=${job.jobId} uid=${job.uid} 送达 ${delivered} 个连接`);
        } else if (job.kind === 'daily_brief') {
          // 阶段 E：简报任务（每 uid × 08/16/22 三档）。生成成功与否都顺延，
          // 失败时 briefSchedule 内部已回滚档位锁并 warn，不会形成 15s 热循环。
          const briefSchedule = require('./briefSchedule');
          await briefSchedule.fireDailyBrief(job, now);
        }
        // 没有在线连接也算触发过：once 任务不能因为「没连上」而永远 pending 反复推。
        const next = fireJob(job, now);
        jobStore.save(next, 'job_fired');
        fired++;
      } catch (e) {
        // 单条失败不影响其他任务；保留 pending 让下一轮重试（不是无限——到点仍 pending）。
        console.warn(`[sched] 触发 job=${job.jobId} 失败（稍后重试）:`, e?.message || e);
      }
    }
  } catch (e) {
    console.warn('[sched] 扫表失败（稍后重试）:', e?.message || e);
  } finally {
    scanning = false;
  }
  if (fired > 0) {
    // 让 job_fired 事件及时落库；失败只 warn（旁路语义）。
    try { await require('../session/eventRecorder').recorder.flush(); } catch (e) { console.warn('[sched] 事件 flush 失败:', e?.message || e); }
  }
  return fired;
}

/** 启动调度器：先补跑一次（覆盖服务停机期间到点的任务），再挂周期定时。 */
function start() {
  if (timer) return;
  void scanOnce();
  timer = setInterval(() => { void scanOnce(); }, SCAN_INTERVAL_MS);
  // 定时器不该阻止进程退出。
  if (timer.unref) timer.unref();
  console.log('[sched] 定时任务调度器已启动（每 15s 扫描）');
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, scanOnce };
