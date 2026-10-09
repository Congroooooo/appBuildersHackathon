// Forwards page context to Continuum's local helper through Chrome native messaging (a process on this computer,
// no network). If Continuum's helper is not installed the message is simply dropped.
const HOST = 'com.continuum.page_context';

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'continuum-page' || !sender.tab || sender.tab.incognito) return;
  chrome.runtime.sendNativeMessage(HOST, { v: 1, ...message.payload, at: new Date().toISOString() }, () => { void chrome.runtime.lastError; });
});
