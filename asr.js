/**
 * Explicitly user-started system/browser speech recognition. The browser may
 * use its own network recognition service; this is not guaranteed offline.
 * This module does not upload audio or call any external application API.
 *
 * https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition
 * https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
 * https://webkit.org/blog/11648/new-webkit-features-in-safari-14-1/
 */

const START_TIMEOUT_MS = 12000;
const STOP_TIMEOUT_MS = 2500;
const SESSION_LIMIT_MS = 60000;
const MAX_COMPARE_WORDS = 300;
const MAX_COMPARE_CHARACTERS = 20000;

function callSafely(callback, ...args) {
  if (typeof callback !== 'function') return;
  try {
    callback(...args);
  } catch {
    // UI callback failures must not retain a microphone or duplicate onEnd.
  }
}

function recognitionConstructor() {
  return globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null;
}

function releaseStream(stream) {
  for (const track of stream?.getTracks?.() || []) {
    try {
      track.stop();
    } catch {
      // Continue releasing other tracks if one native track has already closed.
    }
  }
}

function errorDetails(error) {
  const suppliedCode = typeof error === 'string' ? error : error?.error || error?.name;
  const aliases = {
    NotAllowedError: 'not-allowed',
    PermissionDeniedError: 'not-allowed',
    SecurityError: 'not-allowed',
    NotFoundError: 'audio-capture',
    DevicesNotFoundError: 'audio-capture',
    NotReadableError: 'audio-capture',
    TrackStartError: 'audio-capture',
    AbortError: 'aborted',
    InvalidStateError: 'start-failed',
  };
  const code = aliases[suppliedCode] || suppliedCode || 'unknown';
  const messages = {
    'not-allowed': '麦克风或语音识别权限未获允许。请检查浏览器权限，也可直接输入文字练习。',
    'service-not-allowed': '系统语音识别服务不可用。iPhone可检查Siri与听写设置，也可改用文字输入。',
    network: '系统语音识别连接失败，请检查网络后手动重试，或直接输入文字。',
    'no-speech': '没有识别到语音，请靠近麦克风后再次点击开始，也可直接输入文字。',
    'audio-capture': '暂时无法使用麦克风，请检查设备和权限，或结束其他录音后重试。',
    aborted: '本次语音识别已取消，可以再次点击开始或输入文字。',
    'language-not-supported': '系统暂不支持英语识别，请检查系统语言与听写设置，或输入文字。',
    'bad-grammar': '系统无法处理本次识别设置，请再次点击开始或输入文字。',
    'start-failed': '语音识别暂未就绪，请结束当前音频操作后再次点击开始。',
    'start-timeout': '系统语音识别未能及时启动，请手动重试；仍无响应时可使用文字输入。',
    unsupported: '当前浏览器不支持此语音输入方式，请使用文字输入，或在支持的浏览器中打开。',
    'insecure-context': '语音输入需要HTTPS或本机localhost环境；普通HTTP局域网地址请使用文字输入。',
    'user-gesture-required': '请直接点击开始按钮后使用麦克风，也可直接输入文字。',
  };
  return {
    code,
    message: messages[code] || '系统语音识别暂不可用，请手动重试或直接输入文字。',
  };
}

export class SpeechInput {
  constructor() {
    this.supported = Boolean(
      typeof recognitionConstructor() === 'function' &&
        typeof globalThis.navigator?.mediaDevices?.getUserMedia === 'function' &&
        globalThis.isSecureContext !== false,
    );
    this._generation = 0;
    this._session = null;
  }

  /** Includes the permission-prompt and startup stages, not only live capture. */
  get active() {
    return Boolean(this._session && !this._session.ended);
  }

  _isCurrent(session) {
    return Boolean(
      session &&
        !session.ended &&
        this._session === session &&
        this._generation === session.generation,
    );
  }

  _status(session, message) {
    if (this._isCurrent(session)) callSafely(session.callbacks.onStatus, message);
  }

  _finish(session, abortNative = false) {
    if (!session || session.ended) return;
    session.ended = true;
    clearTimeout(session.startTimer);
    clearTimeout(session.stopTimer);
    clearTimeout(session.limitTimer);
    const recognition = session.recognition;
    if (recognition) {
      recognition.onstart = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
    }
    if (this._session === session) this._session = null;
    if (abortNative && recognition) {
      try {
        recognition.abort();
      } catch {
        // The browser may already have ended its native session.
      }
    }
    callSafely(session.callbacks.onEnd);
  }

