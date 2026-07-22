/**
 * Text repair for conveyor output.
 *
 * Two problems are handled here that the model itself cannot solve:
 *
 * 1. Windows overlap on purpose, so the same speech is transcribed twice at
 *    every seam. Timestamped stitching drops the duplicate by time, but the
 *    plain-text path has no timestamps to work with and has to find the repeat
 *    in the words themselves.
 * 2. Whisper loops. Given silence, music or noise it will happily emit the same
 *    phrase until the window ends — for Russian audio it is often a stray
 *    subtitle credit. The reference implementation catches this with a
 *    compression-ratio threshold, which Transformers.js does not expose, so the
 *    equivalent guard lives here.
 */

/** Word tokens with punctuation stripped, for comparing what was *said*. */
function normalizeForCompare(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Joins two window transcripts, removing the passage the overlap made both of
 * them contain.
 *
 * Looks for the longest run of words that ends `previous` and starts `next`,
 * preferring longer matches so a single common word ("и", "the") cannot trigger
 * a bogus join. Returns a plain concatenation when nothing convincing overlaps —
 * losing a duplicated phrase is worse than keeping one.
 */
export function joinOverlappingText(previous: string, next: string, maxWords = 60): string {
  const previousTrimmed = previous.trim();
  const nextTrimmed = next.trim();
  if (!previousTrimmed) return nextTrimmed;
  if (!nextTrimmed) return previousTrimmed;

  const previousWords = previousTrimmed.split(/\s+/);
  const nextWords = nextTrimmed.split(/\s+/);
  const limit = Math.min(maxWords, previousWords.length, nextWords.length);

  // Two words are enough to be a real overlap ("на следующий"), but only when
  // they carry some substance — a bare "и в" would glue unrelated sentences
  // together, and a wrong join is worse than a surviving duplicate.
  const MIN_MATCH_WORDS = 2;
  const MIN_MATCH_CHARS = 8;

  for (let size = limit; size >= MIN_MATCH_WORDS; size -= 1) {
    const tail = normalizeForCompare(previousWords.slice(previousWords.length - size).join(' '));
    const head = normalizeForCompare(nextWords.slice(0, size).join(' '));
    if (tail.length !== head.length || tail.length === 0) continue;
    if (!tail.every((word, index) => word === head[index])) continue;
    if (size < 3 && tail.join('').length < MIN_MATCH_CHARS) continue;

    // Keep the *second* window's rendering of the shared words. It was decoded
    // with the following context, so its punctuation leads into what comes
    // next — the first window had to guess at an ending that was not there.
    const head0 = previousWords.slice(0, previousWords.length - size).join(' ');
    return head0 ? `${head0} ${nextTrimmed}`.trim() : nextTrimmed;
  }

  return `${previousTrimmed} ${nextTrimmed}`;
}

/**
 * Collapses a phrase repeated back to back.
 *
 * Only consecutive repeats are touched: real speech does repeat words, but it
 * does not repeat the same four-word phrase six times in a row. The threshold is
 * deliberately conservative — a wrongly deleted sentence is worse than a
 * surviving stutter.
 */
export function collapseRepetitionLoops(text: string, maxRepeats = 2): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 6) return text.trim();

  const output: string[] = [];
  let index = 0;

  while (index < words.length) {
    let collapsed = false;

    // Longer phrases first: "мама мыла раму" repeated should collapse as a
    // phrase, not as three separate word loops.
    for (let size = Math.min(8, Math.floor((words.length - index) / 2)); size >= 1; size -= 1) {
      const phrase = words.slice(index, index + size).map((w) => w.toLowerCase());
      let repeats = 1;
      while (
        index + size * (repeats + 1) <= words.length &&
        words
          .slice(index + size * repeats, index + size * (repeats + 1))
          .every((word, i) => word.toLowerCase() === phrase[i])
      ) {
        repeats += 1;
      }

      if (repeats > maxRepeats) {
        for (let keep = 0; keep < maxRepeats; keep += 1) {
          output.push(...words.slice(index + size * keep, index + size * (keep + 1)));
        }
        index += size * repeats;
        collapsed = true;
        break;
      }
    }

    if (!collapsed) {
      output.push(words[index]);
      index += 1;
    }
  }

  return output.join(' ');
}

/**
 * Cosmetic clean-up.
 *
 * Whisper already punctuates and capitalizes Russian reasonably well, so this
 * only repairs what window stitching breaks: doubled spaces, a space before
 * punctuation, a missing space after it, and a lower-case letter opening a
 * sentence.
 */
export function tidyPunctuation(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:…])/g, '$1')
    .replace(/([,.!?;:…])(?=[^\s\d.,!?;:…)\]»"'])/gu, '$1 ')
    .replace(/([.!?…]\s+)(\p{Ll})/gu, (_, prefix: string, letter: string) => prefix + letter.toUpperCase())
    .replace(/^\s*(\p{Ll})/u, (_, letter: string) => letter.toUpperCase())
    .trim();
}

/**
 * Groups sentences into paragraphs so a long dictation is readable instead of
 * arriving as one wall of text.
 */
export function paragraphize(text: string, sentencesPerParagraph = 4): string {
  const sentences = text
    .split(/(?<=[.!?…])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  if (sentences.length <= sentencesPerParagraph) return text.trim();

  const paragraphs: string[] = [];
  for (let i = 0; i < sentences.length; i += sentencesPerParagraph) {
    paragraphs.push(sentences.slice(i, i + sentencesPerParagraph).join(' '));
  }
  return paragraphs.join('\n\n');
}

/** The full clean-up applied to a finished transcript. */
export function finalizeTranscript(text: string, options?: { paragraphs?: boolean }): string {
  const cleaned = tidyPunctuation(collapseRepetitionLoops(text));
  return options?.paragraphs === false ? cleaned : paragraphize(cleaned);
}
