const DEFAULT_SPEAKER_ID = 888753763;
const API_BASE = 'http://192.168.11.150:10101';

let _chunkIdCounter = 0;
let _sessionId = 0;       // インクリメントすることで現在のセッションを無効化
let _currentTabId = null;

// ── 初期化 ──────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'aivis-speak',
    title: '読み上げ',
    contexts: ['selection'],
  });
});

// ── 設定画面からの話者一覧リクエスト ────────────
// options.html は chrome-extension:// で動くため直接 fetch できない。
// background SW 経由で取得して返す。

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'get-speakers') {
    fetch(`${API_BASE}/speakers`)
      .then(r => r.json())
      .then(speakers => sendResponse({ speakers }))
      .catch(err => sendResponse({ error: err.message }));
    return true; // 非同期レスポンスのために true を返す
  }
});

// ── 停止リクエストの受信 ─────────────────────────
// トーストの × ボタンを押すとページから送られてくる

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'stop-playback') return;
  // セッション ID をインクリメントして現在の読み上げループを無効化
  _sessionId++;
  chrome.action.setBadgeText({ text: '' });
  if (_currentTabId !== null) injectRemoveToast(_currentTabId);
});

// ── コンテキストメニュー ─────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'aivis-speak') return;

  const text = info.selectionText?.trim();
  if (!text || !tab?.id) return;

  // 新しい読み上げを開始するたびに自分専用のセッション ID を取得する。
  // 他の読み上げが走っている場合はそのセッションが無効化される。
  const mySession = ++_sessionId;
  _currentTabId = tab.id;

  setBadge('…', '#FF9F0A');
  injectToast(tab.id, '生成中...', 'generating');
  // AudioContext をページ側で事前初期化しておく（最初のチャンク再生時のウォームアップ遅延を防ぐ）
  preWarmAudioContext(tab.id);

  const { volume } = await chrome.storage.sync.get({ volume: 100 });
  const { speakerId } = await chrome.storage.sync.get({ speakerId: DEFAULT_SPEAKER_ID });
  const sentences = splitSentences(text);

  try {
    // ── 1 look-ahead パイプライン ──
    let nextPromise = generateAudioWithRetry(sentences[0], speakerId);

    for (let i = 0; i < sentences.length; i++) {
      if (_sessionId !== mySession) break; // 停止 or 新しい読み上げで中断

      const currentPromise = nextPromise;

      if (i + 1 < sentences.length) {
        nextPromise = generateAudioWithRetry(sentences[i + 1], speakerId);
      }

      const wavBase64 = await currentPromise;
      if (!wavBase64) continue;
      if (_sessionId !== mySession) break; // 生成待ち中に停止された場合

      if (i === 0) setBadge('▶', '#34C759');

      const label = sentences.length > 1
        ? `再生中... ${i + 1}/${sentences.length}`
        : '再生中...';
      injectToast(tab.id, label, 'playing');

      await playChunkAndWait(tab.id, wavBase64, volume, speakerId);
    }

    // 正常完了 or 停止完了（停止時はすでに onMessage でバッジ・トーストを片付け済み）
    if (_sessionId === mySession) {
      chrome.action.setBadgeText({ text: '' });
      injectRemoveToast(tab.id);
    }

  } catch (err) {
    if (_sessionId !== mySession) return;
    console.error('[AivisSpeech] エラー:', err.message);
    setBadge('!', '#FF3B30');
    injectToast(tab.id, 'エラーが発生しました', 'error');
    setTimeout(() => {
      if (_sessionId === mySession) {
        chrome.action.setBadgeText({ text: '' });
        injectRemoveToast(tab.id);
      }
    }, 3000);
  }
});

// ── テキスト分割 ─────────────────────────────────

function splitSentences(text) {
  if (text.length <= 40) return [text];

  const chunks = [];

  const sentenceParts = text.replace(/([。！？])\s*/g, '$1\n').split(/\n+/);

  for (const part of sentenceParts) {
    const t = part.trim();
    if (!t) continue;

    if (t.length > 60) {
      const clauseParts = t.replace(/(、)\s*/g, '$1\n').split(/\n+/);
      let buf = '';
      for (const cp of clauseParts) {
        buf += cp;
        if (buf.length >= 15) {
          chunks.push(buf.trim());
          buf = '';
        }
      }
      if (buf.trim()) chunks.push(buf.trim());
    } else {
      chunks.push(t);
    }
  }

  return chunks.filter(s => s.length > 0);
}

