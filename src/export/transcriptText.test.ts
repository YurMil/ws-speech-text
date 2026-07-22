import { describe, expect, it } from 'vitest';
import {
  collapseRepetitionLoops,
  finalizeTranscript,
  joinOverlappingText,
  tidyPunctuation,
} from './transcriptText';

describe('joinOverlappingText', () => {
  it('drops the passage the window overlap transcribed twice', () => {
    expect(
      joinOverlappingText('сегодня мы обсудим план работ на следующий', 'на следующий квартал и бюджет'),
    ).toBe('сегодня мы обсудим план работ на следующий квартал и бюджет');
  });

  it('matches across differing punctuation and keeps the later rendering', () => {
    // The second window decoded these words with the following context, so its
    // comma is the correct one — the first window had to guess at an ending.
    expect(
      joinOverlappingText(
        'это первый пункт. Второй пункт очень важен',
        'Второй пункт очень важен, и третий тоже',
      ),
    ).toBe('это первый пункт. Второй пункт очень важен, и третий тоже');
  });

  it('does not join when nothing genuinely overlaps', () => {
    expect(joinOverlappingText('первое предложение', 'второе предложение')).toBe(
      'первое предложение второе предложение',
    );
  });

  it('refuses to join on a short function-word overlap', () => {
    // "и в" repeating is a coincidence, not a seam; gluing here would delete
    // real speech.
    expect(joinOverlappingText('он пришёл и в', 'и в этом нет ничего плохого')).toBe(
      'он пришёл и в и в этом нет ничего плохого',
    );
  });

  it('handles an empty side', () => {
    expect(joinOverlappingText('', 'только это')).toBe('только это');
    expect(joinOverlappingText('только это', '')).toBe('только это');
  });
});

describe('collapseRepetitionLoops', () => {
  it('collapses the phrase loop Whisper emits over silence', () => {
    expect(
      collapseRepetitionLoops(
        'Субтитры сделал DimaTorzok Субтитры сделал DimaTorzok Субтитры сделал DimaTorzok Субтитры сделал DimaTorzok',
      ),
    ).toBe('Субтитры сделал DimaTorzok Субтитры сделал DimaTorzok');
  });

  it('leaves ordinary repetition in speech alone', () => {
    expect(collapseRepetitionLoops('да да конечно я вас понял хорошо')).toBe(
      'да да конечно я вас понял хорошо',
    );
  });

  it('leaves short text untouched', () => {
    expect(collapseRepetitionLoops('коротко и ясно')).toBe('коротко и ясно');
  });
});

describe('tidyPunctuation', () => {
  it('repairs spacing and sentence case broken at window seams', () => {
    expect(tidyPunctuation('привет ,как дела ?отлично.спасибо')).toBe(
      'Привет, как дела? Отлично. Спасибо',
    );
  });

  it('does not split decimals', () => {
    expect(tidyPunctuation('давление 2.5 бар')).toBe('Давление 2.5 бар');
  });
});

describe('finalizeTranscript', () => {
  it('cleans a seam and a loop in one pass', () => {
    expect(
      finalizeTranscript(joinOverlappingText('запишем задачу на завтра', 'на завтра ну ну ну ну ну и всё')),
    ).toBe('Запишем задачу на завтра ну ну и всё');
  });

  it('breaks a long dictation into paragraphs', () => {
    const dictation = Array.from({ length: 9 }, (_, i) => `Это предложение номер ${i + 1}.`).join(' ');
    expect(finalizeTranscript(dictation).split('\n\n')).toHaveLength(3);
  });
});
