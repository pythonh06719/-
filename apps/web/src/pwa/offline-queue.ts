import type { HttpMethod } from '@/lib/api';
import { apiRequest } from '@/lib/api';

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
    return stored;
  }
  try {
    const id = await runTransaction<number>('readwrite', (store) =>
      store.add(record) as IDBRequest<number>,
    );
    return { ...record, id };
  } catch {
    const stored: QueuedRequest = { ...record, id: memoryIdSeed };
    memoryIdSeed += 1;
    memoryQueue.push(stored);
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
    return;
  }
  try {
    await runTransaction<undefined>('readwrite', (store) => store.delete(id) as IDBRequest<undefined>);
  } catch {
    memoryQueue = memoryQueue.filter((entry) => entry.id !== id);
  }
}

/** 清空队列（退出登录 / 账号删除）。 */
export async function clearQueuedRequests(): Promise<void> {
  memoryQueue = [];
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
}

/**
 * 尝试把队列中的请求按时间顺序发送出去。
 *
 * - 成功 → 从队列移除；
 * - 未成功（含网络仍不可达）→ 保留在队列，本次同步结束（不阻塞后续 UI）。
 */
export async function flushQueue(): Promise<FlushResult> {
  const queued = await listQueuedRequests();
  let synced = 0;
  for (const entry of queued) {
    try {
      await apiRequest(entry.path, { method: entry.method, body: entry.body });
      await removeQueuedRequest(entry.id);
      synced += 1;
    } catch {
      break;
    }
  }
  const remaining = (await listQueuedRequests()).length;
  return { synced, remaining };
}

/** 队列长度（用于 UI 展示「N 条待同步」）。 */
export async function queueLength(): Promise<number> {
  return (await listQueuedRequests()).length;
}

/** 测试专用：重置内存队列。 */
export function __resetMemoryQueueForTest(): void {
  memoryQueue = [];
  memoryIdSeed = 1;
}
