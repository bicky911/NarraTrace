import test from "node:test";
import assert from "node:assert/strict";
import {
  detectAndSelectVoice,
  detectScript,
  findBestVoiceForLang,
  getEngineSpec,
  safeSpeak,
  PIPER_EXTENSION_ID,
  KOKORO_EXTENSION_ID,
  SUPERTONIC_EXTENSION_ID
} from "../../speech-engine.js";

test("detects Bengali text", () => {
  assert.equal(detectScript("বাংলা ভাষার পরীক্ষা"), "bn");
});

test("detects Devanagari text", () => {
  assert.equal(detectScript("हिन्दी भाषा का परीक्षण"), "hi");
});

test("defaults Latin and empty input to English", () => {
  assert.equal(detectScript("A plain English sentence"), "en");
  assert.equal(detectScript(""), "en");
  assert.equal(detectScript(null), "en");
});

test("selects a voice by BCP-47 language prefix", () => {
  const voices = [
    { voiceName: "English Voice", lang: "en-US" },
    { voiceName: "Bengali Voice", lang: "bn-BD" }
  ];

  assert.equal(findBestVoiceForLang(voices, "bn").voiceName, "Bengali Voice");
});

test("uses a Bengali voice-name fallback when language metadata is absent", () => {
  const voices = [
    { voiceName: "Windows Voice", lang: "en-US" },
    { voiceName: "Bangla Natural", lang: "" }
  ];

  assert.equal(findBestVoiceForLang(voices, "bn").voiceName, "Bangla Natural");
});

test("returns the supplied fallback when no matching voice exists", () => {
  const fallback = { voiceName: "Default Voice", lang: "en-US" };
  const voices = [{ voiceName: "English Voice", lang: "en-US" }];

  assert.equal(findBestVoiceForLang(voices, "hi", fallback), fallback);
  assert.equal(findBestVoiceForLang([], "bn", fallback), fallback);
});


function installVoiceRegistry(t, voices) {
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: { lastError: null },
    tts: {
      speak() {},
      getVoices(callback) {
        callback(voices);
      }
    }
  };

  t.after(() => {
    if (previousChrome === undefined) {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = previousChrome;
    }
  });
}

test("Piper remains the highest-priority provider when all neural engines are present", async (t) => {
  const piperExtensionId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  installVoiceRegistry(t, [
    { voiceName: "Kokoro Heart", lang: "en-US", extensionId: KOKORO_EXTENSION_ID },
    { voiceName: "Supertonic English", lang: "en-US", extensionId: SUPERTONIC_EXTENSION_ID },
    { voiceName: "Piper Amy", lang: "en-US", extensionId: piperExtensionId }
  ]);

  const report = await detectAndSelectVoice();

  assert.equal(report.selectedVoice.voiceName, "Piper Amy");
  assert.equal(report.selectedVoice.extensionId, piperExtensionId);
  assert.equal(report.engineId, PIPER_EXTENSION_ID);
  assert.equal(report.engineLabel, "Piper");
  assert.equal(report.engineBadge, "PIPER");
  assert.deepEqual(report.engines.map((engine) => engine.id), [
    PIPER_EXTENSION_ID,
    KOKORO_EXTENSION_ID,
    SUPERTONIC_EXTENSION_ID
  ]);
});

test("a dynamic Piper extension ID resolves to the canonical Piper engine group", async (t) => {
  const piperExtensionId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const piperVoice = {
    voiceName: "Piper Amy",
    lang: "en-US",
    extensionId: piperExtensionId
  };
  installVoiceRegistry(t, [
    piperVoice,
    { voiceName: "Kokoro Heart", lang: "en-US", extensionId: KOKORO_EXTENSION_ID }
  ]);

  const report = await detectAndSelectVoice();

  assert.equal(getEngineSpec(piperExtensionId, piperVoice).id, PIPER_EXTENSION_ID);
  assert.equal(report.engineId, PIPER_EXTENSION_ID);
  assert.equal(report.engineBadge, "PIPER");
  assert.equal(report.engines[0].voices[0].extensionId, piperExtensionId);
  assert.equal(report.otherVoices.some((voice) => voice.voiceName === "Piper Amy"), false);
  assert.equal(report.otherVoices.some((voice) => voice.voiceName === "Kokoro Heart"), true);
});

test("a deliberately pinned dynamic Piper voice remains selected and is labelled correctly", async (t) => {
  const piperExtensionId = "cccccccccccccccccccccccccccccccc";
  const piperVoice = {
    voiceName: "Piper Amy",
    lang: "en-US",
    extensionId: piperExtensionId
  };
  installVoiceRegistry(t, [
    { voiceName: "Kokoro Heart", lang: "en-US", extensionId: KOKORO_EXTENSION_ID },
    piperVoice
  ]);

  const report = await detectAndSelectVoice({
    voiceName: "Piper Amy",
    pinned: true
  });

  assert.equal(report.selectedVoice, piperVoice);
  assert.match(report.statusMessage, /^Using Piper voice/);
  assert.equal(report.engineBadge, "PIPER");
  assert.equal(report.engineId, PIPER_EXTENSION_ID);
});

