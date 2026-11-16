/**
 * IndexedDB 不可用时的内存替代实现。
 *
 * `content://`（Android 文件管理器打开本地 HTML）和部分受限环境属于不透明来源，
 * 浏览器对它们的 IndexedDB / localStorage 访问直接抛 SecurityError。此时用一个
 * 只实现本项目用到的那部分 idb 接口的内存库顶上，界面可以正常使用，但刷新后数据丢失。
 */

type Records = Map<string, unknown>

/** 本项目所有存储都以 id 为主键（与 db.ts 的 keyPath 保持一致） */
const keyOf = (value: unknown): string => String((value as { id?: unknown }).id)

/** 游标快照：与 IndexedDB 一致，遍历期间写入不影响本次遍历。 */
class MemoryCursor {
  private index = 0

  constructor(
    private readonly entries: [string, unknown][],
    private readonly records: Records
  ) {}

  get value(): unknown {
    return this.entries[this.index]?.[1]
  }

  async continue(): Promise<MemoryCursor | null> {
    this.index += 1
    return this.index < this.entries.length ? this : null
  }

  async update(value: unknown): Promise<string> {
    const key = keyOf(value)
    this.records.set(key, value)
    return key
  }
}

class MemoryStore {
  constructor(private readonly records: Records) {}

  async get(key: string): Promise<unknown> {
    return this.records.get(key)
  }

  async getAll(): Promise<unknown[]> {
    return [...this.records.values()]
  }

  async put(value: unknown): Promise<string> {
    const key = keyOf(value)
    this.records.set(key, value)
    return key
  }

  async add(value: unknown): Promise<string> {
    return this.put(value)
  }

  async delete(key: string): Promise<boolean> {
    return this.records.delete(key)
  }

  async clear(): Promise<void> {
    this.records.clear()
  }

  async count(): Promise<number> {
    return this.records.size
  }

  /** 只支持 db.ts 里用到的 `index('fileIds').count(id)` */
  index(name: string) {
    const records = this.records
    return {
      async count(value: unknown): Promise<number> {
        let total = 0
        for (const record of records.values()) {
          const ids = (record as Record<string, unknown>)[name]
          if (Array.isArray(ids) && ids.includes(value)) {
            total += 1
          }
        }
        return total
      },
    }
  }

  async openCursor(): Promise<MemoryCursor | null> {
    const entries = [...this.records.entries()]
    return entries.length > 0 ? new MemoryCursor(entries, this.records) : null
  }
}

class MemoryTransaction {
  readonly done: Promise<void> = Promise.resolve()
  readonly store: MemoryStore

  constructor(
    private readonly stores: Map<string, MemoryStore>,
    names: readonly string[]
  ) {
    this.store = this.objectStore(names[0] ?? '')
  }

  objectStore(name: string): MemoryStore {
    const store = this.stores.get(name)
    if (!store) {
      throw new Error(`memory db: unknown store ${name}`)
    }
    return store
  }

  /** 内存操作同步完成，没有可回滚的中间状态 */
  abort(): void {}
}

/** 创建内存库，接口覆盖 db.ts 实际使用的部分，由调用方按 IndexedDB 类型收窄。 */
export const createMemoryDB = (names: readonly string[]) => {
  const stores = new Map(names.map((name) => [name, new MemoryStore(new Map())]))

  return {
    get: async (name: string, key: string) => stores.get(name)?.get(key),
    getAll: async (name: string) => (await stores.get(name)?.getAll()) ?? [],
    add: async (name: string, value: unknown) => stores.get(name)?.add(value),
    put: async (name: string, value: unknown) => stores.get(name)?.put(value),
    transaction: (target: string | readonly string[]) =>
      new MemoryTransaction(stores, Array.isArray(target) ? target : [target as string]),
  }
}
