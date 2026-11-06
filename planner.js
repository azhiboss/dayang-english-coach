/* Local calendar scheduling. No network, DOM, notifications, or cloud services. */
import { applyMemoryRating, migrateMemory, memoryDue, memoryPriority, memoryStats } from './memory.js';
export const REVIEW_INTERVALS = Object.freeze([1, 2, 4, 7, 15, 30]);
export const DAILY_NEW_OPTIONS = Object.freeze([5, 10, 15, 20, 30]);
export const DEFAULT_DAILY_NEW = 10;
const DAY_MS = 86400000;
const SENTENCES_PER_DAY = 4;
const FORECAST_DAYS = 5000;
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
export function reviewLimit(date) { dateKey(date);return 30; }
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
  return { date, newKeys: [], reviewKeys: [], sentenceKeys: [], scenarioKey: null, doneNew: [], doneReviews: [], doneSentences: [], scenarioDone: false, seconds: 0, celebrated: false, completedAt: null, memoryRatedKeys: [] };
}
export function initialState(today, instant = new Date().toISOString()) {
  return { schemaVersion: 1, memoryVersion: 1, startedOn: dateKey(today), dailyNew: DEFAULT_DAILY_NEW, learned: {}, days: {}, updatedAt: instant };
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
    if (state.learned[key]) continue;
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
function migrateMemories(state, catalog, progress, today) {
  if (state.memoryVersion !== 1) seedLegacy(state, catalog, progress, today);
  for (const [key, record] of Object.entries(state.learned)) {
    if (!record.memory) {
      record.memory = migrateMemory(key, today);
      record.mastered = false;record.nextDue = record.memory.nextReviewDates[0];
    }
  }
  state.memoryVersion = 1;
}
function reconcileLearned(state, catalog) {
  const transfers = new Map();
  for (const [key, record] of Object.entries(state.learned)) {
    const canonical = catalog.byEnglish.get(record.enKey);
    if (!canonical) continue; // Keep historical learning if a course is temporarily removed.
    const existing = transfers.get(canonical.key);
    const newerMemory = record.memory && (!existing?.memory || record.memory.lastReviewDate > existing.memory.lastReviewDate);
    if (!existing || newerMemory || !record.memory && !existing.memory && (record.completedIntervals.length > existing.completedIntervals.length || record.completedIntervals.length === existing.completedIntervals.length && record.learnedOn < existing.learnedOn)) transfers.set(canonical.key, { ...record, ...(record.memory ? { memory: { ...record.memory, wordId: canonical.key } } : {}) });
    if (key !== canonical.key) delete state.learned[key];
  }
  for (const [key, record] of transfers) state.learned[key] = record;
}
function remapWordKeys(values, state, catalog) {
  return unique(values.map(key => catalog.aliases.get(key) || key));
}
function isStudyDay(day) { return Boolean(day.doneNew.length || day.doneReviews.length || day.doneSentences.length || day.scenarioDone || day.memoryRatedKeys?.length); }
function sceneForDate(catalog, date) {
  const index = { 2: 0, 4: 1, 6: 2 }[weekday(date)];
  if (index === undefined || !catalog.scenarios.length) return null;
  return catalog.scenarios.find(scene => scene.scene === SCENES[index]) || catalog.scenarios[index % catalog.scenarios.length];
}
function previousDays(state, today) { return Object.keys(state.days).filter(date => date < today).sort().map(date => state.days[date]); }
// Finish an active observation cohort before admitting interrupted observations.
// Within "known", a second consecutive day takes precedence over a first day.
// This prevents an overdue cohort from repeatedly breaking another cohort's streak.
function observationRank(status, count, lastDate, yesterday) {
  return status === 'known' && lastDate === yesterday ? 3 - count : 3;
}
function ensureToday(state, catalog, today, instant) {
  reconcileLearned(state, catalog);
  const existed = own(state.days, today), day = existed ? state.days[today] : blankDay(today);
  day.memoryRatedKeys = remapWordKeys(day.memoryRatedKeys || [], state, catalog);
  const prior = previousDays(state, today);
  for (const field of ['newKeys', 'reviewKeys', 'doneNew', 'doneReviews']) day[field] = remapWordKeys(day[field], state, catalog);
  // Retain completed references for the check-in history even if their course was removed.
  const completedNew = day.doneNew;
  const lockedNew = unique([...completedNew, ...day.newKeys.filter(key => state.learned[key]?.learnedOn === today)]).filter(key => catalog.wordMap.has(key) || completedNew.includes(key));
  const pendingNew = unique([
    ...day.newKeys,
    ...prior.flatMap(previous => previous.newKeys.filter(key => !previous.doneNew.includes(key))).map(key => catalog.aliases.get(key) || key),
    ...catalog.words.map(item => item.key),
  ]).filter(key => catalog.wordMap.has(key) && !state.learned[key] && !completedNew.includes(key));
  day.newKeys = [...lockedNew, ...pendingNew.filter(key => !lockedNew.includes(key)).slice(0, Math.max(0, state.dailyNew - lockedNew.length))];
  const yesterday = addDays(today, -1);
  const due = catalog.words.filter(item => {
    const record = state.learned[item.key];
    return record?.memory && memoryDue(record, today) && !day.newKeys.includes(item.key) && !day.doneReviews.includes(item.key);
  }).sort((a, b) => {
    const left = state.learned[a.key], right = state.learned[b.key];
    return memoryPriority(left) - memoryPriority(right)
      || observationRank(left.memory.currentStatus, left.memory.consecutiveKnownCount, left.memory.lastReviewDate, yesterday) - observationRank(right.memory.currentStatus, right.memory.consecutiveKnownCount, right.memory.lastReviewDate, yesterday)
      || left.nextDue.localeCompare(right.nextDue) || left.learnedOn.localeCompare(right.learnedOn) || a.key.localeCompare(b.key);
  });
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

// Optimistic forecast of first mastery, not the end of lifelong maintenance.
// Mastered maintenance has lower priority than all acquisition/observation tasks.
export function estimateDates(state, catalog, today) {
  if (!catalog.words.length) return { estimatedNewDate: null, estimatedFinishDate: null };
  const records = catalog.words.map(item => state.learned[item.key]).filter(Boolean);
  let unlearned = catalog.words.length - records.length;
  let lastNew = records.map(record => record.learnedOn).sort().at(-1) || today;
  let serial = 0;
  const pending = records.filter(record => record.memory?.currentStatus !== 'mastered').map(record => ({
    status: record.memory?.currentStatus || 'known', count: record.memory?.consecutiveKnownCount || 0,
    last: record.memory?.lastReviewDate || addDays(today, -1),
    due: record.nextDue || today, learned: record.learnedOn, order: serial++,
  }));
  if (!pending.length && !unlearned) return { estimatedNewDate: lastNew, estimatedFinishDate: today };
  const todayLearned = records.filter(record => record.learnedOn === today).length;
  for (let offset = 0; offset < FORECAST_DAYS; offset += 1) {
    const date = addDays(today, offset), yesterday = addDays(date, -1);
    const fresh = Math.min(unlearned, Math.max(0, state.dailyNew - (offset === 0 ? todayLearned : 0)));
    for (let index = 0; index < fresh; index += 1) pending.push({ status: 'known', count: 1, last: date, due: addDays(date, 1), learned: date, order: serial++ });
    if (fresh) lastNew = date;
    unlearned -= fresh;
    const due = pending.filter(record => record.status !== 'mastered' && record.due <= date && !(record.status === 'known' && record.last === date))
      .sort((a, b) => memoryPriority({ currentStatus: a.status }) - memoryPriority({ currentStatus: b.status })
        || observationRank(a.status, a.count, a.last, yesterday) - observationRank(b.status, b.count, b.last, yesterday)
        || a.due.localeCompare(b.due) || a.learned.localeCompare(b.learned) || a.order - b.order);
    const already = offset === 0 ? state.days[today]?.doneReviews.length || 0 : 0;
    for (const record of due.slice(0, Math.max(0, reviewLimit(date) - already))) {
      record.count = record.status === 'known' && record.last === yesterday ? record.count + 1 : 1;
      record.status = record.count >= 3 ? 'mastered' : 'known';record.last = date;record.due = addDays(date, 1);
    }
    if (!unlearned && pending.every(record => record.status === 'mastered')) return { estimatedNewDate: lastNew, estimatedFinishDate: date };
  }
  return { estimatedNewDate: unlearned ? null : lastNew, estimatedFinishDate: null };
}

export class Planner {
  constructor({ db, now = () => new Date() } = {}) {
    if (!db || typeof db.updatePlanner !== 'function') throw new Error('每日计划需要本地学习数据库');
    this.db = db;this.now = now;this.catalog = buildCatalog([]);this._state = null;this._progress = [];this._estimateCache = null;
  }
  get snapshot() { return copy(this._state); }
  memoryFor(key) {
    const canonical = this.catalog.aliases.get(key) || key;
    return copy(this._state?.learned[canonical]?.memory || null);
  }
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
      reconcileLearned(state, this.catalog);
      migrateMemories(state, this.catalog, this._progress, today);
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
      if (kind === 'new' || kind === 'review') this._rateInState(state, day, key, 'known', today);
      else {
        if (!this.catalog.sentenceMap.has(key)) throw new Error('对应例句已变化，请刷新今日任务');
        day[done].push(key);
      }
    }, date);
  }
  _rateInState(state, day, key, rating, today) {
    const canonical = this.catalog.aliases.get(key) || key;
    const item = this.catalog.wordMap.get(canonical);
    if (!item) throw new Error('该条目不是当前课程中的词汇或词组');
    const record = state.learned[canonical] || learnedRecord(item, today);
    const lastKnown = record.memory?.reviewHistory.filter(event => event.status === 'known').at(-1)?.date;
    record.memory = applyMemoryRating(record.memory, rating, today, canonical);
    if (rating === 'known' && lastKnown !== today && record.learnedOn < today) {
      const next = REVIEW_INTERVALS[record.completedIntervals.length];
      if (next !== undefined) record.completedIntervals.push(next);
    }
    record.lastReviewedOn = today;record.mastered = record.memory.currentStatus === 'mastered';
    record.nextDue = record.memory.nextReviewDates[0];state.learned[canonical] = record;
    day.memoryRatedKeys ||= [];
    if (!day.memoryRatedKeys.includes(canonical)) day.memoryRatedKeys.push(canonical);
    for (const [assigned, done] of [['newKeys', 'doneNew'], ['reviewKeys', 'doneReviews']]) {
      if (rating !== 'known') day[done] = day[done].filter(ref => ref !== canonical);
      else if (day[assigned].includes(canonical) && !day[done].includes(canonical)) day[done].push(canonical);
    }
  }
  async rateWord(key, rating, date) {
    if (!['unknown', 'vague', 'known'].includes(rating)) throw new Error('请选择不认识、有印象或认识');
    return this._update((state, day, today) => this._rateInState(state, day, key, rating, today), date);
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
    const tasks = { newWords: day.newKeys.filter(key => catalog.wordMap.has(key)).map(key => ({ ...catalog.wordMap.get(key), done: day.doneNew.includes(key), memory: copy(state.learned[key]?.memory || null) })),
      reviews: day.reviewKeys.filter(key => catalog.wordMap.has(key)).map(key => ({ ...catalog.wordMap.get(key), done: day.doneReviews.includes(key), dueOn: state.learned[key]?.nextDue, memory: copy(state.learned[key]?.memory || null), repetition: Math.min(3, (state.learned[key]?.memory?.consecutiveKnownCount || 0) + (day.doneReviews.includes(key) ? 0 : 1)) })),
      sentences: day.sentenceKeys.filter(key => catalog.sentenceMap.has(key)).map(key => ({ ...catalog.sentenceMap.get(key), done: day.doneSentences.includes(key) })),
      scenario: day.scenarioKey && catalog.scenarioMap.has(day.scenarioKey) ? { ...catalog.scenarioMap.get(day.scenarioKey), done: day.scenarioDone } : null };
    const studyDates = Object.keys(state.days).filter(date => date <= today && isStudyDay(state.days[date])).sort();
    const studySet = new Set(studyDates);let streak = 0, cursor = studySet.has(today) ? today : addDays(today, -1);
    while (studySet.has(cursor)) { streak += 1;cursor = addDays(cursor, -1); }
    const weekStart = addDays(today, -((weekday(today) + 6) % 7));
    const weekSeconds = Object.entries(state.days).filter(([date]) => date >= weekStart && date <= today).reduce((sum, [, record]) => sum + record.seconds, 0);
    const records = catalog.words.map(item => state.learned[item.key]).filter(Boolean);
    const estimateKey = `${today}|${state.dailyNew}|${catalog.signature}|${day.doneNew.length}|${day.doneReviews.length}|${records.map(record => `${record.enKey}:${record.learnedOn}:${record.nextDue}:${record.memory?.currentStatus}:${record.memory?.consecutiveKnownCount}:${record.memory?.lastReviewDate}`).join('|')}`;
    if (!this._estimateCache || this._estimateCache.key !== estimateKey) this._estimateCache = { key: estimateKey, value: estimateDates(state, catalog, today) };
    const totalDue = catalog.words.filter(item => !day.newKeys.includes(item.key) && memoryDue(state.learned[item.key], today)).length;
    const pendingReviews = tasks.reviews.filter(task => !task.done).length;
    const memories = memoryStats(records, today, state.dailyNew, catalog.words.length);
    const weekDays = Object.entries(state.days).filter(([date]) => date >= weekStart && date <= today).map(([, value]) => value);
    memories.weekScheduled = weekDays.reduce((sum, value) => sum + value.reviewKeys.filter(key => catalog.wordMap.has(key)).length, 0);
    memories.weekCompleted = weekDays.reduce((sum, value) => sum + value.doneReviews.filter(key => catalog.wordMap.has(key)).length, 0);
    memories.weekPercent = memories.weekScheduled ? Math.round(memories.weekCompleted / memories.weekScheduled * 100) : 0;
    memories.estimatedMasteryDays = this._estimateCache.value.estimatedFinishDate ? Math.max(0, daysBetween(today, this._estimateCache.value.estimatedFinishDate)) : null;
    let nextScenarioDate = null;
    if (!tasks.scenario && catalog.scenarios.length) for (let offset = 1; offset <= 7; offset += 1) if (sceneForDate(catalog, addDays(today, offset))) { nextScenarioDate = addDays(today, offset);break; }
    return { date: today, startedOn: state.startedOn, dailyNew: state.dailyNew, weekend: [0, 6].includes(weekday(today)), day: copy(day), tasks,
      remaining: { newWords: tasks.newWords.filter(task => !task.done).length, reviews: pendingReviews, sentences: tasks.sentences.filter(task => !task.done).length, scenario: tasks.scenario && !tasks.scenario.done ? 1 : 0 },
      stats: { streak, studyDays: studyDates.length, mastered: memories.mastered, totalVocabulary: catalog.words.length, learned: records.length, weekSeconds, memory: memories, ...this._estimateCache.value },
      completion: completionFor(day, catalog), review: { limit: reviewLimit(today), totalDue, deferred: Math.max(0, totalDue - pendingReviews) }, nextScenarioDate,
      notice: clockBack ? '设备日期早于计划起始日，已暂停计划写入。请先校准设备日期；已有记录保留。' : '', clockBack,
    };
  }
}
