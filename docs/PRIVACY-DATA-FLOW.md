# NarraTrace privacy and data flow

## Website access

NarraTrace injects its reader content scripts on pages matching `<all_urls>`. This enables the floating reader, page extraction, highlighting, and context-menu features across websites. It is broad website access and should be treated as such. Chrome's internal pages and other restricted browser surfaces are not made accessible by this match pattern.

## Where page text goes

1. The content script extracts readable page text and builds the sentence queue.
2. The queue and playback position are sent to the NarraTrace service worker through Chrome extension messaging.
3. The service worker passes utterances to Chrome's `chrome.tts` API.
4. Chrome routes each utterance to the selected TTS voice provider.

NarraTrace's core extension code does not implement an HTTP, WebSocket, or analytics client for sending page text to a NarraTrace-operated server. However, the selected TTS provider is a separate component. A local neural engine can process text on-device, while another engine or a system voice may use a network service. NarraTrace cannot guarantee the processing location or retention policy of a third-party engine; users should review that engine's own documentation and privacy policy.

## Extension storage

- `chrome.storage.session` stores the active sentence queue, current position, tab association, and playback options so a service-worker restart can recover playback.
- `chrome.storage.local` stores preferences such as voice selection, speed, volume, pitch, pronunciation rules, and interface settings.

This storage is managed by Chrome for the extension. It is not a NarraTrace cloud account or a server-side sync feature.

## Permissions

The manifest requests `tts`, `storage`, `alarms`, and `contextMenus`. It no longer requests `activeTab` or `scripting`: the runtime does not call `chrome.scripting`, and the existing content-script host match provides the site access required by the reader. The broad `<all_urls>` match remains a deliberate product requirement.
