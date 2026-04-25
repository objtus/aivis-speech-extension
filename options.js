const speakerSelect = document.getElementById('speaker-select');
const styleSelect   = document.getElementById('style-select');
const volumeSlider  = document.getElementById('volume');
const volumeDisplay = document.getElementById('volume-display');
const saveBtn       = document.getElementById('save-btn');
const toast         = document.getElementById('toast');
const apiStatus     = document.getElementById('api-status');

let speakersData = []; // API から取得した話者一覧

// ── 起動時：話者一覧を取得して既存設定を復元 ──────

chrome.runtime.sendMessage({ type: 'get-speakers' }, (response) => {
  if (chrome.runtime.lastError || response?.error) {
    apiStatus.textContent = 'サーバーに接続できませんでした。AivisSpeech Engine が起動しているか確認してください。';
    apiStatus.className = 'api-status error';
    return;
  }

  speakersData = response.speakers;
  apiStatus.textContent = `${speakersData.length} 人の話者が見つかりました`;
  apiStatus.className = 'api-status ok';

  // 話者ドロップダウンを構築
  speakerSelect.innerHTML = '';
  speakersData.forEach((sp) => {
    const opt = document.createElement('option');
    opt.value = sp.speaker_uuid;
    opt.textContent = sp.name;
    speakerSelect.appendChild(opt);
  });
  speakerSelect.disabled = false;

  // 保存済みの speakerId から話者・スタイルを復元
  chrome.storage.sync.get({ speakerId: 888753763, volume: 100 }, (items) => {
    const savedId = items.speakerId;
    volumeSlider.value = items.volume;
    volumeDisplay.textContent = `${items.volume}%`;

    // speakerId に一致する話者・スタイルを探す
    let matchedUuid = null;
    for (const sp of speakersData) {
      if (sp.styles.some(s => s.id === savedId)) {
        matchedUuid = sp.speaker_uuid;
        break;
      }
    }
    if (matchedUuid) speakerSelect.value = matchedUuid;
    updateStyleDropdown(savedId);
  });
});

// ── 話者が変わったらスタイルドロップダウンを更新 ──

speakerSelect.addEventListener('change', () => updateStyleDropdown(null));

function updateStyleDropdown(selectStyleId) {
  const uuid = speakerSelect.value;
  const speaker = speakersData.find(sp => sp.speaker_uuid === uuid);

  styleSelect.innerHTML = '';
  if (!speaker) {
    styleSelect.disabled = true;
    return;
  }

  speaker.styles
    .filter(s => s.type === 'talk')
    .forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      styleSelect.appendChild(opt);
    });

  // 保存済み ID があれば選択状態にする
  if (selectStyleId !== null) {
    styleSelect.value = String(selectStyleId);
  }
  styleSelect.disabled = false;
}

// ── 音量スライダー ────────────────────────────────

volumeSlider.addEventListener('input', () => {
  volumeDisplay.textContent = `${volumeSlider.value}%`;
});

// ── 保存 ─────────────────────────────────────────

saveBtn.addEventListener('click', () => {
  const speakerId = Number(styleSelect.value);
  const volume    = Number(volumeSlider.value);

  if (!speakerId) return;

  chrome.storage.sync.set({ speakerId, volume }, () => {
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
  });
});