  _fail(session, error) {
    if (!this._isCurrent(session)) return;
    const { message, code } = errorDetails(error);
    callSafely(session.callbacks.onError, message, code);
    this._finish(session, true);
  }

  /**
   * Call directly after a user click. true means recognition.start() was invoked
   * successfully; onstart/onError/onEnd report the native session's actual state.
   */
  async start({ onResult, onStatus, onError, onEnd } = {}) {
    if (this.active) {
      callSafely(onStatus, '当前语音输入尚未结束，请先结束或取消本次识别。');
      return false;
    }
    const session = {
      generation: ++this._generation,
      callbacks: { onResult, onStatus, onError, onEnd },
      ended: false,
      stopRequested: false,
      requestedStart: false,
      recognition: null,
      transcript: '',
      startTimer: null,
      stopTimer: null,
      limitTimer: null,
    };
    this._session = session;

    if (globalThis.isSecureContext === false) {
      this._fail(session, 'insecure-context');
      return false;
    }
    const Recognition = recognitionConstructor();
    const mediaDevices = globalThis.navigator?.mediaDevices;
    if (typeof Recognition !== 'function' || typeof mediaDevices?.getUserMedia !== 'function') {
      this._fail(session, 'unsupported');
      return false;
    }
    if (globalThis.navigator?.userActivation?.isActive === false) {
      this._fail(session, 'user-gesture-required');
      return false;
    }

    this._status(session, '正在准备麦克风，请按浏览器提示授权；也可以取消并输入文字。');
    if (!this._isCurrent(session)) return false;
    let stream;
    try {
      stream = await mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (this._isCurrent(session)) this._fail(session, error);
      return false;
    } finally {
      // This stream is used only to obtain permission. Recognition opens its
      // own capture; keeping both active causes problems on some iOS versions.
      releaseStream(stream);
    }

    // A late permission approval must never resurrect a canceled session.
    if (!this._isCurrent(session) || session.stopRequested) return false;

    try {
      const recognition = new Recognition();
      session.recognition = recognition;
      recognition.lang = 'en-US';
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        if (!this._isCurrent(session)) return;
        clearTimeout(session.startTimer);
        if (session.stopRequested) return;
        session.limitTimer = setTimeout(() => {
          if (this._isCurrent(session)) this.stop();
        }, SESSION_LIMIT_MS);
        this._status(session, '正在聆听英语；结束后可检查或编辑识别文字。');
      };
      recognition.onresult = (event) => {
        if (!this._isCurrent(session)) return;
        const parts = [];
        let isFinal = true;
        for (let index = 0; index < event.results.length; index += 1) {
          const result = event.results[index];
          const text = String(result[0]?.transcript || '').trim();
          if (text) parts.push(text);
          if (!result.isFinal) isFinal = false;
        }
        const text = parts.join(' ').trim();
        if (!text) return;
        session.transcript = text;
        callSafely(session.callbacks.onResult, text, { isFinal });
      };
      recognition.onerror = (event) => {
        if (!this._isCurrent(session)) return;
        if (event.error === 'aborted' && session.stopRequested) {
          this._status(session, '本次语音输入已结束，已识别的文字可以继续编辑。');
          this._finish(session);
          return;
        }
        this._fail(session, event.error || 'unknown');
      };
      recognition.onend = () => {
        if (!this._isCurrent(session)) return;
        this._status(
          session,
          session.transcript
            ? '本次识别已结束，请检查识别文字后再比较。'
            : '本次识别已结束，未获得文字；可再次点击开始或直接输入。',
        );
        this._finish(session);
      };

      session.startTimer = setTimeout(() => {
        if (this._isCurrent(session)) this._fail(session, 'start-timeout');
      }, START_TIMEOUT_MS);
      session.requestedStart = true;
      recognition.start();
      return this._isCurrent(session);
    } catch (error) {
      this._fail(session, error);
      return false;
    }
  }

  /** Requests final results. Existing and late final text remains available. */
  stop() {
    const session = this._session;
    if (!this._isCurrent(session) || session.stopRequested) return;
    session.stopRequested = true;
    if (!session.recognition || !session.requestedStart) {
      this._generation += 1;
      callSafely(session.callbacks.onStatus, '已取消本次启动，可以直接输入文字。');
      this._finish(session);
      return;
    }
    clearTimeout(session.startTimer);
    clearTimeout(session.limitTimer);
    this._status(session, '正在结束识别并保留已识别的文字。');
    session.stopTimer = setTimeout(() => {
      if (!this._isCurrent(session)) return;
      this._status(session, '本次语音输入已结束，已识别的文字可以继续编辑。');
      this._finish(session, true);
    }, STOP_TIMEOUT_MS);
    try {
      session.recognition.stop();
    } catch {
      this._finish(session, true);
    }
  }

  /** Cancels capture and invalidates unresolved microphone-permission requests. */
  abort() {
    const session = this._session;
    this._generation += 1;
    if (!session || session.ended) return;
    this._finish(session, true);
    // Mark the session ended before notifying UI code, which may itself abort.
    // If onEnd started another session, do not overwrite that new status.
    if (!this.active) {
      callSafely(session.callbacks.onStatus, '本次语音输入已取消，可以再次点击开始或输入文字。');
    }
  }
}

