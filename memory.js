/* Three-level recall. Pure local calendar functions; no storage or UI access. */
export const MEMORY_WEEKDAYS = Object.freeze({ known: Object.freeze([1, 4]), vague: Object.freeze([1, 2, 4, 6]), unknown: Object.freeze([1, 2, 3, 4, 5, 6]) });
const RATINGS = ['unknown', 'vague', 'known'];
const severity = { known: 0, vague: 1, unknown: 2 };
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('记忆日期无效');
  const parsed = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error('记忆日期无效');
  return value;
}
function add(value, offset) { const d = new Date(`${date(value)}T12:00:00Z`);d.setUTCDate(d.getUTCDate() + offset);return d.toISOString().slice(0, 10); }
function weekday(value) { return new Date(`${date(value)}T12:00:00Z`).getUTCDay(); }
function unbox(record) { return record?.memory || record; }

function upcoming(memory, today) {
  if (['unknown', 'vague'].includes(memory.currentStatus)) return Array.from({ length: 14 }, (_, i) => add(today, i));
  if (memory.currentStatus === 'known') return [add(today, 1), add(today, 2)];
  const days = MEMORY_WEEKDAYS[memory.masteredFrom];
  return Array.from({ length: 14 }, (_, i) => add(today, i + 1)).filter(key => days.includes(weekday(key)));
}

export function applyMemoryRating(previous, rating, today, wordId) {
  date(today);
  if (!RATINGS.includes(rating) || typeof wordId !== 'string' || !wordId) throw new Error('记忆评级无效');
  const prior = unbox(previous);
  if (prior?.lastReviewDate > today) throw new Error('设备日期早于最近学习记录，请校准日期后继续');
  const memory = prior ? copy(prior) : { wordId, currentStatus: 'known', consecutiveKnownCount: 0, lastReviewDate: today, nextReviewDates: [], reviewHistory: [], masteredFrom: 'known', weeklyReviewCount: 0 };
  memory.wordId = wordId;
  if (rating === 'known') {
    if (prior?.currentStatus === 'mastered') {
      // Mastered words intentionally have gaps between scheduled review days.
      memory.currentStatus = 'mastered';memory.consecutiveKnownCount = 3;
    } else {
      const sameDay = prior?.lastReviewDate === today && prior.currentStatus === 'known';
      const yesterday = prior?.lastReviewDate === add(today, -1) && prior.currentStatus === 'known';
      memory.consecutiveKnownCount = sameDay ? prior.consecutiveKnownCount : yesterday ? Math.min(3, prior.consecutiveKnownCount + 1) : 1;
      memory.currentStatus = memory.consecutiveKnownCount === 3 ? 'mastered' : 'known';
    }
    memory.weeklyReviewCount = memory.currentStatus === 'mastered' ? MEMORY_WEEKDAYS[memory.masteredFrom].length : 0;
  } else {
    memory.currentStatus = rating;memory.consecutiveKnownCount = 0;memory.weeklyReviewCount = 0;
    // Preserve the hardest source during this cycle, including a later lapse.
    if (severity[rating] > severity[memory.masteredFrom]) memory.masteredFrom = rating;
  }
  memory.lastReviewDate = today;
  const last = memory.reviewHistory.at(-1);
  if (!last || last.date !== today || last.status !== rating) memory.reviewHistory.push({ date: today, status: rating });
  if (memory.reviewHistory.length > 10000) memory.reviewHistory = memory.reviewHistory.slice(-10000);
  memory.nextReviewDates = upcoming(memory, today);
  return memory;
}

export function migrateMemory(wordId, today) {
  return applyMemoryRating(null, 'known', date(today), wordId);
}

export function memoryDue(record, today) {
  date(today);const memory = unbox(record);
  if (!memory || !['unknown', 'vague', 'known', 'mastered'].includes(memory.currentStatus) || memory.lastReviewDate > today) return false;
  if (['unknown', 'vague'].includes(memory.currentStatus)) return true;
  if (memory.lastReviewDate === today) return false;
  if (memory.currentStatus === 'known') return true;
  return memory.nextReviewDates.some(key => key <= today);
}

export function memoryPriority(record) {
  return ({ unknown: 0, vague: 1, known: 2, mastered: 3 })[unbox(record)?.currentStatus] ?? 4;
}

export function memoryStats(records, today, dailyNew = 10, total = records.length) {
  date(today);
  const values = records.map(unbox).filter(memory => memory && ['unknown', 'vague', 'known', 'mastered'].includes(memory.currentStatus));
  const counts = { unknown: 0, vague: 0, known: 0, mastered: 0 };
  for (const memory of values) counts[memory.currentStatus] += 1;
  const remainingNew = Math.max(0, total - values.length);
  const remainingObservation = values.filter(m => m.currentStatus !== 'mastered').map(m => m.currentStatus === 'known' && m.lastReviewDate === today ? 3 - m.consecutiveKnownCount : 2);
  return { ...counts, weekCompleted: 0, weekScheduled: 0, weekPercent: 0,
    estimatedMasteryDays: !total ? null : Math.max(remainingNew ? Math.ceil(remainingNew / Math.max(1, dailyNew)) + 1 : 0, ...remainingObservation, 0) };
}