// ── 音声生成（Service Worker 内で実行） ────────────

async function generateAudio(text, speakerId) {
  const queryRes = await fetch(
    `${API_BASE}/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`,
    { method: 'POST' }
  );
  if (!queryRes.ok) throw new Error(`audio_query HTTP ${queryRes.status}`);
  const queryJson = await queryRes.json();

  const synthRes = await fetch(
    `${API_BASE}/synthesis?speaker=${speakerId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(queryJson),
    }
  );
  if (!synthRes.ok) throw new Error(`synthesis HTTP ${synthRes.status}`);

  return arrayBufferToBase64(await synthRes.arrayBuffer());
}

// 生成失敗時に最大 maxRetries 回リトライする（指数バックオフ）
async function generateAudioWithRetry(text, speakerId, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await generateAudio(text, speakerId);
    } catch (err) {
      if (attempt < maxRetries) {
        const wait = 700 * (attempt + 1);
        console.warn(`[AivisSpeech] 生成リトライ ${attempt + 1}/${maxRetries} (${wait}ms待機): "${text.slice(0, 20)}..."`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        console.warn(`[AivisSpeech] 生成失敗（スキップ）: "${text.slice(0, 20)}..." - ${err.message}`);
      }
    }
  }
  return null;
}

// ── チャンク再生（ページに注入して完了を待つ） ────────

function playChunkAndWait(tabId, wavBase64, volume) {
  const chunkId = ++_chunkIdCounter;

  return new Promise((resolve) => {
    let timeoutId;

    const handler = (msg) => {
      if (msg.type === 'chunk-ended' && msg.id === chunkId) {
        chrome.runtime.onMessage.removeListener(handler);
        clearTimeout(timeoutId);
        resolve();
      }
    };
    chrome.runtime.onMessage.addListener(handler);

    timeoutId = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(handler);
      resolve();
    }, 30_000);

    chrome.scripting.executeScript({
      target: { tabId },
      func: playChunkInPage,
      args: [wavBase64, volume, chunkId],
    }).catch((err) => {
      console.error('[AivisSpeech] chunk注入失敗:', err.message);
      chrome.runtime.onMessage.removeListener(handler);
      clearTimeout(timeoutId);
      resolve();
    });
  });
}

// ── ヘルパー（Service Worker 内で実行） ─────────────

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function injectToast(tabId, message, state) {
  chrome.scripting.executeScript({
    target: { tabId },
    func: updateAivisToast,
    args: [message, state],
  }).catch(() => {});
}

// AudioContext をページ側で事前初期化する（ウォームアップ遅延の排除）
function preWarmAudioContext(tabId) {
  chrome.scripting.executeScript({
    target: { tabId },
    func: initAivisAudioContext,
  }).catch(() => {});
}

function injectRemoveToast(tabId) {
  chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const t = document.getElementById('__aivis_toast__');
      const s = document.getElementById('__aivis_style__');
      if (t) {
        t.style.opacity = '0';
        setTimeout(() => { t.remove(); s?.remove(); }, 320);
      }
    },
  }).catch(() => {});
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ── ページ注入関数（isolated world で実行） ──────────

// AudioContext を事前初期化・ウォームアップ（コンテキストメニュークリック時に即呼ぶ）
function initAivisAudioContext() {
  if (!window.__aivisAudioCtx || window.__aivisAudioCtx.state === 'closed') {
    window.__aivisAudioCtx = new AudioContext();
  }
  if (window.__aivisAudioCtx.state === 'suspended') {
    window.__aivisAudioCtx.resume().catch(() => {});
  }
}

// トーストの表示・更新
function updateAivisToast(message, state) {
  const STYLE_ID = '__aivis_style__';
  const TOAST_ID = '__aivis_toast__';

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      @keyframes _aivis_pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50%       { opacity: 0.5; transform: scale(0.85); }
      }
      #${TOAST_ID} {
        position: fixed !important;
        bottom: 24px !important;
        right: 24px !important;
        z-index: 2147483647 !important;
        background: rgba(18, 18, 18, 0.90) !important;
        backdrop-filter: blur(6px) !important;
        color: #fff !important;
        font-family: "Segoe UI", "Hiragino Sans", system-ui, sans-serif !important;
        font-size: 13px !important;
        font-weight: 500 !important;
        line-height: 1 !important;
        padding: 10px 14px !important;
        border-radius: 999px !important;
        box-shadow: 0 4px 20px rgba(0,0,0,0.40) !important;
        display: flex !important;
        align-items: center !important;
        gap: 8px !important;
        pointer-events: none !important;
        transition: opacity 0.3s ease !important;
        margin: 0 !important;
      }
      #${TOAST_ID} ._aivis_dot {
        width: 8px !important;
        height: 8px !important;
        border-radius: 50% !important;
        flex-shrink: 0 !important;
      }
      #${TOAST_ID}.generating ._aivis_dot {
        background: #FF9F0A !important;
        animation: _aivis_pulse 1.1s ease-in-out infinite !important;
      }
      #${TOAST_ID}.playing ._aivis_dot {
        background: #34C759 !important;
        animation: _aivis_pulse 0.65s ease-in-out infinite !important;
      }
      #${TOAST_ID}.error ._aivis_dot {
        background: #FF453A !important;
      }
      #${TOAST_ID} ._aivis_stop {
        pointer-events: auto !important;
        cursor: pointer !important;
        width: 18px !important;
        height: 18px !important;
        border-radius: 50% !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        font-size: 11px !important;
        font-weight: 700 !important;
        opacity: 0.55 !important;
        background: rgba(255,255,255,0.15) !important;
        flex-shrink: 0 !important;
        transition: opacity 0.15s, background 0.15s !important;
        line-height: 1 !important;
        padding: 0 !important;
        border: none !important;
        color: #fff !important;
        margin-left: 2px !important;
      }
      #${TOAST_ID} ._aivis_stop:hover {
        opacity: 1 !important;
        background: rgba(255,255,255,0.28) !important;
      }
      #${TOAST_ID}.error ._aivis_stop {
        display: none !important;
      }
    `;
    document.head.appendChild(style);
  }

  let toast = document.getElementById(TOAST_ID);
  if (!toast) {
    toast = document.createElement('div');
    toast.id = TOAST_ID;
    document.body.appendChild(toast);
  }

  toast.className = state;
  toast.style.opacity = '1';
  toast.innerHTML =
    `<span class="_aivis_dot"></span>` +
    `<span>${message}</span>` +
    `<button class="_aivis_stop" title="停止">✕</button>`;

  // × ボタンのクリックで停止シグナルを送出する
  const stopBtn = toast.querySelector('._aivis_stop');
  if (stopBtn) {
    stopBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // 現在再生中の音声を即停止させるカスタムイベントをページ内に発火
      document.dispatchEvent(new CustomEvent('__aivis_stop_audio'));
      // background.js にも通知してパイプラインを終了させる
      chrome.runtime.sendMessage({ type: 'stop-playback' });
    });
  }
}

// チャンク単位の再生
// AudioContext をチャンク間で使い回すことで毎回のウォームアップ遅延（冒頭無音）を防ぐ
async function playChunkInPage(wavBase64, volume, chunkId) {
  const notify = () => chrome.runtime.sendMessage({ type: 'chunk-ended', id: chunkId });

  try {
    // 共有 AudioContext を取得（なければ新規作成）
    if (!window.__aivisAudioCtx || window.__aivisAudioCtx.state === 'closed') {
      window.__aivisAudioCtx = new AudioContext();
    }
    const audioCtx = window.__aivisAudioCtx;
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    const binary = atob(wavBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const audioBuffer = await audioCtx.decodeAudioData(bytes.buffer);
    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;

    const gainNode = audioCtx.createGain();
    gainNode.gain.value = volume / 100;
    source.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    // __aivis_stop_audio イベントで即停止（source.stop() が onended を発火する）
    const stopHandler = () => source.stop();
    document.addEventListener('__aivis_stop_audio', stopHandler, { once: true });

    source.onended = () => {
      document.removeEventListener('__aivis_stop_audio', stopHandler);
      // AudioContext は閉じずに次チャンクのために維持する
      notify();
    };

    source.start();

  } catch (err) {
    notify();
  }
}