function words(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (text.length > MAX_COMPARE_CHARACTERS) {
    throw new RangeError(`比较内容过长：每段最多${MAX_COMPARE_CHARACTERS.toLocaleString('en-US')}个字符，请分段练习。`);
  }
  const normalized = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc\uff07]/g, "'");
  const tokens = normalized.match(/[a-z0-9]+(?:'[a-z0-9]+)*/g) || [];
  if (tokens.length > MAX_COMPARE_WORDS) {
    throw new RangeError(`比较内容过长：每段最多${MAX_COMPARE_WORDS}个英文单词，请分段练习。`);
  }
  return tokens;
}

/**
 * Word-error-rate text comparison, NOT pronunciation-quality assessment.
 * Case/punctuation are ignored; straight/curly internal apostrophes normalize
 * to the same contraction. Inputs above 300 words or 20,000 characters throw
 * RangeError instead of silently scoring only a truncated portion.
 */
export function compareWords(target, spoken) {
  const expected = words(target);
  const actual = words(spoken);
  const rows = expected.length + 1;
  const columns = actual.length + 1;
  const cells = rows * columns;
  const distance = new Uint16Array(cells);
  const matches = new Uint16Array(cells);
  const direction = new Uint8Array(cells);
  // Directions: 1 = paired words, 2 = missing expected word, 3 = extra word.
  for (let row = 1; row < rows; row += 1) {
    const index = row * columns;
    distance[index] = row;
    direction[index] = 2;
  }
  for (let column = 1; column < columns; column += 1) {
    distance[column] = column;
    direction[column] = 3;
  }

  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const index = row * columns + column;
      const diagonal = index - columns - 1;
      const equal = expected[row - 1] === actual[column - 1];
      let bestDistance = distance[diagonal] + (equal ? 0 : 1);
      let bestMatches = matches[diagonal] + (equal ? 1 : 0);
      let bestDirection = 1;
      const missing = index - columns;
      const extra = index - 1;
      for (const [previous, candidateDirection] of [[missing, 2], [extra, 3]]) {
        const candidateDistance = distance[previous] + 1;
        const candidateMatches = matches[previous];
        if (
          candidateDistance < bestDistance ||
          (candidateDistance === bestDistance && candidateMatches > bestMatches)
        ) {
          bestDistance = candidateDistance;
          bestMatches = candidateMatches;
          bestDirection = candidateDirection;
        }
      }
      distance[index] = bestDistance;
      matches[index] = bestMatches;
      direction[index] = bestDirection;
    }
  }

  const alignment = [];
  let row = expected.length;
  let column = actual.length;
  let correct = 0;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  while (row > 0 || column > 0) {
    const step = direction[row * columns + column];
    if (step === 1) {
      const expectedWord = expected[--row];
      const actualWord = actual[--column];
      const equal = expectedWord === actualWord;
      if (equal) correct += 1;
      else substitutions += 1;
      alignment.push({
        expected: expectedWord,
        actual: actualWord,
        kind: equal ? 'correct' : 'substitution',
      });
    } else if (step === 2) {
      deletions += 1;
      alignment.push({ expected: expected[--row], actual: '', kind: 'missing' });
    } else {
      insertions += 1;
      alignment.push({ expected: '', actual: actual[--column], kind: 'extra' });
    }
  }
  alignment.reverse();
  const total = expected.length;
  const errors = substitutions + deletions + insertions;
  const score = total === 0
    ? (actual.length === 0 ? 100 : 0)
    : Math.max(0, Math.round(100 * (1 - errors / total)));
  const weakWords = [...new Set(
    alignment
      .filter((item) => item.kind === 'missing' || item.kind === 'substitution')
      .map((item) => item.expected),
  )];
  return { score, correct, total, substitutions, deletions, insertions, alignment, weakWords };
}
