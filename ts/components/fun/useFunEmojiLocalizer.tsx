// Copyright 2025 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo } from 'react';
import type { EmojiParentKey, EmojiVariantKey } from './data/emojis';
import {
  getEmojiParentByKey,
  getEmojiParentKeyByVariantKey,
  getEmojiVariantKeyByValue,
  isEmojiVariantValue,
} from './data/emojis';
import type { LocaleEmojiListType } from '../../types/emoji';
import { strictAssert } from '../../util/assert';
import { useFunEmojiLocalization } from './FunEmojiLocalizationProvider';

export type FunEmojiLocalizerIndex = Readonly<{
  parentKeyToLocaleShortName: ReadonlyMap<EmojiParentKey, string>;
  localeShortNameToParentKey: ReadonlyMap<string, EmojiParentKey>;
}>;

export type FunEmojiLocalizer = Readonly<{
  getLocaleShortName: (key: EmojiVariantKey) => string;
  getParentKeyForText: (text: string) => EmojiParentKey | null;
}>;

export function createFunEmojiLocalizerIndex(
  localeEmojiList: LocaleEmojiListType
): FunEmojiLocalizerIndex {
  const parentKeyToLocaleShortName = new Map<EmojiParentKey, string>();
  const localeShortNameToParentKey = new Map<string, EmojiParentKey>();

  for (const entry of localeEmojiList) {
    strictAssert(
      isEmojiVariantValue(entry.emoji),
      'createFunEmojiLocalizerIndex: Must be emoji variant value'
    );

    const variantKey = getEmojiVariantKeyByValue(entry.emoji);
    const parentKey = getEmojiParentKeyByVariantKey(variantKey);
    const localizedShortName = entry.tags.at(0) ?? entry.shortName;
    parentKeyToLocaleShortName.set(parentKey, localizedShortName);
    localeShortNameToParentKey.set(localizedShortName, parentKey);
  }

  return { parentKeyToLocaleShortName, localeShortNameToParentKey };
}

/** @internal exported for tests */
export function _createFunEmojiLocalizer(
  emojiLocalizerIndex: FunEmojiLocalizerIndex
): FunEmojiLocalizer {
  function getLocaleShortName(variantKey: EmojiVariantKey) {
    const parentKey = getEmojiParentKeyByVariantKey(variantKey);
    const localeShortName =
      emojiLocalizerIndex.parentKeyToLocaleShortName.get(parentKey);
    if (localeShortName != null) {
      return localeShortName;
    }
    // Fallback to english short name
    const parent = getEmojiParentByKey(parentKey);
    return parent.englishShortNameDefault;
  }

  function getParentKeyForText(text: string): EmojiParentKey | null {
    const parentKey = emojiLocalizerIndex.localeShortNameToParentKey.get(text);
    return parentKey ?? null;
  }

  return { getLocaleShortName, getParentKeyForText };
}

export function useFunEmojiLocalizer(): FunEmojiLocalizer {
  const { emojiLocalizerIndex } = useFunEmojiLocalization();
  const emojiLocalizer = useMemo(() => {
    return _createFunEmojiLocalizer(emojiLocalizerIndex);
  }, [emojiLocalizerIndex]);
  return emojiLocalizer;
}