test("an unavailable pinned provider falls back to the highest-priority available provider", async (t) => {
  installVoiceRegistry(t, [
    { voiceName: "Kokoro Heart", lang: "en-US", extensionId: KOKORO_EXTENSION_ID },
    { voiceName: "Supertonic English", lang: "en-US", extensionId: SUPERTONIC_EXTENSION_ID }
  ]);

  const report = await detectAndSelectVoice({
    voiceName: "Piper Amy",
    pinned: true
  });

  assert.equal(report.selectedVoice.voiceName, "Kokoro Heart");
  assert.equal(report.engineBadge, "KOKORO");
});

test("system voices remain the fallback when no extension provider is available", async (t) => {
  installVoiceRegistry(t, [
    { voiceName: "Windows English", lang: "en-US" },
    { voiceName: "Windows Other", lang: "fr-FR" }
  ]);

  const report = await detectAndSelectVoice();

  assert.equal(report.selectedVoice.voiceName, "Windows English");
  assert.equal(report.engineId, null);
  assert.equal(report.engineBadge, "SYSTEM");
});

test("unknown chrome.tts providers remain visible and can be selected", async (t) => {
  const unknownId = "dddddddddddddddddddddddddddddddd";
  installVoiceRegistry(t, [
    { voiceName: "Third-party Voice", lang: "en-US", extensionId: unknownId }
  ]);

  const report = await detectAndSelectVoice();

  assert.equal(report.selectedVoice.voiceName, "Third-party Voice");
  assert.equal(report.engineId, unknownId);
  assert.equal(report.engineLabel, "Other engine");
  assert.equal(report.engineBadge, "OTHER");
});

test("safeSpeak forwards trimmed non-empty voice metadata and resolves on end", async (t) => {
  const previousChrome = globalThis.chrome;
  let captured = null;
  globalThis.chrome = {
    runtime: { lastError: null },
    tts: {
      speak(text, options, callback) {
        captured = { text, options };
        options.onEvent({ type: "start" });
        options.onEvent({ type: "word", charIndex: 0, length: 5 });
        options.onEvent({ type: "end" });
        callback?.();
      }
    }
  };
  t.after(() => {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  });

  const events = [];
  const result = await safeSpeak(
    "Hello world.",
    {
      rate: 1.25,
      pitch: 0.9,
      volume: 0.8,
      voiceName: "  Piper Amy  ",
      extensionId: "  aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  ",
      lang: "  en-US  "
    },
    (event) => events.push(event.type)
  );

  assert.equal(result.type, "end");
  assert.equal(captured.text, "Hello world.");
  assert.equal(captured.options.voiceName, "Piper Amy");
  assert.equal(captured.options.extensionId, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(captured.options.lang, "en-US");
  assert.equal(captured.options.rate, 1.25);
  assert.equal(captured.options.pitch, 0.9);
  assert.equal(captured.options.volume, 0.8);
  assert.deepEqual(events, ["start", "word", "end"]);
});

test("safeSpeak omits empty optional metadata instead of passing empty strings", async (t) => {
  const previousChrome = globalThis.chrome;
  let capturedOptions = null;
  globalThis.chrome = {
    runtime: { lastError: null },
    tts: {
      speak(_text, options) {
        capturedOptions = options;
        options.onEvent({ type: "end" });
      }
    }
  };
  t.after(() => {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  });

  await safeSpeak("Hello.", {
    voiceName: " ",
    extensionId: "",
    lang: null
  });

  assert.equal("voiceName" in capturedOptions, false);
  assert.equal("extensionId" in capturedOptions, false);
  assert.equal("lang" in capturedOptions, false);
});

test("safeSpeak rejects provider error events with the engine message", async (t) => {
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: { lastError: null },
    tts: {
      speak(_text, options) {
        queueMicrotask(() => options.onEvent({
          type: "error",
          errorMessage: "Provider is unavailable"
        }));
      }
    }
  };
  t.after(() => {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  });

  await assert.rejects(
    safeSpeak("Hello."),
    /Provider is unavailable/
  );
});

test("safeSpeak rejects chrome.tts API callback errors", async (t) => {
  const previousChrome = globalThis.chrome;
  const runtime = { lastError: null };
  globalThis.chrome = {
    runtime,
    tts: {
      speak(_text, _options, callback) {
        runtime.lastError = { message: "No TTS provider accepted the request" };
        callback?.();
        runtime.lastError = null;
      }
    }
  };
  t.after(() => {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  });

  await assert.rejects(
    safeSpeak("Hello."),
    /No TTS provider accepted the request/
  );
});

test("safeSpeak treats whitespace-only input as a no-op", async (t) => {
  const previousChrome = globalThis.chrome;
  let speakCalls = 0;
  globalThis.chrome = {
    runtime: { lastError: null },
    tts: {
      speak() {
        speakCalls++;
      }
    }
  };
  t.after(() => {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  });

  const result = await safeSpeak("   ");

  assert.deepEqual(result, { type: "empty" });
  assert.equal(speakCalls, 0);
});
