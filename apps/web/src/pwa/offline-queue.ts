import type { HttpMethod } from '@/lib/api';
import { apiRequest, isNetworkError } from '@/lib/api';

/**
 * 离线写入队列（pwa/offline-queue.ts）—— ARCHITECTURE §1.9 / D10 / Q7。
 *
 * 断网时允许继续记录（一餐 / 体重）：请求进入 IndexedDB 队列，恢复联网后按
 * **本地写入时间顺序**自动同步；冲突以**本地最新时间**为准（服务端 UPSERT 覆盖）。
 *
 * 环境兼容：不支持 IndexedDB（jsdom / 隐私模式）时自动降级为**内存队列**，
 * 保证逻辑可测、页面不崩。
 */

/** 队列中的一条待同步请求。 */
export interface QueuedRequest {
  /** 自增主键（内存实现下为递增计数） */
  id: number;
  /** 接口路径（以 `/api` 开头） */
  path: string;
  /** HTTP 方法 */
  method: HttpMethod;
  /** 请求体 */
  body?: unknown;
  /** 入队时刻（ISO8601 UTC，用于排序与冲突裁决） */
  createdAt: string;
}

const DB_NAME = 'qsh-offline';
const DB_VERSION = 1;
const STORE_NAME = 'requests';

let memoryQueue: QueuedRequest[] = [];
let memoryIdSeed = 1;

/* ---------------------------------------------------------------------------
 * 待同步条数的订阅出口（GAP-9）
 *
 * 本模块是**有状态模块级变量**（内存队列 + IndexedDB），没有天然的 React 可订阅源。
 * 为了让 UI 能实时显示「N 条待同步」，这里加一个**轻量订阅**：
 *
 * - 为什么**不**引入 zustand：队列是「纯副作用模块」，它的写入路径全部是
 *   `async function`（IndexedDB 是异步的），而且要覆盖 **IndexedDB 与内存两条降级路径**。
 *   用 zustand 就得把 `memoryQueue` / IndexedDB 的读写改成 store action，
 *   等于重写整个模块并破坏现有 5 个调用方 —— 收益（几乎没有）远小于风险。
 *   `registerSW.ts` 里的 `onServiceWorkerUpdate` 已经证明「模块级 Set + 退订闭包」
 *   在本项目里够用、可测、零依赖，这里沿用同一套做法。
 * - 通知**不发原始条数**：统一为「去抖后重读一次队列长度」，
 *   这样 IndexedDB / 内存两条路径共用同一条通知路径，调用方拿到的永远是真实值。
 * ------------------------------------------------------------------------- */

/** 待同步条数订阅者（无参：条数为零也算一次变化，UI 需要据此收起横幅）。 */
const queueListeners = new Set<() => void>();

/** 待同步条数订阅者数量（测试用：确认组件卸载后不留订阅）。 */
export function queueSubscriberCount(): number {
  return queueListeners.size;
}

/**
 * 订阅「待同步队列发生任何变化」。
 *
 * 变化来源：入队（{@link enqueueRequest}）、冲队（{@link flushQueue}）、
 * 单条移除（{@link removeQueuedRequest}）、清空（{@link clearQueuedRequests}）。
 *
 * 回调拿到的是「有变化」这一信号，**不是**条数本身 —— 新条数用
 * {@link queueLength} 重读（异步，但两条降级路径都能给出真实值）。
 * 这样调用方只需 `void queueLength().then(setPendingCount)`，不必区分实现路径。
 *
 * @param listener 变化回调（无参）
 * @returns 退订函数（可直接作为 `useEffect` 的返回值）
 */
export function subscribeQueue(listener: () => void): () => void {
  queueListeners.add(listener);
  return () => {
    queueListeners.delete(listener);
  };
}

/**
 * 广播「队列已变化」。
 *
 * 先拷贝再遍历：回调里可能顺手退订（同 `registerSW.notifyUpdate` 的理由）。
 * **永不抛错** —— 一个订阅者出错不能连累其余订阅者，更不能反过来把入队 / 冲队搞崩。
 */
function notifyQueueChanged(): void {
  for (const listener of [...queueListeners]) {
    try {
      listener();
    } catch {
      // 订阅者自身的异常与本模块无关：吞掉，保证队列写入路径永远不被 UI 拖垮
    }
  }
}

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

/** 打开（或创建）离线队列数据库。 */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('离线队列数据库打开没有成功'));
  });
}

function runTransaction<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, mode);
        const store = transaction.objectStore(STORE_NAME);
        const request = work(store);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('离线队列操作没有成功'));
        transaction.oncomplete = () => db.close();
      }),
  );
}

/** 入队一条待同步请求。 */
export async function enqueueRequest(
  entry: Omit<QueuedRequest, 'id' | 'createdAt'>,
): Promise<QueuedRequest> {
  const record = { ...entry, createdAt: new Date().toISOString() };
  if (!hasIndexedDb()) {
    const stored: QueuedRequest = { ...record, id: memoryIdSeed };
    memoryIdSeed += 1;
    memoryQueue.push(stored);
    notifyQueueChanged();
    return stored;
  }
  try {
    const id = await runTransaction<number>('readwrite', (store) =>
      store.add(record) as IDBRequest<number>,
    );
    notifyQueueChanged();
    return { ...record, id };
  } catch {
    const stored: QueuedRequest = { ...record, id: memoryIdSeed };
    memoryIdSeed += 1;
    memoryQueue.push(stored);
    notifyQueueChanged();
    return stored;
  }
}

