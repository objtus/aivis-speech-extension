const volumeSlider = document.getElementById('volume');
const volumeDisplay = document.getElementById('volume-display');
const saveBtn = document.getElementById('save-btn');
const toast = document.getElementById('toast');

// 保存済みの設定を読み込む
chrome.storage.sync.get({ volume: 100 }, (items) => {
  volumeSlider.value = items.volume;
  volumeDisplay.textContent = `${items.volume}%`;
});

// スライダーを動かすとリアルタイムで数値を更新
volumeSlider.addEventListener('input', () => {
  volumeDisplay.textContent = `${volumeSlider.value}%`;
});

// 保存ボタン
saveBtn.addEventListener('click', () => {
  const volume = Number(volumeSlider.value);
  chrome.storage.sync.set({ volume }, () => {
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
  });
});
