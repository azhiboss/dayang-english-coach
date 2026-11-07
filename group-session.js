/* Finite, in-memory grouping. Recall scheduling stays in planner.js. */
const RATINGS = new Set(['known', 'vague', 'unknown']);
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));

export class GroupSession {
  constructor({ items = [], groupSize = 5, date = '' } = {}) {
    if (!Array.isArray(items)) throw new TypeError('分组学习内容须为数组');
    if (!Number.isSafeInteger(groupSize) || groupSize < 1) throw new TypeError('每组词数须为正整数');
    if (typeof date !== 'string') throw new TypeError('学习日期须为字符串');
    this.date = date;
    this.groupSize = groupSize;
    this._items = [];
    this._byKey = new Map();
    for (const item of items) {
      if (!item || typeof item !== 'object' || typeof item.key !== 'string' || !item.key.trim()) throw new TypeError('分组词条缺少有效标识');
      if (this._byKey.has(item.key)) continue;
      const value = copy(item);
      this._items.push(value);this._byKey.set(value.key, value);
    }
    this._groups = [];
    for (let index = 0; index < this._items.length; index += groupSize) this._groups.push(this._items.slice(index, index + groupSize));
    this._difficult = new Map();
    this._ratings = new Map();
    this._answered = 0;
    this._groupIndex = 0;
    this._queue = [];
    this._position = 0;
    this._phase = this._groups.length ? 'group' : 'complete';
    if (this._groups.length) this._startGroup(0);
  }

  get groupCount() { return this._groups.length; }
  get complete() { return this._phase === 'complete'; }
  get phase() { return this._phase; }
  get allKeys() { return this._items.map(item => item.key); }
  get current() {
    if (this.complete) return null;
    const entry = this._queue[this._position];
    const isChallenge = this._phase === 'challenge';
    const newCount = isChallenge ? 0 : this._groups[this._groupIndex].length;
    const isReview = entry.kind !== 'new';
    return {
      item: copy(entry.item), isReview, originRound: entry.originRound,
      isChallenge, groupIndex: this._groupIndex + 1, groupCount: this.groupCount,
      wordIndex: isReview ? null : this._position + 1, newCount,
      reviewIndex: isReview ? this._position - newCount + 1 : null,
      reviewCount: this._queue.length - newCount,
      totalInGroup: this._queue.length, positionInGroup: this._position + 1,
    };
  }
  get summary() {
    return {
      answered: this._answered, wordCount: this._items.length,
      groupCount: this.groupCount, phase: this.phase, complete: this.complete,
      remainingDifficult: this._difficult.size,
      knownCount: [...this._ratings.values()].filter(rating => rating === 'known').length,
    };
  }

  _startGroup(index) {
    this._groupIndex = index;this._phase = 'group';this._position = 0;
    // Capture the existing difficult pool before this group's new words are rated.
    // Newly difficult words only return in a later group (or the final challenge).
    const reviews = [...this._difficult].map(([key, value]) => ({
      item: this._byKey.get(key), kind: 'review', originRound: value.originRound,
    }));
    this._queue = [
      ...this._groups[index].map(item => ({ item, kind: 'new', originRound: null })),
      ...reviews,
    ];
  }
  _startChallenge() {
    this._phase = 'challenge';this._position = 0;
    // One fixed pass: a negative answer here never appends the same word again.
    this._queue = [...this._difficult].map(([key, value]) => ({
      item: this._byKey.get(key), kind: 'challenge', originRound: value.originRound,
    }));
  }
  _advancePhase() {
    if (this._phase === 'challenge') {
      this._phase = 'complete';
      return { from: 'challenge', to: 'complete', message: '🎉 终极挑战完成！今日单词学习结束' };
    }
    const from = this._groupIndex + 1;
    if (from < this.groupCount) {
      this._startGroup(this._groupIndex + 1);
      return { from, to: from + 1, message: `🎉 第${from}组完成！即将开始第${from + 1}组` };
    }
    if (this._difficult.size) {
      this._startChallenge();
      return { from, to: 'challenge', message: `🎉 第${from}组完成！即将进入终极挑战` };
    }
    this._phase = 'complete';
    return { from, to: 'complete', message: '🎉 今日分组单词学习完成！' };
  }
  answer(rating) {
    if (!RATINGS.has(rating)) throw new TypeError('请选择认识、有印象或不认识');
    if (this.complete) return { previous: null, next: null, transition: null, complete: true };
    const previous = this.current, key = previous.item.key;
    this._ratings.set(key, rating);
    if (rating === 'known') this._difficult.delete(key);
    else {
      const earlier = this._difficult.get(key);
      this._difficult.set(key, { originRound: earlier?.originRound ?? previous.groupIndex, rating });
    }
    this._answered += 1;this._position += 1;
    const transition = this._position === this._queue.length ? this._advancePhase() : null;
    return { previous, next: this.current, transition, complete: this.complete };
  }
}
