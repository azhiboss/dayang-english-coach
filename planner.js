/* Local calendar scheduling. No network, DOM, notifications, or cloud services. */
export const REVIEW_INTERVALS = Object.freeze([1, 2, 4, 7, 15, 30]);
export const DAILY_NEW_OPTIONS = Object.freeze([5, 10, 15, 20, 30]);
export const DEFAULT_DAILY_NEW = 10;
const DAY_MS = 86400000;
const SENTENCES_PER_DAY = 4;
const FORECAST_DAYS = 36600;
const SCENES = ['exhibition', 'negotiation', 'complaint'];
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));

export function dateKey(value = new Date()) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T12:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error('学习计划日期无效');
    return value;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('学习计划日期无效');
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function addDays(value, amount) {
  const date = new Date(`${dateKey(value)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
export function daysBetween(first, second) {
  return Math.round((Date.parse(`${dateKey(second)}T12:00:00Z`) - Date.parse(`${dateKey(first)}T12:00:00Z`)) / DAY_MS);
}
function weekday(date) { return new Date(`${dateKey(date)}T12:00:00Z`).getUTCDay(); }
export function reviewLimit(date) { return [0, 6].includes(weekday(date)) ? 37 : 75; }
function normalizedEnglish(value) { return String(value || '').normalize('NFKC').replace(/[’‘]/g, "'").toLowerCase().replace(/\s+/g, ' ').trim(); }
function words(value) { return String(value).match(/[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*/g) || []; }
function stableHash(value) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return (result >>> 0).toString(16);
}
function validRef(part) { return typeof part === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(part); }
function unique(values) { return [...new Set(values)]; }
function taskWord(item, module) {
  if (module.scene || item.role) return false;
  const count = words(item.en).length;
  if (!count || count > 8 || String(item.en).length > 400) return false;
  return !(count > 1 && /[.!?。！？]\s*$/.test(item.en));
}

export function buildCatalog(packs = []) {
  const candidates = [], sentenceCandidates = [], scenarios = [];
  for (const pack of packs) {
    if (!validRef(pack?.id) || !Array.isArray(pack.modules)) continue;
    for (const module of pack.modules) {
      if (!validRef(module.id) || !Array.isArray(module.items)) continue;
      const inferredScene = SCENES.includes(module.scene) ? module.scene : /展会|接待/.test(module.module) ? 'exhibition' : /价格|谈判/.test(module.module) ? 'negotiation' : /客诉|投诉/.test(module.module) ? 'complaint' : null;
      if (inferredScene && module.items.some(item => String(item.role).toLowerCase() === 'client')) scenarios.push({
        key: `${pack.id}/${module.id}`, packId: pack.id, moduleId: module.id,
        scene: inferredScene, title: module.module, en: module.module, zh: '完成一次完整情景模拟',
        rounds: module.items.filter(item => String(item.role).toLowerCase() === 'client').length,
      });
      for (const item of module.items) {
        if (!validRef(item?.id) || typeof item.en !== 'string' || !item.en.trim()) continue;
        const key = `${pack.id}/${item.id}`;
        const base = { key, packId: pack.id, itemId: item.id, moduleId: module.id, moduleName: module.module, en: item.en, zh: item.zh || '', phonetic: item.phonetic || '' };
        if (taskWord(item, module)) candidates.push({ ...base, enKey: normalizedEnglish(item.en) });
        else if (words(item.en).length >= 3 && words(item.en).length <= 60) sentenceCandidates.push({ ...base, enKey: normalizedEnglish(item.en) });
        const examples = Array.isArray(item.examples) && item.examples.length ? item.examples : typeof item.example === 'string' ? [{ en: item.example, zh: item.example_zh || '' }] : [];
        examples.forEach((example, index) => {
          if (typeof example?.en !== 'string' || words(example.en).length < 3 || words(example.en).length > 60) return;
          sentenceCandidates.push({ ...base, key: `${key}/example-${index}-${stableHash(normalizedEnglish(example.en))}`, en: example.en, zh: example.zh || '', phonetic: '', exampleIndex: index, enKey: normalizedEnglish(example.en) });
        });
      }
    }
  }
  const byEnglish = new Map(), aliases = new Map();
  const courseOrder = new Map();
  candidates.forEach((item, index) => { if (!courseOrder.has(item.enKey)) courseOrder.set(item.enKey, index); });
  // Explicit stable reference order keeps imports and pack display ordering from reshuffling the course.
  candidates.sort((a, b) => a.key.localeCompare(b.key, 'en'));
  for (const item of candidates) {
    if (!byEnglish.has(item.enKey)) byEnglish.set(item.enKey, { ...item, aliases: [] });
    const canonical = byEnglish.get(item.enKey);canonical.aliases.push(item.key);aliases.set(item.key, canonical.key);
  }
  const wordList = [...byEnglish.values()].sort((a, b) => courseOrder.get(a.enKey) - courseOrder.get(b.enKey));
  const seenSentences = new Set();
  const sentences = sentenceCandidates.filter(item => {
    if (seenSentences.has(item.enKey)) return false;
    seenSentences.add(item.enKey);return true;
  });
  scenarios.sort((a, b) => a.key.localeCompare(b.key, 'en'));
  const catalog = { words: wordList, sentences, scenarios, aliases, byEnglish,
    wordMap: new Map(wordList.map(item => [item.key, item])), sentenceMap: new Map(sentences.map(item => [item.key, item])), scenarioMap: new Map(scenarios.map(item => [item.key, item])) };
  catalog.signature = [...wordList, ...sentences, ...scenarios].map(item => item.key).join('|');
  return catalog;
}

function blankDay(date) {
  return { date, newKeys: [], reviewKeys: [], sentenceKeys: [], scenarioKey: null, doneNew: [], doneReviews: [], doneSentences: [], scenarioDone: false, seconds: 0, celebrated: false, completedAt: null };
}
export function initialState(today, instant = new Date().toISOString()) {
  return { schemaVersion: 1, startedOn: dateKey(today), dailyNew: DEFAULT_DAILY_NEW, learned: {}, days: {}, updatedAt: instant };
}
function firstFutureDue(record, today) {
  if (record.completedIntervals.length >= REVIEW_INTERVALS.length) return null;
  const nextDates = REVIEW_INTERVALS.slice(record.completedIntervals.length).map(offset => addDays(record.learnedOn, offset)).filter(date => date > today);
  // Overdue stages never turn into fictitious completed repetitions. Finish any remaining stages one per later day.
  return nextDates[0] || addDays(today, 1);
}
function learnedRecord(item, learnedOn, source = 'planner') {
  return { enKey: item.enKey, learnedOn, lastReviewedOn: null, nextDue: addDays(learnedOn, 1), completedIntervals: [], mastered: false, source };
}
function seedLegacy(state, catalog, progress, today) {
  const byKey = new Map();
  for (const record of progress || []) {
    const canonical = catalog.aliases.get(`${record.packId}/${record.itemId}`);
    if (!canonical || !['mastered', 'review'].includes(record.status) && !record.attempts) continue;
    const current = byKey.get(canonical);
    if (!current || record.status === 'mastered' || current.status !== 'mastered' && record.updatedAt > current.updatedAt) byKey.set(canonical, record);
  }
  for (const [key, previous] of byKey) {
    const item = catalog.wordMap.get(key);
    let anchor = addDays(today, -1);
    try {
      const candidate = dateKey(new Date(previous.lastPracticedAt || previous.updatedAt));
      if (candidate < today) anchor = candidate;
    } catch { /* The current planning anchor is sufficient when older date metadata is absent. */ }
    const record = learnedRecord(item, anchor, 'legacy');
    if (previous.status === 'mastered') { record.completedIntervals = [...REVIEW_INTERVALS];record.mastered = true;record.nextDue = null; }
    else record.nextDue = today;
    state.learned[key] = record;
  }
}
function reconcileLearned(state, catalog) {
  const transfers = new Map();
  for (const [key, record] of Object.entries(state.learned)) {
    const canonical = catalog.byEnglish.get(record.enKey);
    if (!canonical) continue; // Keep historical learning if a course is temporarily removed.
    const existing = transfers.get(canonical.key);
    if (!existing || record.completedIntervals.length > existing.completedIntervals.length || record.completedIntervals.length === existing.completedIntervals.length && record.learnedOn < existing.learnedOn) transfers.set(canonical.key, { ...record });
    if (key !== canonical.key) delete state.learned[key];
  }
  for (const [key, record] of transfers) state.learned[key] = record;
}
function remapWordKeys(values, state, catalog) {
  return unique(values.map(key => catalog.aliases.get(key) || key));
}
function isStudyDay(day) { return Boolean(day.doneNew.length || day.doneReviews.length || day.doneSentences.length || day.scenarioDone); }
function sceneForDate(catalog, date) {
  const index = { 2: 0, 4: 1, 6: 2 }[weekday(date)];
  if (index === undefined || !catalog.scenarios.length) return null;
  return catalog.scenarios.find(scene => scene.scene === SCENES[index]) || catalog.scenarios[index % catalog.scenarios.length];
}
function previousDays(state, today) { return Object.keys(state.days).filter(date => date < today).sort().map(date => state.days[date]); }
function ensureToday(state, catalog, today, instant) {
  reconcileLearned(state, catalog);
  const existed = own(state.days, today), day = existed ? state.days[today] : blankDay(today);
  const prior = previousDays(state, today);
  for (const field of ['newKeys', 'reviewKeys', 'doneNew', 'doneReviews']) day[field] = remapWordKeys(day[field], state, catalog);
  // Retain completed references for the check-in history even if their course was removed.
  const completedNew = day.doneNew;
  const pendingNew = unique([
    ...day.newKeys,
    ...prior.flatMap(previous => previous.newKeys.filter(key => !previous.doneNew.includes(key))).map(key => catalog.aliases.get(key) || key),
    ...catalog.words.map(item => item.key),
  ]).filter(key => catalog.wordMap.has(key) && !state.learned[key] && !completedNew.includes(key));
  day.newKeys = [...completedNew, ...pendingNew.slice(0, Math.max(0, state.dailyNew - completedNew.length))];
  const due = catalog.words.filter(item => {
    const record = state.learned[item.key];
    return record && !record.mastered && record.nextDue && record.nextDue <= today && !day.doneReviews.includes(item.key);
  }).sort((a, b) => state.learned[a.key].nextDue.localeCompare(state.learned[b.key].nextDue) || state.learned[a.key].learnedOn.localeCompare(state.learned[b.key].learnedOn) || a.key.localeCompare(b.key));
  day.reviewKeys = [...day.doneReviews, ...due.slice(0, Math.max(0, reviewLimit(today) - day.doneReviews.length)).map(item => item.key)];
  const lastSentenceDone = new Map(), lastSceneDone = new Map();
  for (const previous of prior) {
    for (const key of previous.doneSentences) lastSentenceDone.set(key, previous.date);
    if (previous.scenarioDone && previous.scenarioKey) lastSceneDone.set(previous.scenarioKey, previous.date);
  }
  const carried = unique(prior.flatMap(previous => previous.sentenceKeys.filter(key => !previous.doneSentences.includes(key) && (!lastSentenceDone.has(key) || lastSentenceDone.get(key) < previous.date)))).filter(key => catalog.sentenceMap.has(key));
  const offset = Math.max(0, daysBetween(state.startedOn, today)) * SENTENCES_PER_DAY;
  const rotated = catalog.sentences.length ? [...catalog.sentences.slice(offset % catalog.sentences.length), ...catalog.sentences.slice(0, offset % catalog.sentences.length)] : [];
  const existingSentences = existed ? day.sentenceKeys.filter(key => day.doneSentences.includes(key) || catalog.sentenceMap.has(key)) : carried;
  day.sentenceKeys = unique([...day.doneSentences, ...existingSentences, ...rotated.map(item => item.key)]).slice(0, SENTENCES_PER_DAY);
  if (!existed) {
    const oldScene = prior.find(previous => previous.scenarioKey && !previous.scenarioDone && catalog.scenarioMap.has(previous.scenarioKey) && (!lastSceneDone.has(previous.scenarioKey) || lastSceneDone.get(previous.scenarioKey) < previous.date));
    let missedScene = null;
    // Infer an unvisited scheduled scene since the last opened day, but merge it into one task.
    if (!oldScene && prior.length) {
      let date = addDays(prior[prior.length - 1].date, 1);
      for (let index = 0; date <= today && index < 7; index += 1, date = addDays(date, 1)) {
        missedScene = sceneForDate(catalog, date);
        if (missedScene) break;
      }
    }
    day.scenarioKey = oldScene?.scenarioKey || missedScene?.key || sceneForDate(catalog, today)?.key || null;
  } else {
    if (day.scenarioKey && !catalog.scenarioMap.has(day.scenarioKey) && !day.scenarioDone) day.scenarioKey = null;
  }
  state.days[today] = day;
  const complete = completionFor(day, catalog);
  if (complete.allDone && !day.completedAt) day.completedAt = instant;
  return state;
}
function completionFor(day, catalog) {
  const newKeys = day.newKeys.filter(key => catalog.wordMap.has(key));
  const reviewKeys = day.reviewKeys.filter(key => catalog.wordMap.has(key));
  const sentenceKeys = day.sentenceKeys.filter(key => catalog.sentenceMap.has(key));
  const scenario = day.scenarioKey && catalog.scenarioMap.has(day.scenarioKey) ? 1 : 0;
  const total = newKeys.length + reviewKeys.length + sentenceKeys.length + scenario;
  const done = newKeys.filter(key => day.doneNew.includes(key)).length + reviewKeys.filter(key => day.doneReviews.includes(key)).length + sentenceKeys.filter(key => day.doneSentences.includes(key)).length + (scenario && day.scenarioDone ? 1 : 0);
  return { done, total, percent: total ? Math.round(done / total * 100) : 0, allDone: total > 0 && done === total, shouldCelebrate: total > 0 && done === total && !day.celebrated };
}

class MinHeap {
  constructor(values = []) { this.values = [];for (const value of values) this.push(value); }
  less(a, b) { return a.due < b.due || a.due === b.due && a.order < b.order; }
  push(value) {
    const values = this.values;values.push(value);let index = values.length - 1;
    while (index > 0) { const parent = (index - 1) >> 1;if (!this.less(values[index], values[parent])) break;[values[index], values[parent]] = [values[parent], values[index]];index = parent; }
  }
  pop() {
    const values = this.values, first = values[0], last = values.pop();
    if (values.length) { values[0] = last;let index = 0;while (true) { let next = index, left = index * 2 + 1, right = left + 1;if (left < values.length && this.less(values[left], values[next])) next = left;if (right < values.length && this.less(values[right], values[next])) next = right;if (next === index) break;[values[index], values[next]] = [values[next], values[index]];index = next; } }
    return first;
  }
  get size() { return this.values.length; }
  peek() { return this.values[0]; }
}

export function estimateDates(state, catalog, today) {
  const total = catalog.words.length;
  if (!total) return { estimatedNewDate: null, estimatedFinishDate: null };
  const learned = catalog.words.map(item => state.learned[item.key]).filter(Boolean);
  let unlearned = total - learned.length;
  const startNumber = Math.floor(Date.parse(`${today}T12:00:00Z`) / DAY_MS);
  let lastNew = learned.length ? Math.max(...learned.map(record => Math.floor(Date.parse(`${record.learnedOn}T12:00:00Z`) / DAY_MS))) : startNumber;
  const numberToKey = number => new Date(number * DAY_MS).toISOString().slice(0, 10);
  const heap = new MinHeap();let serial = 0;
  for (const record of learned) if (!record.mastered && record.nextDue) heap.push({ learned: Math.floor(Date.parse(`${record.learnedOn}T12:00:00Z`) / DAY_MS), due: Math.floor(Date.parse(`${record.nextDue}T12:00:00Z`) / DAY_MS), count: record.completedIntervals.length, order: serial++ });
  if (!unlearned && !heap.size) {
    const finish = learned.map(record => record.lastReviewedOn || record.learnedOn).sort().at(-1) || today;
    return { estimatedNewDate: numberToKey(lastNew), estimatedFinishDate: finish };
  }
  const existingDay = state.days[today] || blankDay(today);
  for (let offset = 0; offset < FORECAST_DAYS; offset += 1) {
    const number = startNumber + offset, date = numberToKey(number);
    const allowance = Math.max(0, state.dailyNew - (offset === 0 ? existingDay.doneNew.length : 0));
    const count = Math.min(unlearned, allowance);
    for (let index = 0; index < count; index += 1) heap.push({ learned: number, due: number + 1, count: 0, order: serial++ });
    if (count) lastNew = number;
    unlearned -= count;
    const capacity = Math.max(0, reviewLimit(date) - (offset === 0 ? existingDay.doneReviews.length : 0));
    for (let done = 0; done < capacity && heap.size && heap.peek().due <= number; done += 1) {
      const record = heap.pop();record.count += 1;
      if (record.count < REVIEW_INTERVALS.length) {
        record.due = REVIEW_INTERVALS.slice(record.count).map(interval => record.learned + interval).find(due => due > number) || number + 1;
        heap.push(record);
      }
    }
    if (!unlearned && !heap.size) return { estimatedNewDate: numberToKey(lastNew), estimatedFinishDate: date };
  }
  return { estimatedNewDate: unlearned ? null : numberToKey(lastNew), estimatedFinishDate: null };
}

export class Planner {
  constructor({ db, now = () => new Date() } = {}) {
    if (!db || typeof db.updatePlanner !== 'function') throw new Error('每日计划需要本地学习数据库');
    this.db = db;this.now = now;this.catalog = buildCatalog([]);this._state = null;this._progress = [];this._estimateCache = null;
  }
  get snapshot() { return copy(this._state); }
  _instant() { const value = this.now();const date = value instanceof Date ? value : new Date(value);if (!Number.isFinite(date.getTime())) throw new Error('设备日期无效');return date; }
  async refresh(packs, progress = []) {
    this.catalog = buildCatalog(packs);this._progress = progress;
    return this._update();
  }
  async _update(change, targetDate, allowPastTime = false) {
    const now = this._instant(), today = dateKey(now), instant = now.toISOString();
    if (targetDate && dateKey(targetDate) !== today && !allowPastTime) throw new Error('日期已变化，请刷新今日任务后继续');
    this._state = await this.db.updatePlanner(current => {
      const state = current ? copy(current) : initialState(today, instant);
      if (!current) seedLegacy(state, this.catalog, this._progress, today);
      if (today < state.startedOn) return state;
      ensureToday(state, this.catalog, today, instant);
      if (change) change(state, state.days[today], today, instant);
      ensureToday(state, this.catalog, today, instant);
      state.updatedAt = instant;
      return state;
    });
    return this._view(today);
  }
  async complete(kind, key, date) {
    if (!['new', 'review', 'sentence', 'scenario'].includes(kind) || typeof key !== 'string') throw new Error('今日任务格式不正确');
    return this._update((state, day, today) => {
      const fields = { new: ['newKeys', 'doneNew'], review: ['reviewKeys', 'doneReviews'], sentence: ['sentenceKeys', 'doneSentences'] };
      if (kind === 'scenario') {
        if (day.scenarioKey !== key || !this.catalog.scenarioMap.has(key)) throw new Error('此情景不属于今日任务，请刷新后重试');
        day.scenarioDone = true;return;
      }
      const [assigned, done] = fields[kind];
      if (!day[assigned].includes(key)) throw new Error('此条目不属于今日任务，请刷新后重试');
      if (day[done].includes(key)) return;
      if (kind === 'new') {
        const item = this.catalog.wordMap.get(key);if (!item) throw new Error('对应课程已移除，请刷新今日任务');
        if (!state.learned[key]) state.learned[key] = learnedRecord(item, today);
      } else if (kind === 'review') {
        const record = state.learned[key];
        if (!record || !this.catalog.wordMap.has(key)) throw new Error('复习记录已变化，请刷新今日任务');
        if (record.lastReviewedOn === today) return;
        const next = REVIEW_INTERVALS[record.completedIntervals.length];
        if (next !== undefined) record.completedIntervals.push(next);
        record.lastReviewedOn = today;record.mastered = record.completedIntervals.length === REVIEW_INTERVALS.length;record.nextDue = firstFutureDue(record, today);
      } else if (!this.catalog.sentenceMap.has(key)) throw new Error('对应例句已变化，请刷新今日任务');
      day[done].push(key);
    }, date);
  }
  async setDailyNew(amount) {
    if (!DAILY_NEW_OPTIONS.includes(Number(amount))) throw new Error('每天新词量可选5、10、15、20或30个');
    return this._update(state => { state.dailyNew = Number(amount); });
  }
  async recordTime(seconds, date) {
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 300) throw new Error('学习时长须为0—300秒的整数增量');
    const now = this._instant(), today = dateKey(now), key = date ? dateKey(date) : today;
    if (key > today) throw new Error('不能向未来日期记录学习时长');
    return this._update(state => {
      const day = state.days[key];
      if (day) day.seconds = Math.min(86400, day.seconds + seconds);
    }, key, true);
  }
  async acknowledgeCelebration(date) {
    return this._update((state, day) => { if (completionFor(day, this.catalog).allDone) day.celebrated = true; }, date);
  }
  async reset() {
    const now = this._instant(), today = dateKey(now), instant = now.toISOString();
    this._state = await this.db.updatePlanner(current => {
      const fresh = initialState(today, instant);
      if (DAILY_NEW_OPTIONS.includes(current?.dailyNew)) fresh.dailyNew = current.dailyNew;
      return ensureToday(fresh, this.catalog, today, instant);
    });
    this._estimateCache = null;
    return this._view(today);
  }
  _view(today) {
    const state = this._state, day = state.days[today] || blankDay(today), catalog = this.catalog;
    const clockBack = today < state.startedOn;
    const tasks = { newWords: day.newKeys.filter(key => catalog.wordMap.has(key)).map(key => ({ ...catalog.wordMap.get(key), done: day.doneNew.includes(key) })),
      reviews: day.reviewKeys.filter(key => catalog.wordMap.has(key)).map(key => ({ ...catalog.wordMap.get(key), done: day.doneReviews.includes(key), dueOn: state.learned[key]?.nextDue, repetition: Math.min(6, (state.learned[key]?.completedIntervals.length || 0) + (day.doneReviews.includes(key) ? 0 : 1)) })),
      sentences: day.sentenceKeys.filter(key => catalog.sentenceMap.has(key)).map(key => ({ ...catalog.sentenceMap.get(key), done: day.doneSentences.includes(key) })),
      scenario: day.scenarioKey && catalog.scenarioMap.has(day.scenarioKey) ? { ...catalog.scenarioMap.get(day.scenarioKey), done: day.scenarioDone } : null };
    const studyDates = Object.keys(state.days).filter(date => date <= today && isStudyDay(state.days[date])).sort();
    const studySet = new Set(studyDates);let streak = 0, cursor = studySet.has(today) ? today : addDays(today, -1);
    while (studySet.has(cursor)) { streak += 1;cursor = addDays(cursor, -1); }
    const weekStart = addDays(today, -((weekday(today) + 6) % 7));
    const weekSeconds = Object.entries(state.days).filter(([date]) => date >= weekStart && date <= today).reduce((sum, [, record]) => sum + record.seconds, 0);
    const records = catalog.words.map(item => state.learned[item.key]).filter(Boolean);
    const estimateKey = `${today}|${state.dailyNew}|${catalog.signature}|${day.doneNew.length}|${day.doneReviews.length}|${records.map(record => `${record.enKey}:${record.learnedOn}:${record.nextDue}:${record.completedIntervals.length}:${record.mastered}`).join('|')}`;
    if (!this._estimateCache || this._estimateCache.key !== estimateKey) this._estimateCache = { key: estimateKey, value: estimateDates(state, catalog, today) };
    const totalDue = records.filter(record => !record.mastered && record.nextDue && record.nextDue <= today).length;
    const pendingReviews = tasks.reviews.filter(task => !task.done).length;
    let nextScenarioDate = null;
    if (!tasks.scenario && catalog.scenarios.length) for (let offset = 1; offset <= 7; offset += 1) if (sceneForDate(catalog, addDays(today, offset))) { nextScenarioDate = addDays(today, offset);break; }
    return { date: today, startedOn: state.startedOn, dailyNew: state.dailyNew, weekend: [0, 6].includes(weekday(today)), day: copy(day), tasks,
      remaining: { newWords: tasks.newWords.filter(task => !task.done).length, reviews: pendingReviews, sentences: tasks.sentences.filter(task => !task.done).length, scenario: tasks.scenario && !tasks.scenario.done ? 1 : 0 },
      stats: { streak, studyDays: studyDates.length, mastered: records.filter(record => record.mastered).length, totalVocabulary: catalog.words.length, learned: records.length, weekSeconds, ...this._estimateCache.value },
      completion: completionFor(day, catalog), review: { limit: reviewLimit(today), totalDue, deferred: Math.max(0, totalDue - pendingReviews) }, nextScenarioDate,
      notice: clockBack ? '设备日期早于计划起始日，已暂停计划写入。请先校准设备日期；已有记录保留。' : '', clockBack,
    };
  }
}
