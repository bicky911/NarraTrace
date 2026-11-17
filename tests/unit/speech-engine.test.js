import test from "node:test";
import assert from "node:assert/strict";
import { detectScript, findBestVoiceForLang } from "../../speech-engine.js";

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
