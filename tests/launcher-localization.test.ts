import { expect, test } from "bun:test";
import { copyFor } from "../launcher/src/i18n";
import languages from "../launcher/electron/languages.json";
import type { Language } from "../launcher/src/types";

test("supported launcher locales return complete, nonempty dictionaries", () => {
  const english = copyFor("en");
  const keys = Object.keys(english).sort();
  for (const language of Object.keys(languages) as Language[]) {
    const translated = copyFor(language);
    expect(Object.keys(translated).sort()).toEqual(keys);
    expect(Object.values(translated).every(text => text.trim().length > 0)).toBe(true);
    if (language !== "en") {
      expect(translated.installCodex).not.toBe(english.installCodex);
      expect(translated.done).not.toBe(english.done);
    }
    for (const key of keys as Array<keyof typeof english>) {
      const placeholders = (value: string) => [...value.matchAll(/\{[a-zA-Z]+\}/g)].map(match => match[0]).sort();
      expect(placeholders(translated[key])).toEqual(placeholders(english[key]));
    }
    expect(translated.biggerContextBody).not.toContain("TXT");
    expect(translated.manualPromptInstruction).toContain("Codex Zero Risk");
  }
});
