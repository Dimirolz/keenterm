class LRUMap<K, V> {
  private readonly limit: number
  private readonly map = new Map<K, V>()

  constructor(limit = 0) {
    this.limit = limit
  }

  get size() {
    return this.map.size
  }

  get(key: K) {
    const value = this.map.get(key)
    if (value !== undefined || this.map.has(key)) {
      this.map.delete(key)
      this.map.set(key, value as V)
    }
    return value
  }

  set(key: K, value: V) {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    if (this.limit > 0 && this.map.size > this.limit) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    return this
  }

  has(key: K) {
    return this.map.has(key)
  }

  delete(key: K) {
    const value = this.map.get(key)
    this.map.delete(key)
    return value
  }

  clear() {
    this.map.clear()
  }
}

export { LRUMap }
export default { LRUMap }
