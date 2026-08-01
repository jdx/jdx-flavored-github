chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'open-options') {
    void chrome.runtime.openOptionsPage();
  }
});
