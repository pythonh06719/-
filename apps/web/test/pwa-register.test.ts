/**
 * PWA 新版本检测测试（pwa/registerSW.ts）。
 *
 * jsdom 没有 Service Worker 实现，这里注入一个**最小的假容器**来驱动真实代码路径，
 * 覆盖五条最该钉死的行为：
 * 1. 已有控制者时新 worker 安装完成 → 通知「有新版本」（回调 + 自定义事件，且只通知一次）；
 * 2. **首次安装**（此前无控制者）→ 不通知（那是「装好了」，不是「有新版本」）；
 * 3. 注册时就存在 waiting 中的 worker + 已有控制者 → 立即通知（含「更新早于挂载」的补触发）；
 * 4. `applyServiceWorkerUpdate()`：有 waiting → `postMessage({type:'SKIP_WAITING'})`，接管后只刷新一次；
 * 5. `applyServiceWorkerUpdate()`：无 waiting（`autoUpdate` 产物的常态）→ 直接刷新。
 *
 * ⚠️ 模块内是会话级单例（`registered` / `updateNotified` / `reloading` / `currentRegistration`），
 * 故每个用例开头都 `vi.resetModules()` 后重新 import，拿一份干净状态；
 * 且**注册与订阅必须用同一份模块实例**（不同实例各有自己的订阅表，互不可见）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

type Handler = () => void;
type RegisterModule = typeof import('@/pwa/registerSW');

interface FakeWorker {
  state: string;
  postMessage: ReturnType<typeof vi.fn>;
  addEventListener: (type: string, handler: Handler) => void;
  emit: (type: string) => void;
}

interface FakeRegistration {
  installing: FakeWorker | null;
  waiting: FakeWorker | null;
  addEventListener: (type: string, handler: Handler) => void;
  emit: (type: string) => void;
}

interface FakeContainer {
  controller: unknown;
  register: ReturnType<typeof vi.fn>;
  addEventListener: (type: string, handler: Handler) => void;
  emit: (type: string) => void;
}

/** 记录监听并可手动派发的小工具（避免测试里出现假的 addEventListener 吞掉事件）。 */
function listenerBag(): {
  addEventListener: (type: string, handler: Handler) => void;
  emit: (type: string) => void;
} {
  const bag = new Map<string, Handler[]>();
  return {
    addEventListener(type: string, handler: Handler): void {
      const list = bag.get(type);
      if (list) {
        list.push(handler);
      } else {
        bag.set(type, [handler]);
      }
    },
    emit(type: string): void {
      for (const handler of [...(bag.get(type) ?? [])]) {
        handler();
      }
    },
  };
}

function createWorker(state = 'installing'): FakeWorker {
  return { state, postMessage: vi.fn(), ...listenerBag() };
}

function createRegistration(installing: FakeWorker | null = null): FakeRegistration {
  return { installing, waiting: null, ...listenerBag() };
}

/** 注入假的 `navigator.serviceWorker`（jsdom 没有）。 */
function installContainer(registration: FakeRegistration, hasController: boolean): FakeContainer {
  const container: FakeContainer = {
    controller: hasController ? {} : null,
    register: vi.fn().mockResolvedValue(registration),
    ...listenerBag(),
  };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container });
  return container;
}

/** 替换 `window.location.reload`（jsdom 未实现导航）。 */
function stubReload(): ReturnType<typeof vi.fn> {
  const reload = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload },
  });
  return reload;
}

/** 每个用例一份干净的模块状态。 */
async function freshModule(): Promise<RegisterModule> {
  vi.resetModules();
  return import('@/pwa/registerSW');
}

/** 让 `register()` 的 `.then()` 跑完（一轮宏任务足够）。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 完成一次真实注册流程：注入容器 → 用**同一份**模块注册 → 派发 load。 */
async function setup(
  registration: FakeRegistration,
  hasController: boolean,
): Promise<{ container: FakeContainer; module: RegisterModule }> {
  const container = installContainer(registration, hasController);
  const module = await freshModule();
  module.registerServiceWorker();
  window.dispatchEvent(new Event('load'));
  await flush();
  return { container, module };
}

describe('PWA 新版本检测（registerSW）', () => {
  it('已有控制者时新 worker 安装完成 → 通知有新版本（回调 + 自定义事件，只通知一次）', async () => {
    const worker = createWorker();
    const registration = createRegistration(worker);
    const { module } = await setup(registration, true);

    const listener = vi.fn();
    const unsubscribe = module.onServiceWorkerUpdate(listener);
    const onEvent = vi.fn();
    window.addEventListener(module.SW_UPDATE_EVENT, onEvent);

    // updatefound → 跟踪 installing → installed
    registration.emit('updatefound');
    worker.state = 'installed';
    worker.emit('statechange');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(module.hasServiceWorkerUpdate()).toBe(true);

    // 同一会话只通知一次：重复派发不应让提示条反复弹出
    worker.emit('statechange');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    window.removeEventListener(module.SW_UPDATE_EVENT, onEvent);
  });

  it('首次安装（此前无控制者）→ 不通知（那是装好了，不是有新版本）', async () => {
    const worker = createWorker();
    const registration = createRegistration(worker);
    const { module } = await setup(registration, false);

    const listener = vi.fn();
    module.onServiceWorkerUpdate(listener);

    registration.emit('updatefound');
    worker.state = 'installed';
    worker.emit('statechange');

    expect(listener).not.toHaveBeenCalled();
    expect(module.hasServiceWorkerUpdate()).toBe(false);
  });

  it('注册时已有 waiting 中的 worker + 已有控制者 → 立即通知', async () => {
    const waiting = createWorker('installed');
    const registration = createRegistration(null);
    registration.waiting = waiting;

    const container = installContainer(registration, true);
    const module = await freshModule();
    const listener = vi.fn();
    // 订阅早于注册：模拟「更新在挂载前就已就绪」
    module.onServiceWorkerUpdate(listener);

    module.registerServiceWorker();
    window.dispatchEvent(new Event('load'));
    await flush();

    expect(container.register).toHaveBeenCalledWith('/sw.js');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(module.hasServiceWorkerUpdate()).toBe(true);
  });

  it('applyServiceWorkerUpdate：有 waiting → 先 SKIP_WAITING，接管后只刷新一次', async () => {
    const waiting = createWorker('installed');
    const registration = createRegistration(null);
    registration.waiting = waiting;
    const { container, module } = await setup(registration, true);
    const reload = stubReload();

    module.applyServiceWorkerUpdate();

    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(reload).not.toHaveBeenCalled();

    container.emit('controllerchange');
    expect(reload).toHaveBeenCalledTimes(1);

    // 接管事件可能再来一次（新旧 worker 交替），页面只能刷新一次
    container.emit('controllerchange');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('applyServiceWorkerUpdate：无 waiting（autoUpdate 常态）→ 直接刷新', async () => {
    const registration = createRegistration(null);
    const { module } = await setup(registration, true);
    const reload = stubReload();

    module.applyServiceWorkerUpdate();

    expect(reload).toHaveBeenCalledTimes(1);
  });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'serviceWorker');
});
