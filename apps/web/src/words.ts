// The interface's words, from one language pack per BCP 47 tag (languages/<tag>.yaml). Adding
// an interface language is adding a pack and a line in PACKS.

import { createContext, useContext } from "react";
import en from "../languages/en.yaml";
import ja from "../languages/ja.yaml";
import zh from "../languages/zh.yaml";

const PACKS = { en, ja, zh } as const;

export type Tag = keyof typeof PACKS;
export const TAGS = Object.keys(PACKS) as Tag[];

export type Say = (key: string, params?: Record<string, string | number>) => string;

/** The words of one language; a key the pack lacks shows the English words, then the key. */
export function wordsOf(tag: Tag): Say {
  const pack = PACKS[tag];
  return (key, params) => {
    const text = pack[key] ?? PACKS.en[key] ?? key;
    return params ? text.replace(/\{(\w+)\}/g, (m, name: string) => String(params[name] ?? m)) : text;
  };
}

/** The language a BCP 47 tag asks for, if there is a pack for it: zh-CN is zh. */
export function tagOf(locale: string | undefined): Tag | undefined {
  const primary = locale?.toLowerCase().split("-")[0];
  return TAGS.find((t) => t === primary);
}

/** The interface language: the one picked on this device, else the person's, else the browser's. */
export function chooseTag(picked: string | null, personLocale: string | undefined): Tag {
  return tagOf(picked ?? undefined) ?? tagOf(personLocale) ?? navigator.languages.map(tagOf).find(Boolean) ?? "en";
}

export const Words = createContext<{ say: Say; tag: Tag }>({ say: wordsOf("en"), tag: "en" });

export const useWords = () => useContext(Words);