/** 列出队列内容（按入队时间升序）。 */
export async function listQueuedRequests(): Promise<QueuedRequest[]> {
  if (!hasIndexedDb()) {
    return [...memoryQueue].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }
  try {
    const all = await runTransaction<QueuedRequest[]>('readonly', (store) =>
      store.getAll() as IDBRequest<QueuedRequest[]>,
    );
    return all.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  } catch {
    return [...memoryQueue].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }
}

/** 从队列移除一条记录。 */
export async function removeQueuedRequest(id: number): Promise<void> {
  if (!hasIndexedDb()) {
    memoryQueue = memoryQueue.filter((entry) => entry.id !== id);
    notifyQueueChanged();
    return;
  }
  try {
    await runTransaction<undefined>('readwrite', (store) => store.delete(id) as IDBRequest<undefined>);
    notifyQueueChanged();
  } catch {
    memoryQueue = memoryQueue.filter((entry) => entry.id !== id);
    notifyQueueChanged();
  }
}

/** 清空队列（退出登录 / 账号删除）。 */
export async function clearQueuedRequests(): Promise<void> {
  memoryQueue = [];
  notifyQueueChanged();
  if (!hasIndexedDb()) {
    return;
  }
  try {
    await runTransaction<undefined>('readwrite', (store) =>
      store.clear() as IDBRequest<undefined>,
    );
  } catch {
    // 忽略
  }
}

/** 队列同步结果。 */
export interface FlushResult {
  /** 成功同步条数 */
  synced: number;
  /** 仍未能同步（留在队列）条数 */
  remaining: number;
  /** 本轮因业务错误被跳过（仍留在队列，待下轮再试）的条数 */
  skipped: number;
  /** 本轮因连续失败达上限而被丢弃的条数（毒消息，避免永久重试） */
  dropped: number;
}

/**
 * 单条请求连续失败多少次后丢弃。
 *
 * 为什么需要：某些请求会**永久**失败（如引用的记录已被删除、字段已不合法）。
 * 若只是无限重试，「毒消息」会每次同步都白跑一遍（虽已不再阻塞别人，但噪音大且
 * 可能一直占位）；连续失败到上限即丢弃，符合「本地最新时间」的冲突裁决语义。
 */
export const MAX_FLUSH_ATTEMPTS = 3;

/** 每条请求的连续失败次数（内存即可；成功 / 丢弃 / 重置后清零）。 */
const flushFailures = new Map<number, number>();

/**
 * 尝试把队列中的请求按时间顺序发送出去。
 *
 * 关键修正（缺陷回归）：旧实现遇到**第一条**失败就 `break`，导致一条坏消息
 * 会把后面所有健康请求一起堵死（离线能力形同瘫痪）。现改为：
 *
 * - 成功 → 从队列移除、清零该条失败计数；
 * - **网络层错误** → 说明网络仍不可达，本轮到此为止（条目全部留在队列，下轮再试）；
 * - **业务错误** → 跳过这一条并计数，**继续处理后面的请求**；同一路径连续失败
 *   达 {@link MAX_FLUSH_ATTEMPTS} 次则丢弃，避免毒消息被永久重试。
 *
 * 全程不抛异常、不阻塞 UI（`registerSW` 以 `void` 调用）。
 */
export async function flushQueue(): Promise<FlushResult> {
  const queued = await listQueuedRequests();
  let synced = 0;
  let skipped = 0;
  let dropped = 0;
  for (const entry of queued) {
    try {
      await apiRequest(entry.path, { method: entry.method, body: entry.body });
      await removeQueuedRequest(entry.id);
      flushFailures.delete(entry.id);
      synced += 1;
    } catch (error) {
      // 网络仍不可达：后续请求多半同样发不出去，本轮结束，条目全部保留。
      if (isNetworkError(error)) {
        break;
      }
      // 业务错误：跳过并计数，绝不拖累队列里后面的请求。
      const attempts = (flushFailures.get(entry.id) ?? 0) + 1;
      if (attempts >= MAX_FLUSH_ATTEMPTS) {
        await removeQueuedRequest(entry.id);
        flushFailures.delete(entry.id);
        dropped += 1;
      } else {
        flushFailures.set(entry.id, attempts);
        skipped += 1;
      }
    }
  }
  const remaining = (await listQueuedRequests()).length;
  /**
   * 冲队结束后**只播一次**：过程中每条 `removeQueuedRequest` 都会播报，
   * 一轮 500 条会触发 500 次重读 —— 这里在末尾统一兜一次，UI 侧再做合并即可。
   */
  notifyQueueChanged();
  return { synced, remaining, skipped, dropped };
}

/** 队列长度（用于 UI 展示「N 条待同步」）。 */
export async function queueLength(): Promise<number> {
  return (await listQueuedRequests()).length;
}

/** 测试专用：重置内存队列。 */
export function __resetMemoryQueueForTest(): void {
  memoryQueue = [];
  memoryIdSeed = 1;
  flushFailures.clear();
}
