import { syncCommunitySnapshot } from '@feedsieve/community-lists';
import { COMMUNITY_SYNC_SOURCES, snapshotStore } from '../src/lib/community-store';
import { flushContributions } from '../src/lib/contribute';
import { syncKeywordPackCatalog } from '../src/lib/keyword-packs';
import { getPersistentBlockQueue } from '../src/lib/block-queue-store';

const QUEUE_RESUME_ALARM_PREFIX = 'feedsieve:block-queue-resume:';
const QUEUE_RESUME_RETRY_MS = 60 * 1000;

function queueResumeAlarmName(queueId: string): string {
  return `${QUEUE_RESUME_ALARM_PREFIX}${queueId}`;
}

export default defineBackground(() => {
  // MV3 service worker 随时可能被回收：这里只做事件入口。
  // 名单/词库同步不做定时 alarm：数据只在 X 页面打开时才被消费；
  // 下面的 alarms 只负责限流后的持久化队列恢复。

  function sync(force: boolean) {
    return syncCommunitySnapshot({
      sources: COMMUNITY_SYNC_SOURCES,
      fetchImpl: (url) => fetch(url),
      store: snapshotStore,
      force,
    });
  }

  function syncKeywordPacks(force: boolean) {
    return syncKeywordPackCatalog({ force });
  }

  async function scheduleQueueResume(
    queueId: string,
    resumeAt: number,
  ): Promise<void> {
    await browser.alarms.create(queueResumeAlarmName(queueId), {
      when: Math.max(resumeAt, Date.now() + 1000),
    });
  }

  async function clearQueueResume(queueId: string): Promise<void> {
    await browser.alarms.clear(queueResumeAlarmName(queueId));
  }

  async function restoreQueueResumeAlarm(): Promise<void> {
    const queue = await getPersistentBlockQueue();
    if (
      queue?.status === 'paused' &&
      queue.pauseReason === 'rate_limited' &&
      typeof queue.autoResumeAt === 'number'
    ) {
      await scheduleQueueResume(queue.id, queue.autoResumeAt);
    }
  }

  async function handleQueueResumeAlarm(alarm: { name: string }): Promise<void> {
    if (!alarm.name.startsWith(QUEUE_RESUME_ALARM_PREFIX)) return;
    const queueId = alarm.name.substring(QUEUE_RESUME_ALARM_PREFIX.length);
    const queue = await getPersistentBlockQueue();
    if (
      !queue ||
      queue.id !== queueId ||
      queue.status !== 'paused' ||
      queue.pauseReason !== 'rate_limited' ||
      typeof queue.autoResumeAt !== 'number'
    ) {
      await clearQueueResume(queueId);
      return;
    }
    if (queue.autoResumeAt > Date.now()) {
      await scheduleQueueResume(queue.id, queue.autoResumeAt);
      return;
    }
    if (typeof queue.targetTabId !== 'number') {
      await scheduleQueueResume(queue.id, Date.now() + QUEUE_RESUME_RETRY_MS);
      return;
    }
    try {
      const result = await browser.tabs.sendMessage(queue.targetTabId, {
        type: 'feedsieve:block-queue-auto-resume',
      });
      if ((result as { status?: string } | undefined)?.status === 'running') {
        await clearQueueResume(queue.id);
      } else {
        await scheduleQueueResume(queue.id, Date.now() + QUEUE_RESUME_RETRY_MS);
      }
    } catch {
      // The tab may be loading or temporarily suspended. Keep retrying until
      // its content script can receive the resume message.
      await scheduleQueueResume(queue.id, Date.now() + QUEUE_RESUME_RETRY_MS);
    }
  }

  browser.alarms.onAlarm.addListener((alarm) => {
    void handleQueueResumeAlarm(alarm);
  });

  browser.runtime.onInstalled.addListener((details) => {
    console.info(`[FeedSieve] installed (${details.reason})`);
    // 安装/更新后立即拉一次社区快照和关键词包。
    void sync(true);
    void syncKeywordPacks(true);
    // 升级后补传历史黑名单/白名单；同步状态会防止重复上传。
    void flushContributions();
    void restoreQueueResumeAlarm();
  });

  browser.runtime.onStartup.addListener(() => {
    // 社区名单与关键词包各自控制节流；关键词包当前每 15 分钟可检查一次 manifest。
    void sync(false);
    void syncKeywordPacks(false);
    // 补交上次网络失败时积压的社区贡献
    void flushContributions();
    void restoreQueueResumeAlarm();
  });

  // 内容脚本启动/每 15 分钟/重新回到前台时请求关键词同步；popup 手动同步带 force。
  browser.runtime.onMessage.addListener((message: unknown) => {
    const msg = message as { type?: string; force?: boolean } | null;
    if (msg?.type === 'feedsieve:community-sync') {
      return sync(msg.force === true).then((outcome) => ({
        type: 'feedsieve:community-sync',
        outcome,
      }));
    }
    if (msg?.type === 'feedsieve:keyword-packs-sync') {
      return syncKeywordPacks(msg.force === true).then((outcome) => ({
        type: 'feedsieve:keyword-packs-sync',
        outcome,
      }));
    }
    if (msg?.type === 'feedsieve:labels-sync') {
      return flushContributions().then(() => ({ type: 'feedsieve:labels-sync', ok: true }));
    }
    if (msg?.type === 'feedsieve:block-queue-schedule-resume') {
      const queueId = (message as { queueId?: unknown }).queueId;
      const resumeAt = (message as { resumeAt?: unknown }).resumeAt;
      if (typeof queueId === 'string' && typeof resumeAt === 'number') {
        return scheduleQueueResume(queueId, resumeAt).then(() => ({ ok: true }));
      }
      return Promise.resolve({ ok: false });
    }
    if (msg?.type === 'feedsieve:block-queue-clear-resume') {
      const queueId = (message as { queueId?: unknown }).queueId;
      if (typeof queueId === 'string') {
        return clearQueueResume(queueId).then(() => ({ ok: true }));
      }
      return Promise.resolve({ ok: false });
    }
    return undefined;
  });
});
